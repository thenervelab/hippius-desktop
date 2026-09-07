//! Batch file/folder deletion.

use super::pathops::{derive_relative_name, ensure_within};
use crate::error::Result;
use hcfs_client::engine::runner::trigger_sync;
use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;
use tracing::{info, warn};

/// Request to delete a single file, used by the `delete_files` batch command.
#[derive(Deserialize)]
pub struct FileDeleteRequest {
    pub name: String,
    pub source: Option<String>,
    pub label: Option<String>,
    pub size: u64,
}

/// Per-file error from a batch delete.
#[derive(Serialize)]
pub struct FileDeleteError {
    pub name: String,
    pub error: String,
}

/// Result of a batch file deletion.
#[derive(Serialize)]
pub struct DeleteFilesResult {
    pub deleted: u32,
    pub failed: Vec<FileDeleteError>,
}

/// Delete multiple files in one call, resolving paths internally.
///
/// For each file: resolves sync_path + relative_name via label/source,
/// calls the existing `remove_file` logic, and aggregates results.
/// Triggers sync once at the end. Replaces the per-file loop that was
/// in `use-delete-file/index.tsx`.
#[tauri::command]
pub async fn delete_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: AppHandle,
    account_id: String,
    files: Vec<FileDeleteRequest>,
) -> Result<DeleteFilesResult> {
    // Deletes files under the account's drives; authorize against the session.
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    // Resolve every drive's label→path ONCE (a single query) instead of one
    // (often two, via the default fallback) SELECT per file in the batch.
    let label_to_path: std::collections::HashMap<String, String> =
        crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "delete_files")
            .await
            .into_iter()
            .map(|sp| (sp.label, sp.path))
            .collect();
    let default_path = label_to_path.get("default").cloned();

    let mut deleted = 0u32;
    let mut failed = Vec::new();
    // Drive labels whose on-disk DIRECTORY tree changed in this batch. Folder
    // entities are a side-channel the file sync plan doesn't model, so they need
    // their own reconcile trigger (see `folder_entity_sync_labels`).
    let mut dirs_removed_for: Vec<Option<String>> = Vec::new();

    for file in &files {
        // Resolve the drive root. An explicitly-named label MUST exist — never
        // fall back to the default drive (audit H-3: under the old fallback a
        // delete aimed at a removed/renamed drive retargeted the default drive
        // and `remove_dir_all` recursively deleted a same-named entry there).
        // Mirrors `resolve_rename_root`; only a label-less entry uses default.
        let resolved = match file.label.as_deref() {
            Some(l) => label_to_path.get(l).cloned(),
            None => default_path.clone(),
        };
        let Some(sync_path) = resolved else {
            let error = if file.label.is_some() {
                "This file's sync folder is no longer configured on this device"
            } else {
                "No sync folder is configured for this file"
            };
            failed.push(FileDeleteError {
                name: file.name.clone(),
                error: error.into(),
            });
            continue;
        };

        let relative_name = derive_relative_name(&sync_path, file.source.as_deref(), &file.name);

        match remove_and_invalidate(Path::new(&sync_path), &relative_name).await {
            Ok((kind, size_bytes)) => {
                if kind == RemovedKind::Directory {
                    dirs_removed_for.push(file.label.clone());
                }
                if let Some(lbl) = &file.label {
                    state.sync.update_state(lbl, |st| {
                        st.add_activity(SyncActivityItem {
                            file_name: std::sync::Arc::from(relative_name.as_str()),
                            action: SyncActivityAction::Deleted,
                            timestamp: chrono::Utc::now().timestamp(),
                            size_bytes,
                            label: std::sync::Arc::from(lbl.as_str()),
                        });
                    });
                }
                deleted += 1;
            }
            Err(e) => {
                warn!(file = %file.name, error = %e, "Failed to delete file");
                failed.push(FileDeleteError {
                    name: file.name.clone(),
                    error: e.to_string(),
                });
            }
        }
    }

    // Trigger sync so server picks up the deletions
    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>().sync.clone();
        let _ = trigger_sync(&s).await;
    }

    // Deleting a DIRECTORY also drops folder entities, which the file sync plan
    // does not model: a folder with no file content to propagate ends the
    // triggered cycle `NoChanges`, hcfs-client emits no `SyncCompleted`, and the
    // routine per-cycle reconcile — the only thing that unregisters the folder
    // server-side and evicts its `folder_entries_local` row — never runs. Until
    // it does, the deleted folder keeps coming back in `list_sync_folder_grouped`
    // via the cache overlay. Force the reconcile here instead of waiting for a
    // cycle that may never complete. Fire-and-forget: a failed run is retried by
    // the next eligible cycle, so it must not fail the user's delete.
    for label in folder_entity_sync_labels(&dirs_removed_for) {
        crate::sync::folder_entries_materialize::spawn_folder_entity_sync(
            app.clone(),
            account_id.clone(),
            label,
            crate::sync::folder_entries_materialize::FolderEntitySyncTrigger::Forced,
        );
    }

    info!(deleted, failed = failed.len(), "Batch delete completed");
    Ok(DeleteFilesResult { deleted, failed })
}

/// What a single delete actually removed.
///
/// The caller needs the distinction because a removed DIRECTORY additionally
/// invalidates the drive's folder-entity set, while a removed file does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemovedKind {
    Directory,
    File,
    /// Already gone — treated as success (delete is idempotent).
    Missing,
}

/// Resolve `relative_name` under `sync_root`, remove it, and drop the cached
/// folder totals the removal makes stale.
///
/// The removal itself uses the CANONICALIZED path `ensure_within` returns —
/// that is the containment check. The cache invalidation deliberately uses the
/// unresolved `sync_root.join(relative_name)` instead: `list_sync_folder` keys
/// the stats cache by the drive path exactly as stored in the DB, so on macOS
/// the canonical `/private/var/…` form would miss every row a `/var/…` listing
/// wrote and the folder size would stay stale anyway.
///
/// Keeping resolve + remove + invalidate in one function is what makes the
/// wiring testable; `delete_files` itself needs a live `AppState`.
async fn remove_and_invalidate(sync_root: &Path, relative_name: &str) -> Result<(RemovedKind, u64)> {
    let target = sync_root.join(relative_name);
    let resolved = ensure_within(sync_root, &target)?;
    let removed = remove_entry(&resolved).await.map_err(crate::error::AppError::Io)?;

    super::dir_stats::invalidate_dir_stats_for_change(sync_root, &target);
    Ok(removed)
}

/// Remove one resolved target, reporting what it was and, for a file, how many
/// bytes it held (for the sync activity entry).
///
/// Both probes — "is this a directory?" and the file's size — happen BEFORE the
/// removal, because afterwards the path no longer exists: `is_dir()` would
/// answer `false` for the directory just deleted, silently dropping the
/// folder-entity reconcile the caller owes for it, and `metadata()` would fail.
/// Keeping the order in one function is what makes that invariant testable.
async fn remove_entry(target: &Path) -> std::io::Result<(RemovedKind, u64)> {
    if target.is_dir() {
        tokio::fs::remove_dir_all(target).await?;
        return Ok((RemovedKind::Directory, 0));
    }
    if target.exists() {
        let size_bytes = tokio::fs::metadata(target).await.map_or(0, |m| m.len());
        tokio::fs::remove_file(target).await?;
        return Ok((RemovedKind::File, size_bytes));
    }
    Ok((RemovedKind::Missing, 0))
}

/// Resolve the drive labels needing a forced folder-entity reconcile from the
/// per-request labels of the directories this batch removed.
///
/// A label-less request targets the `default` drive — the same fallback the
/// delete loop's root resolution uses, so the reconcile is aimed at the drive
/// the directory was actually removed from. Returns a deduped, ordered set so a
/// batch deleting ten folders from one drive spawns ONE reconcile, not ten.
fn folder_entity_sync_labels(dirs_removed_for: &[Option<String>]) -> std::collections::BTreeSet<String> {
    dirs_removed_for
        .iter()
        .map(|label| label.clone().unwrap_or_else(|| DEFAULT_DRIVE_LABEL.to_string()))
        .collect()
}

/// Label of the implicit drive a label-less request resolves to.
const DEFAULT_DRIVE_LABEL: &str = "default";

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this guards: classifying the target AFTER `remove_dir_all`
    /// reports `File`/`Missing` for a directory, so `delete_files` never queues
    /// the folder-entity reconcile and the deleted folder lives on server-side.
    #[tokio::test]
    async fn removing_a_directory_reports_directory() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let target = dir.path().join("Nested");
        std::fs::create_dir(&target).expect("create dir");
        std::fs::write(target.join("child.txt"), b"data").expect("write child");

        let (kind, size) = remove_entry(&target).await.expect("remove");
        assert_eq!(kind, RemovedKind::Directory);
        assert_eq!(size, 0, "directory sizes are not reported as transferred bytes");
        assert!(!target.exists(), "a non-empty directory is removed recursively");
    }

    #[tokio::test]
    async fn removing_a_file_reports_its_size() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"hello").expect("write");

        let (kind, size) = remove_entry(&target).await.expect("remove");
        assert_eq!(kind, RemovedKind::File);
        assert_eq!(size, 5, "the size is read before the file is unlinked");
        assert!(!target.exists());
    }

    /// Delete is idempotent: an entry the sync engine already removed must not
    /// fail the batch, and must not be mistaken for a directory.
    #[tokio::test]
    async fn removing_an_absent_entry_succeeds_as_missing() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let (kind, size) = remove_entry(&dir.path().join("gone.txt")).await.expect("remove");
        assert_eq!(kind, RemovedKind::Missing);
        assert_eq!(size, 0);
    }

    #[test]
    fn no_directory_deletes_means_no_reconcile() {
        assert!(folder_entity_sync_labels(&[]).is_empty());
    }

    #[test]
    fn labels_are_deduped_so_one_batch_spawns_one_reconcile_per_drive() {
        let labels = folder_entity_sync_labels(&[Some("docs".to_string()), Some("docs".to_string()), Some("photos".to_string())]);
        assert_eq!(labels, ["docs".to_string(), "photos".to_string()].into_iter().collect());
    }

    #[test]
    fn label_less_requests_reconcile_the_default_drive() {
        // Mirrors the loop's root resolution: no label ⇒ the `default` drive.
        // Aiming the reconcile anywhere else would leave the stale folder entity
        // on the drive the directory actually came from.
        let labels = folder_entity_sync_labels(&[None, Some("docs".to_string()), None]);
        assert_eq!(labels, ["default".to_string(), "docs".to_string()].into_iter().collect());
    }

    /// Static wiring guard, mirroring the completion-funnel pin in
    /// `folder_entries_reconcile`: the delete command must keep spawning the
    /// forced folder-entity sync. Without it, deleting an empty folder is never
    /// propagated to the server and the row survives in the listing overlay.
    #[test]
    fn delete_files_spawns_a_forced_folder_entity_sync() {
        let src = include_str!("delete.rs");
        assert!(
            src.contains("spawn_folder_entity_sync"),
            "delete_files must trigger the folder-entity reconcile after removing a directory"
        );
        assert!(
            src.contains("FolderEntitySyncTrigger::Forced"),
            "the delete-triggered reconcile must bypass the interval throttle; a routine trigger can be skipped for 30s and the deleting cycle may never complete"
        );
    }

    /// H-068. A parent directory's mtime does not move when a descendant two
    /// levels down is deleted, so the drive root keeps serving its pre-delete
    /// total until the delete path drops the ancestor rows itself.
    ///
    /// The assertion is on the SIZE the next listing would report, not on the
    /// presence of a call: reverting the invalidation, or narrowing it to the
    /// immediate parent, both leave this at the stale 9 B.
    #[tokio::test]
    async fn deleting_a_file_two_levels_down_refreshes_the_root_total() {
        let _cache_guard = super::super::dir_stats::CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path();
        let deep = root.join("sub").join("deep");
        std::fs::create_dir_all(&deep).expect("mkdir deep");
        std::fs::write(deep.join("a.txt"), b"123456789").expect("write 9 bytes");

        let (size, _) = super::super::dir_stats::dir_stats_recursive(root, None).await;
        assert_eq!(size, 9, "warm the cache for root, root/sub and root/sub/deep");

        remove_and_invalidate(root, "sub/deep/a.txt").await.expect("delete");

        // Unlinking `root/sub/deep/a.txt` stamps `root/sub/deep` and nothing
        // above it, so the warmed row for `root` still validates by mtime.
        // Only the explicit ancestor drop can make this re-walk.
        let (size, count) = super::super::dir_stats::dir_stats_recursive(root, None).await;
        assert_eq!((size, count), (0, 0), "the root total must not survive a nested delete");
    }

    /// The invalidation must key off the path the LISTING builds (drive path
    /// from the DB + relative name), not the canonicalized target used for the
    /// removal. On macOS a temp dir lives under the `/var` -> `/private/var`
    /// symlink, so canonicalizing would write `/private/var/…` keys that no
    /// `/var/…` listing ever reads — the folder size would stay stale.
    #[tokio::test]
    async fn invalidation_uses_the_listing_path_not_the_canonical_one() {
        let _cache_guard = super::super::dir_stats::CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // The uncanonicalized path is what `get_all_sync_paths` hands the
        // delete loop; `dir_stats_recursive` is called with the same form.
        let root = tmp.path();
        let sub = root.join("sub");
        std::fs::create_dir(&sub).expect("mkdir sub");
        std::fs::write(sub.join("a.txt"), b"12345").expect("write 5 bytes");
        std::fs::write(sub.join("b.txt"), b"67").expect("write 2 bytes");

        let (size, _) = super::super::dir_stats::dir_stats_recursive(root, None).await;
        assert_eq!(size, 7);

        remove_and_invalidate(root, "sub/a.txt").await.expect("delete");

        let (size, count) = super::super::dir_stats::dir_stats_recursive(root, None).await;
        assert_eq!((size, count), (2, 1), "the listing-form key must be the one that was dropped");
    }

    /// Containment is still enforced on the way in, and a rejected path must
    /// not be reported as a delete.
    #[tokio::test]
    async fn remove_and_invalidate_rejects_an_escaping_relative_name() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path().join("drive");
        std::fs::create_dir(&root).expect("mkdir drive");
        std::fs::write(tmp.path().join("outside.txt"), b"x").expect("write");

        let err = remove_and_invalidate(&root, "../outside.txt").await.expect_err("must reject");
        assert!(matches!(err, crate::error::AppError::Validation(_)), "got {err:?}");
        assert!(tmp.path().join("outside.txt").exists(), "the escaping target must survive");
    }
}
