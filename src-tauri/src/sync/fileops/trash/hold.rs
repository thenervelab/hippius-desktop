//! The local side of Move to Trash: the hold folder that makes Undo cheap,
//! and the journal that lets a large folder's trash resume.
//!
//! A trashed item leaves the synced folder by a `rename` into
//! `<root>/.hippius-trash-hold/<token>/<its path>`, on the same disk, so it
//! is instant whatever its size. hcfs's scan skips every `.` name
//! (`drive::exclude::should_skip_path`) and the desktop's listings skip
//! `.hippius*` names (`pathops::is_internal_hidden_name`), so the held copy
//! is invisible to both. The engine sees the item gone locally and, since
//! the server already trashed it, gone remotely too: "both deleted",
//! nothing to send.
//!
//! Undo restores the item on the server and renames the held copy back,
//! so the engine sees "both created, same content" and downloads nothing.
//! A hold is dropped when its Undo toast closes, and any hold older than
//! [`STALE_AFTER`] is swept the next time something is trashed in that
//! drive (the app may have quit while a toast was up). The item itself is
//! safe in Hippius Trash either way; a hold is only a local shortcut.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The hold folder at the top of a drive's folder.
pub const HOLD_DIR: &str = ".hippius-trash-hold";
/// The resumable-folder journal inside the hold folder.
const JOURNAL: &str = "jobs.json";
/// A hold no toast can still undo.
pub const STALE_AFTER: Duration = Duration::from_hours(1);

/// A new hold token: its creation time first, so a sweep can age it
/// without reading anything else.
pub fn new_token(now_millis: u128) -> String {
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{now_millis}-{}", &random[..12])
}

fn token_age_millis(token: &str) -> Option<u128> {
    token.split_once('-').and_then(|(millis, _)| millis.parse().ok())
}

/// Whether `token` is one [`new_token`] could have made: never a path.
pub fn is_token(token: &str) -> bool {
    token_age_millis(token).is_some() && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn token_dir(root: &Path, token: &str) -> PathBuf {
    root.join(HOLD_DIR).join(token)
}

/// Move `root/rel` into the hold for `token`. Returns where it went.
pub fn hold(root: &Path, rel: &str, token: &str) -> std::io::Result<PathBuf> {
    let source = root.join(rel);
    let held = token_dir(root, token).join(rel);
    if let Some(parent) = held.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&source, &held)?;
    Ok(held)
}

/// Put a held item back at `root/rel`. False when something else holds
/// that path now: the held copy is never put over it.
pub fn put_back(root: &Path, rel: &str, held: &Path) -> std::io::Result<bool> {
    let target = root.join(rel);
    if target.symlink_metadata().is_ok() {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(held, &target)?;
    Ok(true)
}

/// Drop a hold and, when it was the last, the hold folder.
pub fn release(root: &Path, token: &str) {
    if !is_token(token) {
        return;
    }
    let dir = token_dir(root, token);
    if dir.exists()
        && let Err(e) = std::fs::remove_dir_all(&dir)
    {
        tracing::debug!(error = %e, "trash: a hold could not be removed");
    }
    remove_hold_dir_if_empty(root);
}

fn remove_hold_dir_if_empty(root: &Path) {
    // `remove_dir` fails on a non-empty folder, which is the check.
    let _ = std::fs::remove_dir(root.join(HOLD_DIR));
}

/// Drop every hold in this drive older than [`STALE_AFTER`].
pub fn sweep_stale(root: &Path, now_millis: u128) -> usize {
    let Ok(entries) = std::fs::read_dir(root.join(HOLD_DIR)) else {
        return 0;
    };
    let mut swept = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(made) = token_age_millis(&name) else { continue };
        if now_millis.saturating_sub(made) > STALE_AFTER.as_millis() {
            release(root, &name);
            swept += 1;
        }
    }
    remove_hold_dir_if_empty(root);
    swept
}

fn read_journal(root: &Path) -> BTreeMap<String, String> {
    std::fs::read(root.join(HOLD_DIR).join(JOURNAL))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_journal(root: &Path, journal: &BTreeMap<String, String>) -> std::io::Result<()> {
    let dir = root.join(HOLD_DIR);
    if journal.is_empty() {
        let _ = std::fs::remove_file(dir.join(JOURNAL));
        remove_hold_dir_if_empty(root);
        return Ok(());
    }
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{JOURNAL}.part"));
    std::fs::write(&tmp, serde_json::to_vec(journal).unwrap_or_default())?;
    std::fs::rename(tmp, dir.join(JOURNAL))
}

/// The Trash item a folder's earlier, unfinished trash started, so trashing
/// it again continues that item instead of starting a second one.
pub fn resumed_item(root: &Path, folder: &str) -> Option<String> {
    read_journal(root).remove(folder)
}

/// Record that `folder`'s trash has started as `item_id`, before the next
/// batch is sent: if the app stops part way, trashing the folder again
/// resumes into the same item.
pub fn remember_item(root: &Path, folder: &str, item_id: &str) -> std::io::Result<()> {
    let mut journal = read_journal(root);
    if journal.get(folder).map(String::as_str) == Some(item_id) {
        return Ok(());
    }
    journal.insert(folder.to_string(), item_id.to_string());
    write_journal(root, &journal)
}

/// The folder's trash finished: nothing to resume.
pub fn forget_item(root: &Path, folder: &str) {
    let mut journal = read_journal(root);
    if journal.remove(folder).is_some()
        && let Err(e) = write_journal(root, &journal)
    {
        tracing::debug!(error = %e, "trash: the resume journal could not be updated");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_file_leaves_the_folder_and_comes_back_whole() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("Docs")).unwrap();
        std::fs::write(root.path().join("Docs/a.txt"), "hello").unwrap();
        let token = new_token(1_000);

        let held = hold(root.path(), "Docs/a.txt", &token).unwrap();
        assert!(!root.path().join("Docs/a.txt").exists());
        assert!(held.starts_with(root.path().join(HOLD_DIR)), "the hold stays inside the drive folder");
        assert!(
            crate::sync::files::pathops::is_engine_hidden_name(std::ffi::OsStr::new(HOLD_DIR)),
            "the engine never scans the hold"
        );

        assert!(put_back(root.path(), "Docs/a.txt", &held).unwrap());
        assert_eq!(std::fs::read_to_string(root.path().join("Docs/a.txt")).unwrap(), "hello");
        release(root.path(), &token);
        assert!(!root.path().join(HOLD_DIR).exists(), "an empty hold folder is removed");
    }

    #[test]
    fn a_whole_folder_is_held_by_one_rename() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("Trip/day1")).unwrap();
        std::fs::write(root.path().join("Trip/day1/p.jpg"), "p").unwrap();
        let held = hold(root.path(), "Trip", "5-abc").unwrap();
        assert!(held.join("day1/p.jpg").exists());
        assert!(!root.path().join("Trip").exists());
    }

    #[test]
    fn put_back_never_overwrites_a_new_item_at_the_path() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), "old").unwrap();
        let held = hold(root.path(), "a.txt", "5-abc").unwrap();
        std::fs::write(root.path().join("a.txt"), "new").unwrap();
        assert!(!put_back(root.path(), "a.txt", &held).unwrap());
        assert_eq!(std::fs::read_to_string(root.path().join("a.txt")).unwrap(), "new");
        assert!(held.exists(), "the held copy is kept for the caller to decide");
    }

    #[test]
    fn only_stale_holds_are_swept() {
        let root = tempfile::tempdir().unwrap();
        for name in ["old.txt", "new.txt"] {
            std::fs::write(root.path().join(name), "x").unwrap();
        }
        let hour = STALE_AFTER.as_millis();
        hold(root.path(), "old.txt", &new_token(1_000)).unwrap();
        let fresh = new_token(1_000 + hour + 500);
        hold(root.path(), "new.txt", &fresh).unwrap();
        assert_eq!(sweep_stale(root.path(), 1_000 + hour + 1_000), 1);
        assert!(root.path().join(HOLD_DIR).join(&fresh).exists());
    }

    #[test]
    fn release_ignores_anything_that_is_not_a_token() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(HOLD_DIR)).unwrap();
        std::fs::write(root.path().join("keep.txt"), "x").unwrap();
        release(root.path(), "../keep.txt");
        release(root.path(), "");
        assert!(root.path().join("keep.txt").exists());
        assert!(is_token(&new_token(42)));
        assert!(!is_token("12-../../x"));
    }

    #[test]
    fn the_journal_resumes_a_folder_until_it_is_forgotten() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(resumed_item(root.path(), "Big"), None);
        remember_item(root.path(), "Big", "item-1").unwrap();
        remember_item(root.path(), "Other", "item-2").unwrap();
        assert_eq!(resumed_item(root.path(), "Big").as_deref(), Some("item-1"));
        forget_item(root.path(), "Big");
        assert_eq!(resumed_item(root.path(), "Big"), None);
        assert_eq!(resumed_item(root.path(), "Other").as_deref(), Some("item-2"));
        forget_item(root.path(), "Other");
        assert!(!root.path().join(HOLD_DIR).exists());
    }
}
