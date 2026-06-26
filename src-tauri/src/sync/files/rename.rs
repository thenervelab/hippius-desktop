//! In-place file/folder rename inside a sync drive.

use super::pathops::{derive_relative_name, ensure_within};
use super::synced_state::synced_paths_for_label;
use crate::error::Result;
use hcfs_client::engine::runner::trigger_sync;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::info;

/// Request to rename a single file or folder, used by the `rename_entry` command.
///
/// Mirrors [`FileDeleteRequest`]: `name` is the drive-relative fallback
/// (`actualFileName || name` on the FE), `source` the absolute on-disk path
/// when known, `label` the drive the entry belongs to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameRequest {
    pub name: String,
    pub source: Option<String>,
    pub label: Option<String>,
    pub new_name: String,
}

/// Result of a rename: where the entry now lives, relative to its drive root.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntryResult {
    pub new_relative_path: String,
}

/// Validate a user-supplied replacement basename, returning it trimmed.
///
/// The separator/traversal rejection is the invariant the whole rename path
/// relies on: a basename that cannot contain `/`, `\`, NUL, or be `.`/`..`
/// cannot move the entry out of its parent directory, so the (not yet
/// existing) destination never needs its own canonicalize-and-contain check.
fn validate_new_name(new_name: &str) -> Result<&str> {
    let name = new_name.trim();
    if name.is_empty() {
        return Err(crate::error::AppError::Other("New name cannot be empty".into()));
    }
    // 255 bytes is the basename limit on APFS/ext4/NTFS; rejecting here gives
    // a clear message instead of an opaque OS error from `rename`.
    if name.len() > 255 {
        return Err(crate::error::AppError::Other("New name is too long (255 bytes max)".into()));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') || name == "." || name == ".." {
        return Err(crate::error::AppError::Other("New name cannot contain path separators".into()));
    }
    // Cross-platform safety: drives sync to Windows devices, where ':' is
    // the NTFS alternate-data-stream separator, a trailing dot is invalid,
    // and the DOS device names are reserved even with an extension
    // ("con.txt"). Rejecting here gives a friendly message now instead of
    // an opaque sync failure on another device later. Trailing spaces are
    // already gone via the trim above.
    if name.contains(':') || name.ends_with('.') {
        return Err(crate::error::AppError::Other("New name cannot contain ':' or end with '.'".into()));
    }
    const WINDOWS_RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
        "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        return Err(crate::error::AppError::Other("That name is reserved by the operating system".into()));
    }
    Ok(name)
}

/// Rename a file or directory in place inside `sync_root`.
///
/// `old_rel` is the entry's current drive-relative path; `new_name` must be a
/// pre-validated basename (see [`validate_new_name`]). `synced_rel_paths` is
/// the drive's last-synced relative-path set when available — used only for
/// the unsettled-folder guard below. Returns the new drive-relative path.
///
/// Two checks here are load-bearing:
///
/// - **Destination pre-check**: `std::fs::rename` silently REPLACES an
///   existing destination file on Unix, so without it a name collision would
///   clobber another synced file. A case-only rename ("file.txt" →
///   "File.txt") is told apart from a real clash by canonical-path equality —
///   on case-insensitive filesystems (macOS default) the "existing"
///   destination IS the source. The exists→rename window is a TOCTOU gap we
///   accept for a single-user desktop UI; the sync engine reconciles either
///   outcome on the next cycle.
/// - **Unsettled-folder guard**: `synced_rel_paths` holds the paths this
///   device finished syncing in a previous cycle (the engine's `synced`
///   tree). A synced path missing on disk means the folder has local
///   changes the server has not acknowledged yet — e.g. a child deleted
///   locally, awaiting remote-delete propagation — so the rename is refused
///   conservatively until a cycle settles it. NOTE: this deliberately does
///   NOT detect children uploaded from another device that were never
///   downloaded here; those are absent from the synced set, and after a
///   folder rename the next sync re-downloads them under the OLD folder
///   name — exactly what happens for a Finder rename today. Closing that
///   gap needs an engine-side accessor for server-known paths
///   (hcfs-client `state.remote`); tracked follow-up.
async fn rename_entry_inner(sync_root: &Path, old_rel: &str, new_name: &str, synced_rel_paths: Option<&[String]>) -> Result<String> {
    let old_abs = ensure_within(sync_root, &sync_root.join(old_rel))
        .map_err(|_| crate::error::AppError::Other("File is not available on this device yet — only locally synced files can be renamed".into()))?;

    let old_basename = old_abs.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    if old_rel.is_empty() || old_basename.is_empty() {
        return Err(crate::error::AppError::Other("Cannot rename the sync folder itself".into()));
    }
    if old_basename == new_name {
        return Err(crate::error::AppError::Other("New name is the same as the current name".into()));
    }

    if old_abs.is_dir()
        && let Some(rel_paths) = synced_rel_paths
    {
        let prefix = format!("{}/", old_rel.trim_end_matches('/'));
        for rel in rel_paths {
            if rel.starts_with(&prefix) && !sync_root.join(rel).exists() {
                return Err(crate::error::AppError::Other(
                    "This folder has changes that are still syncing on this device. Wait for sync to finish, then try again".into(),
                ));
            }
        }
    }

    // `parent()` is Some for any canonical path below the root we just
    // guarded against, but stay total rather than panic on the impossible.
    let parent_dir = old_abs
        .parent()
        .ok_or(crate::error::AppError::Other("Cannot rename the sync folder itself".into()))?;
    let new_abs = parent_dir.join(new_name);

    if tokio::fs::try_exists(&new_abs).await.unwrap_or(false) {
        let same_entry = tokio::fs::canonicalize(&new_abs).await.is_ok_and(|c| c == old_abs);
        if !same_entry {
            return Err(crate::error::AppError::Other(format!("\"{new_name}\" already exists in this folder")));
        }
    }

    tokio::fs::rename(&old_abs, &new_abs)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Rename failed: {e}")))?;

    // New rel path = old rel parent + new name, built from the caller's
    // `old_rel` rather than the canonical absolute path. NOTE: `Path::join`
    // appends with the OS separator, so on Windows a forward-slash `old_rel`
    // yields a backslash-joined final segment. The value is informational —
    // the FE displays nothing from it today — so this is acceptable.
    let new_rel = Path::new(old_rel)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map_or_else(|| PathBuf::from(new_name), |p| p.join(new_name))
        .to_string_lossy()
        .to_string();
    Ok(new_rel)
}

/// Resolve which drive root a rename runs in, and the label whose synced
/// state the unsettled-folder guard must consult.
///
/// An entry that names a label explicitly must rename in THAT drive: when
/// the label has no configured row this errors instead of falling back to
/// the default drive, where a same-named entry could silently be renamed
/// in its place (PR #15 review finding 3 — `delete_files` still carries the
/// old fallback; fixing it there is a joint follow-up). Only an entry with
/// no label at all uses the default drive.
fn resolve_rename_root<'a>(label: Option<&'a str>, label_to_path: &HashMap<String, String>) -> Result<(String, &'a str)> {
    match label {
        Some(l) => match label_to_path.get(l) {
            Some(p) => Ok((p.clone(), l)),
            None => Err(crate::error::AppError::Other(
                "This file's sync folder is no longer configured on this device".into(),
            )),
        },
        None => match label_to_path.get("default") {
            Some(p) => Ok((p.clone(), "default")),
            None => Err(crate::error::AppError::Other("No sync folder is configured for this file".into())),
        },
    }
}

/// Rename a file or folder inside a sync drive.
///
/// Resolves the drive root from `label` via [`resolve_rename_root`] (an
/// explicitly-named drive must exist — no silent default-drive fallback),
/// renames on disk, and triggers a sync cycle. The sync
/// engine's own rename detection propagates the change to the server as a
/// true rename (no re-upload): the hcfs-client file watcher captures the
/// `fs::rename` exactly as it would a Finder rename (Tier 1 hint), and the
/// content-hash fallback (Tier 2) covers a missed hint.
///
/// Deliberately does NOT call `SyncRunner::push_rename_hint`: the watcher
/// already produces a hint, and a duplicate would put two renames with the
/// same target into one batch — which hcfs-server's `validate_rename_batch`
/// rejects WHOLESALE, forcing every rename in the cycle into the
/// delete+re-upload fallback. Activity-log rewriting is likewise owned by
/// the watcher path (`apply_rename_to_activity`).
#[tauri::command]
pub async fn rename_entry(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    file: FileRenameRequest,
) -> Result<RenameEntryResult> {
    // Renames files under the account's drives; authorize against the session.
    let account_id = state.require_session_account(&account_id)?;
    let new_name = validate_new_name(&file.new_name)?.to_string();

    let pool = state.pool()?;
    let label_to_path: HashMap<String, String> = crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "rename_entry")
        .await
        .into_iter()
        .map(|sp| (sp.label, sp.path))
        .collect();
    // One resolution yields both the drive root and the guard label, so the
    // unsettled-folder guard below always queries the same drive it probes
    // paths against (PR #15 review finding 2).
    let (sync_path, guard_label) = resolve_rename_root(file.label.as_deref(), &label_to_path)?;

    let old_rel = derive_relative_name(&sync_path, file.source.as_deref(), &file.name);

    // Last-synced rel paths for the drive we actually resolved — feeds the
    // unsettled-folder guard in the inner helper. `None` (drive not loaded)
    // degrades to no guard; the disk rename is still valid, we just lose
    // the early warning.
    let synced_rel_paths: Option<Vec<String>> = synced_paths_for_label(&state.sync, guard_label)
        .await
        .map(|m| m.keys().cloned().collect());

    let new_rel = rename_entry_inner(Path::new(&sync_path), &old_rel, &new_name, synced_rel_paths.as_deref()).await?;

    // Trigger sync so the engine picks the rename up immediately instead of
    // waiting for the watcher debounce / periodic cycle.
    let _ = trigger_sync(&state.sync).await;

    info!(old = %old_rel, new = %new_rel, "Rename completed");
    Ok(RenameEntryResult { new_relative_path: new_rel })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn validate_new_name_trims_and_accepts_plain_names() {
        assert_eq!(validate_new_name("  notes.txt ").unwrap(), "notes.txt");
        assert_eq!(validate_new_name("üñïçødé 文件.pdf").unwrap(), "üñïçødé 文件.pdf");
    }

    #[test]
    fn validate_new_name_rejects_empty_traversal_and_separators() {
        for bad in ["", "   ", ".", "..", "a/b", "a\\b", "a\0b"] {
            assert!(validate_new_name(bad).is_err(), "{bad:?} should be rejected");
        }
        // Windows-unsafe shapes: ADS colon, trailing dot, DOS device names
        // (reserved even with an extension, case-insensitively).
        for bad in ["a:b", "name.", "CON", "con.txt", "Nul", "COM7", "lpt9.log"] {
            assert!(validate_new_name(bad).is_err(), "{bad:?} should be rejected");
        }
        // Near-misses of the reserved list must stay legal.
        for ok in ["console.txt", "common", "LPT10", "aux-cable.jpg"] {
            assert!(validate_new_name(ok).is_ok(), "{ok:?} should be accepted");
        }
        // 255 bytes is the boundary: a 255-byte name passes, 256 fails. Use a
        // multibyte char to pin "bytes, not chars" (é is 2 bytes in UTF-8).
        let ok = "é".repeat(127) + "a"; // 255 bytes
        assert_eq!(ok.len(), 255);
        assert!(validate_new_name(&ok).is_ok());
        let too_long = "é".repeat(128); // 256 bytes
        assert!(validate_new_name(&too_long).is_err());
    }

    proptest! {
        /// Any accepted name upholds the invariant `rename_entry_inner`
        /// relies on: it cannot navigate out of the parent directory.
        #[test]
        fn validate_new_name_accepted_names_are_plain_basenames(input in ".{0,300}") {
            if let Ok(name) = validate_new_name(&input) {
                prop_assert!(!name.is_empty());
                prop_assert!(name.len() <= 255);
                prop_assert!(!name.contains('/'));
                prop_assert!(!name.contains('\\'));
                prop_assert!(!name.contains('\0'));
                prop_assert!(!name.contains(':'));
                prop_assert!(!name.ends_with('.'));
                prop_assert!(name != "." && name != "..");
                // Trimming is idempotent: a returned name re-validates to itself.
                prop_assert_eq!(validate_new_name(name).unwrap(), name);
            }
        }
    }

    /// Cross-boundary drift pin: the accept/reject VERDICT of `validate_new_name`
    /// must agree with the FE `getRenameValidationError` (which returns `null`
    /// iff it accepts) on a SHARED fixture. The same JSON drives the vitest test
    /// `app/lib/__tests__/crossBoundaryContract.test.ts`, so a change to either
    /// side's rule SET fails its own CI job. We pin the verdict, not the message —
    /// the two validators word their errors differently and check in a different
    /// order by design; only "accept ⇔ accept" is the contract. The fixture
    /// probes the documented edges (axiom 110): the 255-BYTE limit on both ASCII
    /// and multibyte input (pins UTF-8-byte counting, not UTF-16 length), the
    /// exact-stem reserved check (`con` rejected, `context` accepted), NUL, and
    /// the Windows-unsafe `:`/trailing-dot shapes.
    #[test]
    fn validate_new_name_verdict_matches_shared_fixture() {
        #[derive(serde::Deserialize)]
        struct NameCase {
            input: String,
            valid: bool,
            note: String,
        }
        let cases: Vec<NameCase> = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/name_validation_cases.json")))
            .expect("name_validation_cases.json is valid JSON");
        assert!(!cases.is_empty(), "fixture must carry cases");
        for case in &cases {
            assert_eq!(validate_new_name(&case.input).is_ok(), case.valid, "validate_new_name({:?}).is_ok() — {}", case.input, case.note);
        }
    }

    #[test]
    fn resolve_rename_root_requires_named_label_to_exist() {
        let mut map = HashMap::new();
        map.insert("default".to_string(), "/drives/default".to_string());
        map.insert("photos".to_string(), "/drives/photos".to_string());

        // Named label present → that drive, and the guard label matches it.
        let (path, guard) = resolve_rename_root(Some("photos"), &map).unwrap();
        assert_eq!((path.as_str(), guard), ("/drives/photos", "photos"));

        // Named label missing → error, NOT a silent default-drive fallback
        // (a same-named entry in the default drive must never be renamed).
        let err = resolve_rename_root(Some("gone"), &map).unwrap_err();
        assert!(err.to_string().contains("no longer configured"), "got: {err}");

        // No label at all → the default drive, when configured.
        let (path, guard) = resolve_rename_root(None, &map).unwrap();
        assert_eq!((path.as_str(), guard), ("/drives/default", "default"));

        let empty: HashMap<String, String> = HashMap::new();
        assert!(resolve_rename_root(None, &empty).is_err());
    }

    #[tokio::test]
    async fn rename_entry_inner_renames_file_and_returns_new_rel_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::create_dir_all(root.join("docs")).await.unwrap();
        tokio::fs::write(root.join("docs/a.txt"), b"hello").await.unwrap();

        let new_rel = rename_entry_inner(root, "docs/a.txt", "b.txt", None).await.unwrap();

        assert_eq!(new_rel, "docs/b.txt");
        assert!(!root.join("docs/a.txt").exists());
        assert_eq!(tokio::fs::read(root.join("docs/b.txt")).await.unwrap(), b"hello");
    }

    #[tokio::test]
    async fn rename_entry_inner_renames_top_level_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::create_dir_all(root.join("old-folder")).await.unwrap();
        tokio::fs::write(root.join("old-folder/x.txt"), b"x").await.unwrap();

        let new_rel = rename_entry_inner(root, "old-folder", "new-folder", None).await.unwrap();

        assert_eq!(new_rel, "new-folder");
        assert!(root.join("new-folder/x.txt").exists());
        assert!(!root.join("old-folder").exists());
    }

    #[tokio::test]
    async fn rename_entry_inner_rejects_missing_source() {
        let tmp = tempfile::tempdir().unwrap();
        let err = rename_entry_inner(tmp.path(), "ghost.txt", "real.txt", None).await.unwrap_err();
        assert!(err.to_string().contains("not available on this device"), "got: {err}");
    }

    #[tokio::test]
    async fn rename_entry_inner_rejects_existing_destination_without_clobbering() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::write(root.join("a.txt"), b"a").await.unwrap();
        tokio::fs::write(root.join("b.txt"), b"b").await.unwrap();

        let err = rename_entry_inner(root, "a.txt", "b.txt", None).await.unwrap_err();

        assert!(err.to_string().contains("already exists"), "got: {err}");
        // The pre-check exists because fs::rename would otherwise silently
        // replace b.txt on Unix — both files must survive intact.
        assert_eq!(tokio::fs::read(root.join("a.txt")).await.unwrap(), b"a");
        assert_eq!(tokio::fs::read(root.join("b.txt")).await.unwrap(), b"b");
    }

    #[tokio::test]
    async fn rename_entry_inner_allows_case_only_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::write(root.join("report.txt"), b"r").await.unwrap();

        // On a case-insensitive filesystem (macOS default) the destination
        // "exists" — the same-entry canonical check must let this through.
        // On a case-sensitive filesystem the destination is simply absent.
        // Either way the rename succeeds.
        let new_rel = rename_entry_inner(root, "report.txt", "Report.txt", None).await.unwrap();

        assert_eq!(new_rel, "Report.txt");
        assert_eq!(tokio::fs::read(root.join("Report.txt")).await.unwrap(), b"r");
    }

    #[tokio::test]
    async fn rename_entry_inner_rejects_same_name_and_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::write(root.join("a.txt"), b"a").await.unwrap();

        let same = rename_entry_inner(root, "a.txt", "a.txt", None).await.unwrap_err();
        assert!(same.to_string().contains("same as the current name"), "got: {same}");

        let root_rename = rename_entry_inner(root, "", "new-root", None).await.unwrap_err();
        assert!(root_rename.to_string().contains("sync folder itself"), "got: {root_rename}");
    }

    #[tokio::test]
    async fn rename_entry_inner_folder_blocks_when_synced_children_missing_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::create_dir_all(root.join("album")).await.unwrap();
        tokio::fs::write(root.join("album/on-disk.jpg"), b"j").await.unwrap();

        // A previously-synced child is missing on disk (e.g. deleted
        // locally, remote-delete not yet propagated): the folder is in an
        // unsettled sync state, so the rename is refused conservatively.
        let synced_paths = vec!["album/on-disk.jpg".to_string(), "album/locally-deleted.jpg".to_string()];
        let err = rename_entry_inner(root, "album", "holiday", Some(&synced_paths)).await.unwrap_err();
        assert!(err.to_string().contains("still syncing"), "got: {err}");
        assert!(root.join("album").exists());

        // Every synced child present on disk → folder is settled → proceed.
        tokio::fs::write(root.join("album/locally-deleted.jpg"), b"j").await.unwrap();
        let new_rel = rename_entry_inner(root, "album", "holiday", Some(&synced_paths)).await.unwrap();
        assert_eq!(new_rel, "holiday");
        assert!(root.join("holiday/on-disk.jpg").exists());
    }

    #[tokio::test]
    async fn rename_entry_inner_unsettled_guard_ignores_sibling_prefix_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::create_dir_all(root.join("docs")).await.unwrap();
        tokio::fs::write(root.join("docs/a.txt"), b"a").await.unwrap();

        // "docs2/…" shares the "docs" string prefix but is a sibling — the
        // guard's trailing-`/` normalization must not match it.
        let synced_paths = vec!["docs/a.txt".to_string(), "docs2/not-here.txt".to_string()];
        let new_rel = rename_entry_inner(root, "docs", "papers", Some(&synced_paths)).await.unwrap();
        assert_eq!(new_rel, "papers");
    }
}
