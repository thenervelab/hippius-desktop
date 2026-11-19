//! Move files and folders to another folder of the same drive.
//!
//! One command, `move_entries`, for both kinds of drive:
//!
//! - **Synced here**: an `fs::rename` inside the drive root, then one sync
//!   cycle. Like `rename_entry`, the engine's rename detection turns the
//!   local move into a server rename, so nothing is uploaded again. An
//!   EMPTY file has no content hash to match on, so it can still go up as
//!   a delete plus a fresh upload; the result is the same file.
//! - **Browsed** (not synced here): the move is stated to the server, see
//!   `remote_move`.
//!
//! The UI checks the same rules before it offers a move. It is not a
//! security boundary, so every rule is checked again here.

use super::pathops::ensure_within;
use super::rename::{resolve_rename_root, validate_new_name};
use super::synced_state::{FolderSettlement, folder_settlement, synced_paths_for_label};
use crate::error::{AppError, Result};
use hcfs_client::engine::runner::trigger_sync;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tracing::info;

/// What to do when the destination already holds an item of that name.
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClashChoice {
    /// Move nothing and report the clash, so the user can choose.
    #[default]
    Ask,
    /// Move it under a free name: "a.txt" becomes "a (1).txt".
    KeepBoth,
    /// Replace the file that is there. Files only, never folders.
    Replace,
    /// Leave this item where it is.
    Skip,
}

/// One item to move.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MoveItem {
    /// Drive-relative, `/`-separated (relative to the granted folder for a
    /// folder grant, as every remote IPC takes it).
    pub path: String,
    pub is_folder: bool,
    /// The name to give it at the destination. Unset keeps its own; Undo
    /// sets it so an item moved under "a (1).txt" comes back as itself.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub on_clash: ClashChoice,
}

/// A move request, used by the `move_entries` command.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MoveEntriesRequest {
    pub label: String,
    /// The drive is only browsed here, so the move happens on the server.
    #[serde(default)]
    pub remote: bool,
    /// Drive-relative folder to move into; empty for the drive's top level.
    pub destination: String,
    pub items: Vec<MoveItem>,
}

/// What happened to one item.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MoveStatus {
    Moved,
    Skipped,
    /// The name is taken and the item asked to be told (`ClashChoice::Ask`).
    Clash,
    Failed,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveItemResult {
    pub path: String,
    pub is_folder: bool,
    pub status: MoveStatus,
    /// Where it is now, in the same form as `path`.
    pub new_path: Option<String>,
    /// Why it failed, in words for the user.
    pub message: Option<String>,
    /// The name was taken by a FOLDER, so Replace is not on offer.
    pub clash_is_folder: bool,
    /// A file was replaced to make room, so Undo cannot put it back.
    pub replaced: bool,
}

impl MoveItemResult {
    pub(crate) fn failed(item: &MoveItem, message: impl Into<String>) -> Self {
        Self {
            path: item.path.clone(),
            is_folder: item.is_folder,
            status: MoveStatus::Failed,
            new_path: None,
            message: Some(message.into()),
            clash_is_folder: false,
            replaced: false,
        }
    }

    pub(crate) fn skipped(item: &MoveItem) -> Self {
        Self {
            status: MoveStatus::Skipped,
            message: None,
            ..Self::failed(item, "")
        }
    }

    pub(crate) fn clash(item: &MoveItem, clash_is_folder: bool) -> Self {
        Self {
            status: MoveStatus::Clash,
            message: None,
            clash_is_folder,
            ..Self::failed(item, "")
        }
    }

    pub(crate) fn moved(item: &MoveItem, new_path: String, replaced: bool) -> Self {
        Self {
            status: MoveStatus::Moved,
            new_path: Some(new_path),
            message: None,
            replaced,
            ..Self::failed(item, "")
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MoveEntriesResult {
    pub results: Vec<MoveItemResult>,
}

/// Most items one request may move. A selection is what the user can see
/// on screen, so this only bounds a request that did not come from the UI.
const MAX_ITEMS: usize = 10_000;

pub(crate) const INSIDE_ITSELF: &str = "A folder can't go inside itself";
pub(crate) const ALREADY_THERE: &str = "Already in this folder";
pub(crate) const NO_FOLDER_REPLACE: &str = "A folder can't be replaced";

/// A drive-relative path from the webview, checked and in one spelling.
///
/// Trailing slashes are dropped; everything else that could name somewhere
/// other than a plain path inside the drive is refused rather than
/// repaired: an absolute path, a Windows drive prefix, `.` or `..`, an
/// empty segment, a backslash, NUL. Empty means the drive's top level.
pub(crate) fn normalize_drive_path(raw: &str) -> Result<String> {
    let path = raw.trim_end_matches('/');
    let bad = || AppError::Validation(format!("\"{raw}\" is not a path inside this drive"));
    if path.is_empty() {
        return Ok(String::new());
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(bad());
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(bad());
    }
    if path.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return Err(bad());
    }
    Ok(path.to_string())
}

/// The folder a normalized path lives in; empty at the top level.
pub(crate) fn parent_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

/// The last segment of a normalized path.
pub(crate) fn basename_of(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

/// `folder/name`, or `name` at the top level.
pub(crate) fn join_path(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

/// Whether `path` is `folder` or lies under it. `Trip` holds `Trip/a`, not
/// `Trip Photos/a`.
pub(crate) fn is_same_or_inside(path: &str, folder: &str) -> bool {
    path == folder || path.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'))
}

/// Why `item` cannot move into `destination` at all, whatever is there.
pub(crate) fn move_problem(item_path: &str, is_folder: bool, target_name: &str, destination: &str) -> Option<&'static str> {
    if is_folder && is_same_or_inside(destination, item_path) {
        return Some(INSIDE_ITSELF);
    }
    if parent_of(item_path) == destination && basename_of(item_path) == target_name {
        return Some(ALREADY_THERE);
    }
    None
}

/// The first free "name (N)" for Keep both, with the number before a
/// file's extension: "a.txt" becomes "a (1).txt", a folder "a" becomes
/// "a (1)". A leading dot is not an extension (".env" becomes ".env (1)").
pub(crate) fn keep_both_name(name: &str, is_folder: bool, taken: impl Fn(&str) -> bool) -> Option<String> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if !is_folder && i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..=999).map(|n| format!("{stem} ({n}){ext}")).find(|candidate| !taken(candidate))
}

/// What is already at the destination under an item's name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Existing {
    File,
    Folder,
}

/// What to do with one item, decided before anything moves.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Go { name: String, replace: bool },
    Skip,
    Clash { is_folder: bool },
    Fail(&'static str),
}

/// Apply the item's clash choice to what is at the destination.
pub(crate) fn decide(name: &str, is_folder: bool, choice: ClashChoice, existing: Option<Existing>, taken: impl Fn(&str) -> bool) -> Decision {
    let Some(existing) = existing else {
        return Decision::Go {
            name: name.to_string(),
            replace: false,
        };
    };
    match choice {
        ClashChoice::Ask => Decision::Clash {
            is_folder: existing == Existing::Folder,
        },
        ClashChoice::Skip => Decision::Skip,
        ClashChoice::KeepBoth => match keep_both_name(name, is_folder, taken) {
            Some(name) => Decision::Go { name, replace: false },
            None => Decision::Fail("Too many items with this name are already there"),
        },
        // Replacing a folder would delete everything in it, and moving a
        // folder over a file is not a replace of like for like either.
        ClashChoice::Replace if is_folder || existing == Existing::Folder => Decision::Fail(NO_FOLDER_REPLACE),
        ClashChoice::Replace => Decision::Go {
            name: name.to_string(),
            replace: true,
        },
    }
}

/// Names claimed by earlier items of the same request, compared without
/// case: two items called "a.txt" from different folders must not both land
/// on one name, and on a case-insensitive disk "A.txt" is the same name.
#[derive(Default)]
pub(crate) struct Claimed(HashSet<String>);

impl Claimed {
    pub(crate) fn has(&self, name: &str) -> bool {
        self.0.contains(&name.to_lowercase())
    }
    pub(crate) fn claim(&mut self, name: &str) {
        self.0.insert(name.to_lowercase());
    }
    pub(crate) fn release(&mut self, name: &str) {
        self.0.remove(&name.to_lowercase());
    }
}

/// The checked target name for an item: its own, or the one Undo asked for.
pub(crate) fn target_name(item: &MoveItem, path: &str) -> Result<String> {
    match item.name.as_deref() {
        Some(name) => validate_new_name(name).map(str::to_string),
        None => Ok(basename_of(path).to_string()),
    }
}

/// What is on disk at `path`, without following a link.
async fn probe(path: &Path) -> Option<Existing> {
    let meta = tokio::fs::symlink_metadata(path).await.ok()?;
    Some(if meta.is_dir() { Existing::Folder } else { Existing::File })
}

/// The first Keep both name that is free on disk and not claimed by an
/// earlier item of the same request.
async fn free_keep_both_name(dest_abs: &Path, name: &str, is_folder: bool, claimed: &Claimed) -> Option<String> {
    let mut taken = HashSet::new();
    loop {
        let candidate = keep_both_name(name, is_folder, |c| taken.contains(c))?;
        if claimed.has(&candidate) || probe(&dest_abs.join(&candidate)).await.is_some() {
            taken.insert(candidate);
        } else {
            return Some(candidate);
        }
    }
}

/// Move `items` into `destination` inside the drive at `sync_root`.
///
/// Per item, never all or nothing: a selection where one file is mid-sync
/// still moves the rest, and the result says which did not and why.
async fn move_local(sync_root: &Path, items: &[MoveItem], destination: &str, synced_rel_paths: Option<&[String]>) -> Result<Vec<MoveItemResult>> {
    let root = tokio::fs::canonicalize(sync_root)
        .await
        .map_err(|_| AppError::NotFound("This drive's folder is not on this device".into()))?;
    let destination = normalize_drive_path(destination)?;
    // Canonical, so a destination reached through a link that leaves the
    // drive is refused here rather than written to.
    let dest_abs = if destination.is_empty() {
        root.clone()
    } else {
        ensure_within(&root, &root.join(&destination)).map_err(|_| AppError::NotFound("That folder is no longer in this drive".into()))?
    };
    if !dest_abs.is_dir() {
        return Err(AppError::NotFound("That folder is no longer in this drive".into()));
    }

    let mut claimed = Claimed::default();
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        results.push(move_one_local(&root, &dest_abs, &destination, item, synced_rel_paths, &mut claimed).await);
    }
    Ok(results)
}

async fn move_one_local(
    root: &Path,
    dest_abs: &Path,
    destination: &str,
    item: &MoveItem,
    synced_rel_paths: Option<&[String]>,
    claimed: &mut Claimed,
) -> MoveItemResult {
    let rel = match normalize_drive_path(&item.path) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return MoveItemResult::failed(item, "The drive itself can't be moved"),
        Err(e) => return MoveItemResult::failed(item, e.to_string()),
    };
    let name = match target_name(item, &rel) {
        Ok(name) => name,
        Err(e) => return MoveItemResult::failed(item, e.to_string()),
    };

    let lexical = root.join(&rel);
    let Ok(meta) = tokio::fs::symlink_metadata(&lexical).await else {
        return MoveItemResult::failed(item, "It's no longer here. Refresh and try again");
    };
    // A link would be moved as a link while the engine syncs what it points
    // at, so the two would disagree about what moved.
    if meta.file_type().is_symlink() {
        return MoveItemResult::failed(item, "Links can't be moved");
    }
    let is_folder = meta.is_dir();
    if let Some(problem) = move_problem(&rel, is_folder, &name, destination) {
        return MoveItemResult::failed(item, problem);
    }
    // Containment on the canonical path: an intermediate link that leaves
    // the drive is refused here.
    let src_abs = match ensure_within(root, &lexical) {
        Ok(p) if p != root => p,
        _ => return MoveItemResult::failed(item, "That isn't inside this drive"),
    };
    // The string check above misses a destination reached through a link
    // into the moved folder; the canonical paths cannot.
    if is_folder && dest_abs.starts_with(&src_abs) {
        return MoveItemResult::failed(item, INSIDE_ITSELF);
    }
    // Same rule as rename: a folder with changes still syncing moves later.
    if is_folder && matches!(folder_settlement(root, &rel, synced_rel_paths), FolderSettlement::Pending) {
        return MoveItemResult::failed(
            item,
            "This folder has changes that are still syncing. Wait for sync to finish, then try again",
        );
    }

    let new_abs: PathBuf = dest_abs.join(&name);
    let existing = if claimed.has(&name) {
        Some(Existing::File)
    } else {
        probe(&new_abs).await
    };
    // Probed ahead, since `decide` takes a plain predicate: every candidate
    // before the free one is taken.
    let free = if existing.is_some() && item.on_clash == ClashChoice::KeepBoth {
        free_keep_both_name(dest_abs, &name, is_folder, claimed).await
    } else {
        None
    };
    let decision = decide(&name, is_folder, item.on_clash, existing, |c| Some(c) != free.as_deref());

    let (final_name, replace) = match decision {
        Decision::Go { name, replace } => (name, replace),
        Decision::Skip => return MoveItemResult::skipped(item),
        Decision::Clash { is_folder } => return MoveItemResult::clash(item, is_folder),
        Decision::Fail(message) => return MoveItemResult::failed(item, message),
    };
    let final_abs = dest_abs.join(&final_name);
    // `rename` silently replaces a file that is there, so anything that is
    // not an explicit Replace checks once more right before it. The gap
    // between the two is the same one `rename_entry` accepts.
    if !replace && probe(&final_abs).await.is_some() {
        return MoveItemResult::clash(item, false);
    }
    if replace && probe(&final_abs).await != Some(Existing::File) {
        return MoveItemResult::failed(item, NO_FOLDER_REPLACE);
    }
    if let Err(e) = tokio::fs::rename(&src_abs, &final_abs).await {
        return MoveItemResult::failed(item, format!("Could not move it: {e}"));
    }
    claimed.claim(&final_name);
    MoveItemResult::moved(item, join_path(destination, &final_name), replace)
}

/// Move files and folders to another folder of the same drive.
///
/// A synced drive moves on disk and lets the sync engine carry it to the
/// server as a rename; a browsed drive moves on the server directly. Each
/// item reports its own outcome, so a partial move says what did not move.
#[tauri::command]
pub async fn move_entries(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    request: MoveEntriesRequest,
) -> Result<MoveEntriesResult> {
    let account_id = state.require_session_account(&account_id)?;
    if request.items.is_empty() {
        return Ok(MoveEntriesResult { results: Vec::new() });
    }
    if request.items.len() > MAX_ITEMS {
        return Err(AppError::Validation(format!("Move at most {MAX_ITEMS} items at a time")));
    }
    let pool = state.pool()?;

    if request.remote {
        let results = crate::sync::fileops::remote_move::move_in_remote_drive(
            state.inner(),
            pool,
            &account_id,
            &request.label,
            &request.destination,
            &request.items,
        )
        .await?;
        return Ok(MoveEntriesResult { results });
    }

    let label_to_path: HashMap<String, String> = crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "move_entries")
        .await
        .into_iter()
        .map(|sp| (sp.label, sp.path))
        .collect();
    // An explicitly named drive must exist; never the default drive instead.
    let (sync_path, guard_label) = resolve_rename_root(Some(&request.label), &label_to_path)?;
    let synced_rel_paths: Option<Vec<String>> = synced_paths_for_label(&state.sync, guard_label)
        .await
        .map(|m| m.keys().cloned().collect());

    let results = move_local(Path::new(&sync_path), &request.items, &request.destination, synced_rel_paths.as_deref()).await?;

    let moved = results.iter().filter(|r| r.status == MoveStatus::Moved).count();
    if moved > 0 {
        // One cycle for the whole move. No rename hint, for the reason
        // `rename_entry` gives: the watcher already produces one.
        let _ = trigger_sync(&state.sync).await;
    }
    info!(moved, total = results.len(), "Move completed");
    Ok(MoveEntriesResult { results })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(path: &str, is_folder: bool) -> MoveItem {
        MoveItem {
            path: path.to_string(),
            is_folder,
            name: None,
            on_clash: ClashChoice::Ask,
        }
    }

    fn with_choice(mut item: MoveItem, choice: ClashChoice) -> MoveItem {
        item.on_clash = choice;
        item
    }

    async fn write(root: &Path, rel: &str, body: &[u8]) {
        let path = root.join(rel);
        tokio::fs::create_dir_all(path.parent().unwrap()).await.unwrap();
        tokio::fs::write(path, body).await.unwrap();
    }

    #[test]
    fn normalize_drive_path_refuses_anything_that_leaves_the_drive() {
        assert_eq!(normalize_drive_path("").unwrap(), "");
        assert_eq!(normalize_drive_path("Docs/2024/").unwrap(), "Docs/2024");
        for bad in ["/etc", "../x", "a/../b", "a/./b", "a//b", "C:/x", "c:", "a\\b", "a\0b", "."] {
            assert!(
                matches!(normalize_drive_path(bad), Err(AppError::Validation(_))),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn path_helpers_split_on_the_last_segment() {
        assert_eq!(parent_of("a/b/c.txt"), "a/b");
        assert_eq!(parent_of("c.txt"), "");
        assert_eq!(basename_of("a/b/c.txt"), "c.txt");
        assert_eq!(join_path("", "c.txt"), "c.txt");
        assert_eq!(join_path("a", "c.txt"), "a/c.txt");
    }

    #[test]
    fn a_folder_cannot_go_inside_itself_but_a_lookalike_sibling_is_fine() {
        assert_eq!(move_problem("Trip", true, "Trip", "Trip"), Some(INSIDE_ITSELF));
        assert_eq!(move_problem("Trip", true, "Trip", "Trip/2024"), Some(INSIDE_ITSELF));
        assert_eq!(move_problem("Trip", true, "Trip", "Trip Photos"), None);
        // A file named like the destination's prefix is not a folder.
        assert_eq!(move_problem("Trip", false, "Trip", "Trip/2024"), None);
    }

    #[test]
    fn moving_into_the_current_folder_is_refused_unless_the_name_changes() {
        assert_eq!(move_problem("a/b.txt", false, "b.txt", "a"), Some(ALREADY_THERE));
        assert_eq!(move_problem("b.txt", false, "b.txt", ""), Some(ALREADY_THERE));
        assert_eq!(move_problem("a/b (1).txt", false, "b.txt", "a"), None);
    }

    #[test]
    fn keep_both_numbers_before_the_extension() {
        let taken = |c: &str| c == "a (1).txt";
        assert_eq!(keep_both_name("a.txt", false, taken).unwrap(), "a (2).txt");
        assert_eq!(keep_both_name("a.txt", false, |_| false).unwrap(), "a (1).txt");
        assert_eq!(keep_both_name("archive.tar.gz", false, |_| false).unwrap(), "archive.tar (1).gz");
        assert_eq!(keep_both_name(".env", false, |_| false).unwrap(), ".env (1)");
        // A folder's dot is part of its name.
        assert_eq!(keep_both_name("v1.2", true, |_| false).unwrap(), "v1.2 (1)");
        assert_eq!(keep_both_name("a", false, |_| true), None);
    }

    #[test]
    fn decide_never_replaces_a_folder() {
        let free = |_: &str| false;
        assert_eq!(
            decide("a", true, ClashChoice::Replace, Some(Existing::Folder), free),
            Decision::Fail(NO_FOLDER_REPLACE)
        );
        assert_eq!(
            decide("a", false, ClashChoice::Replace, Some(Existing::Folder), free),
            Decision::Fail(NO_FOLDER_REPLACE)
        );
        assert_eq!(
            decide("a", true, ClashChoice::Replace, Some(Existing::File), free),
            Decision::Fail(NO_FOLDER_REPLACE)
        );
        assert_eq!(
            decide("a", false, ClashChoice::Replace, Some(Existing::File), free),
            Decision::Go {
                name: "a".into(),
                replace: true
            }
        );
    }

    #[test]
    fn decide_asks_skips_or_renames_on_a_clash_and_goes_when_free() {
        let free = |_: &str| false;
        assert_eq!(
            decide("a.txt", false, ClashChoice::Ask, None, free),
            Decision::Go {
                name: "a.txt".into(),
                replace: false
            }
        );
        assert_eq!(
            decide("a.txt", false, ClashChoice::Ask, Some(Existing::Folder), free),
            Decision::Clash { is_folder: true }
        );
        assert_eq!(decide("a.txt", false, ClashChoice::Skip, Some(Existing::File), free), Decision::Skip);
        assert_eq!(
            decide("a.txt", false, ClashChoice::KeepBoth, Some(Existing::File), free),
            Decision::Go {
                name: "a (1).txt".into(),
                replace: false
            }
        );
    }

    #[tokio::test]
    async fn moves_files_and_folders_into_a_subfolder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "a.txt", b"a").await;
        write(root, "Trip/photo.jpg", b"p").await;
        tokio::fs::create_dir_all(root.join("Reports")).await.unwrap();

        let results = move_local(root, &[item("a.txt", false), item("Trip", true)], "Reports", None)
            .await
            .unwrap();

        assert!(results.iter().all(|r| r.status == MoveStatus::Moved), "{results:?}");
        assert_eq!(results[0].new_path.as_deref(), Some("Reports/a.txt"));
        assert_eq!(results[1].new_path.as_deref(), Some("Reports/Trip"));
        assert_eq!(tokio::fs::read(root.join("Reports/a.txt")).await.unwrap(), b"a");
        assert!(root.join("Reports/Trip/photo.jpg").exists());
        assert!(!root.join("a.txt").exists());
    }

    #[tokio::test]
    async fn moves_back_up_to_the_top_level() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "Reports/a.txt", b"a").await;

        let results = move_local(root, &[item("Reports/a.txt", false)], "", None).await.unwrap();

        assert_eq!(results[0].new_path.as_deref(), Some("a.txt"));
        assert!(root.join("a.txt").exists());
    }

    #[tokio::test]
    async fn a_clash_moves_nothing_until_the_user_chooses() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "a.txt", b"new").await;
        write(root, "Reports/a.txt", b"old").await;

        let asked = move_local(root, &[item("a.txt", false)], "Reports", None).await.unwrap();
        assert_eq!(asked[0].status, MoveStatus::Clash);
        assert_eq!(tokio::fs::read(root.join("Reports/a.txt")).await.unwrap(), b"old");
        assert!(root.join("a.txt").exists());

        let kept = move_local(root, &[with_choice(item("a.txt", false), ClashChoice::KeepBoth)], "Reports", None)
            .await
            .unwrap();
        assert_eq!(kept[0].new_path.as_deref(), Some("Reports/a (1).txt"));
        assert_eq!(tokio::fs::read(root.join("Reports/a (1).txt")).await.unwrap(), b"new");
        assert_eq!(tokio::fs::read(root.join("Reports/a.txt")).await.unwrap(), b"old");
    }

    #[tokio::test]
    async fn replace_overwrites_a_file_and_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "a.txt", b"new").await;
        write(root, "Reports/a.txt", b"old").await;

        let results = move_local(root, &[with_choice(item("a.txt", false), ClashChoice::Replace)], "Reports", None)
            .await
            .unwrap();

        assert_eq!(results[0].status, MoveStatus::Moved);
        assert!(results[0].replaced);
        assert_eq!(tokio::fs::read(root.join("Reports/a.txt")).await.unwrap(), b"new");
    }

    #[tokio::test]
    async fn replace_never_touches_a_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "Trip/a.txt", b"a").await;
        write(root, "Reports/Trip/keep.txt", b"k").await;

        let results = move_local(root, &[with_choice(item("Trip", true), ClashChoice::Replace)], "Reports", None)
            .await
            .unwrap();

        assert_eq!(results[0].status, MoveStatus::Failed);
        assert!(root.join("Reports/Trip/keep.txt").exists());
        assert!(root.join("Trip/a.txt").exists());
    }

    #[tokio::test]
    async fn skip_leaves_the_item_where_it_is() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "a.txt", b"new").await;
        write(root, "Reports/a.txt", b"old").await;

        let results = move_local(root, &[with_choice(item("a.txt", false), ClashChoice::Skip)], "Reports", None)
            .await
            .unwrap();

        assert_eq!(results[0].status, MoveStatus::Skipped);
        assert!(root.join("a.txt").exists());
    }

    #[tokio::test]
    async fn refuses_a_folder_into_itself_and_reports_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "Trip/2024/a.jpg", b"a").await;
        write(root, "b.txt", b"b").await;

        let results = move_local(root, &[item("Trip", true), item("b.txt", false)], "Trip/2024", None)
            .await
            .unwrap();

        assert_eq!(results[0].status, MoveStatus::Failed);
        assert_eq!(results[0].message.as_deref(), Some(INSIDE_ITSELF));
        assert_eq!(results[1].status, MoveStatus::Moved);
        assert!(root.join("Trip/2024/a.jpg").exists());
    }

    #[tokio::test]
    async fn two_items_with_one_name_do_not_overwrite_each_other() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "x/a.txt", b"1").await;
        write(root, "y/a.txt", b"2").await;
        tokio::fs::create_dir_all(root.join("Reports")).await.unwrap();

        let results = move_local(root, &[item("x/a.txt", false), item("y/a.txt", false)], "Reports", None)
            .await
            .unwrap();

        assert_eq!(results[0].status, MoveStatus::Moved);
        assert_eq!(results[1].status, MoveStatus::Clash);
        assert_eq!(tokio::fs::read(root.join("Reports/a.txt")).await.unwrap(), b"1");
        assert!(root.join("y/a.txt").exists());
    }

    #[tokio::test]
    async fn refuses_paths_that_leave_the_drive() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("drive");
        write(&root, "a.txt", b"a").await;
        write(tmp.path(), "outside/x.txt", b"x").await;

        assert!(move_local(&root, &[item("a.txt", false)], "../outside", None).await.is_err());
        let results = move_local(&root, &[item("../outside/x.txt", false)], "", None).await.unwrap();
        assert_eq!(results[0].status, MoveStatus::Failed);
        assert!(tmp.path().join("outside/x.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_a_destination_reached_through_a_link_out_of_the_drive() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("drive");
        write(&root, "a.txt", b"a").await;
        tokio::fs::create_dir_all(tmp.path().join("outside")).await.unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside"), root.join("escape")).unwrap();

        assert!(move_local(&root, &[item("a.txt", false)], "escape", None).await.is_err());
        let moved_link = move_local(&root, &[item("escape", true)], "", None).await.unwrap();
        assert_eq!(moved_link[0].status, MoveStatus::Failed);
        assert!(root.join("a.txt").exists());
    }

    #[tokio::test]
    async fn refuses_a_folder_that_is_still_syncing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "album/on-disk.jpg", b"j").await;
        tokio::fs::create_dir_all(root.join("Reports")).await.unwrap();
        let synced = vec!["album/on-disk.jpg".to_string(), "album/deleted-here.jpg".to_string()];

        let results = move_local(root, &[item("album", true)], "Reports", Some(&synced)).await.unwrap();

        assert_eq!(results[0].status, MoveStatus::Failed);
        assert!(root.join("album/on-disk.jpg").exists());
    }

    #[tokio::test]
    async fn undo_moves_an_item_back_under_its_own_name() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "Reports/a (1).txt", b"a").await;

        let mut back = item("Reports/a (1).txt", false);
        back.name = Some("a.txt".into());
        let results = move_local(root, &[back], "", None).await.unwrap();

        assert_eq!(results[0].new_path.as_deref(), Some("a.txt"));
        assert!(root.join("a.txt").exists());
    }

    #[tokio::test]
    async fn a_missing_item_fails_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "b.txt", b"b").await;
        tokio::fs::create_dir_all(root.join("Reports")).await.unwrap();

        let results = move_local(root, &[item("ghost.txt", false), item("b.txt", false)], "Reports", None)
            .await
            .unwrap();

        assert_eq!(results[0].status, MoveStatus::Failed);
        assert_eq!(results[1].status, MoveStatus::Moved);
    }
}
