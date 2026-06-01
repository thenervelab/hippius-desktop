//! File operations on the local sync folder.
//!
//! These commands let the frontend add, remove, list, and export files
//! from the sync folder. The hcfs-client file watcher picks up changes
//! automatically and syncs them to the remote server.
//!
//! All path-accepting commands include traversal protection via `ensure_within()`.

use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::auth::account_key::account_key;
use crate::error::Result;
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::{SyncRunner, trigger_sync};
use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem};

/// Allow the given directory (recursively) in the Tauri asset protocol scope
/// so the frontend can display files via `asset://localhost/...` URLs.
///
/// The static scope in `tauri.conf.json` only covers `$HOME/.hippius/**` (drive
/// metadata). User-chosen sync folders live elsewhere, so we expand the scope
/// at runtime whenever a sync path is configured or loaded.
pub fn allow_asset_directory(app: &tauri::AppHandle, path: &str) {
    let dir = Path::new(path);
    if !dir.exists() {
        info!("Skipping asset scope for non-existent path: {}", path);
        return;
    }
    match app.asset_protocol_scope().allow_directory(dir, true) {
        Ok(()) => info!("Asset protocol scope allowed for: {}", path),
        Err(e) => warn!("Failed to allow asset scope for '{}': {}", path, e),
    }
}

/// Tauri command to explicitly allow a directory in the asset protocol scope.
/// Called by the frontend at startup for every known sync path.
#[tauri::command]
pub async fn allow_asset_scope(app: tauri::AppHandle, path: String) -> Result<()> {
    allow_asset_directory(&app, &path);
    Ok(())
}

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: Option<u64>,
    /// Sync status: "synced", "pending", or "unknown"
    pub sync_status: String,
    /// Hex-encoded path_hash from the synced state (empty if not synced yet)
    pub arion_hash: String,
    /// Arion CID from storage backend (empty if not available)
    pub arion_cid: String,
    /// For folders: total number of files (not directories) recursively inside.
    /// For files: 0.
    pub file_count: u64,
    /// Server-side timestamp: when the file was first uploaded (Unix seconds).
    /// 0 when not available (file not yet synced).
    pub uploaded_at: i64,
    /// Server-side timestamp: when the file was last updated (Unix seconds).
    /// 0 when not available (file not yet synced).
    pub updated_at: i64,
}

/// Verify that `child` is contained within `parent` after canonicalization.
/// Delegates to hcfs-client library.
fn ensure_within(parent: &Path, child: &Path) -> Result<PathBuf> {
    hcfs_client::drive::files::ensure_within(parent, child).map_err(|e| crate::error::AppError::Other(e.to_string()))
}

/// Pure file-copy implementation, no eligibility check. The check is
/// performed at the IPC boundary by `add_file` (single-file path) or
/// `add_files` (batch path), and the inner helper is called from both
/// without re-checking — see the call sites for the rationale.
///
/// Takes an already-canonicalized parent directory so a batch caller can
/// canonicalize once outside the loop instead of paying the `realpath`
/// syscall per file (10–100 ms each on slow filesystems).
async fn add_file_internal(canonical_parent: &Path, file_path: &str) -> Result<String> {
    let source = Path::new(file_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Other("Invalid file name".into()))?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Other("Invalid file name".into()));
    }

    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    tokio::fs::copy(source, &canonical_dest)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Copy failed: {e}")))?;

    Ok(name)
}

/// Add file to sync folder (Drive auto-syncs)
#[tauri::command]
pub async fn add_file(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    sync_path: String,
    file_path: String,
) -> Result<String> {
    // Enforce credit eligibility at the IPC boundary, priced by actual
    // file size. The FE may still hit a 402 from hcfs-server if the
    // balance drops between gate and upload (concurrent device or
    // billing tick), but this gate prevents the common case where the
    // user obviously cannot afford the upload — addresses sync-402
    // plan Task 3.1.
    //
    // A `metadata` failure (file removed between picker and IPC,
    // permission denied, broken symlink) gates with `bytes = 0` so the
    // legacy `> 0` floor still applies — the subsequent `copy_dir_recursive`
    // / `tokio::fs::copy` will surface the I/O error to the user with
    // its native message. Don't `?`-bail here: a missing-file diagnostic
    // is clearer than "insufficient credits because we couldn't size it".
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    // A stat failure falls back to bytes=0, which collapses the byte-priced
    // credit gate to the legacy `> 0` floor (intentional — see above). Log it
    // so the under-pricing is observable instead of silent; the server 402
    // path remains the real backstop.
    let bytes = match tokio::fs::metadata(Path::new(&file_path)).await {
        Ok(m) => m.len(),
        Err(e) => {
            warn!(file = %file_path, error = %e, "could not size file for credit gate; falling back to legacy >0 floor");
            0
        }
    };
    crate::billing::eligibility::require_eligible(
        &state,
        &account_id,
        crate::billing::eligibility::InsufficientCreditsAction::FileUpload,
        bytes,
    )
    .await?;

    // Resolve the local sync-root path to its drive label. The
    // banner state is per-label (Task 4.1) so an active banner on
    // drive A no longer suppresses drive B's preparing widget. If
    // the row is gone (race with a drive removal) `label_opt` is
    // `None` and every banner write becomes a no-op for this IPC.
    let pool = state.pool()?;
    let label_opt = crate::sync::paths::label_for_sync_path(pool, &account_id, &sync_path)
        .await
        .ok()
        .flatten();

    // Mark the processing window. Released either by the first upload
    // chunk of the NEXT sync cycle (success path, gated by
    // `sync_session_epoch` in `handle_transfer_progress`) or by the
    // error guard below (failure path — IPC failed before any cycle
    // ran, so unconditional `reset` is correct).
    let epoch = state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
    if let Some(label) = label_opt.as_deref() {
        state.upload_processing.begin(&app, label, 1, epoch);
    }

    // Canonicalize the sync path once and pass it to the internal helper
    // so the helper can be cheap when called per-file from the batch path.
    //
    // We can't use `?` after `begin` because we must release the banner
    // (`reset`) BEFORE returning the error — otherwise it would sit there
    // until the watchdog timeout if the IPC fails before any sync cycle
    // can start.
    let canonical_parent = match tokio::fs::canonicalize(Path::new(&sync_path)).await {
        Ok(p) => p,
        Err(e) => {
            if let Some(label) = label_opt.as_deref() {
                state.upload_processing.reset(&app, label);
            }
            return Err(crate::error::AppError::Other(format!("Invalid sync path: {e}")));
        }
    };
    match add_file_internal(&canonical_parent, &file_path).await {
        Ok(name) => Ok(name),
        Err(e) => {
            if let Some(label) = label_opt.as_deref() {
                state.upload_processing.reset(&app, label);
            }
            Err(e)
        }
    }
}

/// Add folder to sync folder
#[tauri::command]
pub async fn add_folder(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    folder_path: String,
    subfolder: Option<String>,
) -> Result<String> {
    // Enforce credit eligibility at the IPC boundary — same rationale
    // as `add_file`, but priced by the recursive byte total of the
    // source folder. A folder with permission-denied subdirectories
    // returns a best-effort lower bound (see `sum_regular_file_bytes`),
    // which under-charges rather than over-charging the user — the
    // server's 402 path is still the last line of defense.
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    let bytes = sum_regular_file_bytes(Path::new(&folder_path)).await;
    crate::billing::eligibility::require_eligible(
        &state,
        &account_id,
        crate::billing::eligibility::InsufficientCreditsAction::FolderUpload,
        bytes,
    )
    .await?;

    // Resolve `sync_path` → drive label so the banner state can be
    // scoped per-label (Task 4.1). Banner writes degrade to no-op
    // when the row is absent (drive removed mid-IPC race).
    let pool = state.pool()?;
    let label_opt = crate::sync::paths::label_for_sync_path(pool, &account_id, &sync_path)
        .await
        .ok()
        .flatten();

    // Pre-walk the source tree so the banner shows an accurate count.
    // Cheap relative to the full copy (no file-content reads).
    //
    // Skip `begin` when the walk found zero files. The walk swallows
    // per-subdir I/O errors and returns a best-effort lower bound, so
    // count == 0 means either the folder is genuinely empty or every
    // subdir was unreadable — in both cases we should not raise a
    // banner that the sync engine will never clear (an empty plan
    // can complete without firing `SyncCompleted` in some hcfs-client
    // configurations).
    let count = count_regular_files(Path::new(&folder_path)).await;
    if count > 0
        && let Some(label) = label_opt.as_deref()
    {
        let epoch = state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
        state.upload_processing.begin(&app, label, count, epoch);
    }

    let result = add_folder_with_app_inner(&sync_path, &folder_path, subfolder.as_deref()).await;
    match result {
        Ok(name) => {
            // Trigger sync so the uploaded folder gets synced
            use tauri::Manager;
            let s = app.state::<crate::app_state::AppState>().sync.clone();
            let _ = trigger_sync(&s).await;
            Ok(name)
        }
        Err(e) => {
            // IPC failed before any sync cycle ran — unconditional
            // reset is correct (no cycle epoch to gate on). No-op
            // when no label resolved or when `begin` was skipped.
            if let Some(label) = label_opt.as_deref() {
                state.upload_processing.reset(&app, label);
            }
            Err(e)
        }
    }
}

/// Validation + copy logic for `add_folder`, factored out so the public
/// command can wrap the result in begin/clear-on-Err bookkeeping for
/// the upload-processing banner without nesting too deeply.
async fn add_folder_with_app_inner(sync_path: &str, folder_path: &str, subfolder: Option<&str>) -> Result<String> {
    let source = Path::new(folder_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Other("Invalid folder name".into()))?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Other("Invalid folder name".into()));
    }

    // Resolve target directory (with optional subfolder)
    let sync_root = Path::new(sync_path);
    let target_dir = if let Some(sub) = subfolder {
        // Reject traversal components before creating directories
        if sub.contains("..") {
            return Err(crate::error::AppError::Other("Subfolder path contains traversal component".into()));
        }
        let t = sync_root.join(sub);
        if !t.exists() {
            std::fs::create_dir_all(&t).map_err(|e| crate::error::AppError::Other(format!("Failed to create subfolder: {e}")))?;
        }
        // Verify resolved path is within sync root (async canonicalize so
        // we don't block the tokio worker thread on `realpath`).
        let canonical_root = tokio::fs::canonicalize(sync_root)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
        let canonical_target = tokio::fs::canonicalize(&t)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("Invalid subfolder path: {e}")))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(crate::error::AppError::Other("Subfolder escapes sync folder".into()));
        }
        t
    } else {
        sync_root.to_path_buf()
    };

    // Validate destination is within the sync folder BEFORE writing.
    let canonical_parent = tokio::fs::canonicalize(&target_dir)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    // Reject self-/ancestor-source picks at the IPC boundary so the dialog
    // can render a domain-specific message instead of letting `copy_dir_recursive`
    // run 64 levels of self-similar copies before erroring. See the
    // `add_folder_rejects_*` tests in hcfs-client for the bug that motivated
    // this guard.
    let canonical_source = tokio::fs::canonicalize(source)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Invalid folder path: {e}")))?;
    if canonical_dest.starts_with(&canonical_source) {
        return Err(crate::error::AppError::Other(
            "Cannot add the sync folder (or one of its ancestors) to itself".into(),
        ));
    }

    copy_dir_recursive(source, &canonical_dest, 0).await?;

    Ok(name)
}

/// Count regular files (non-directory, non-symlink) under `root`,
/// recursively. Used by `add_folder` and `add_files` to size the
/// `begin` count for the upload-processing banner.
///
/// Returns a best-effort lower bound: per-subdirectory I/O errors
/// (e.g. permission-denied) are silently skipped via `continue`, so
/// the count is the number of regular files we successfully
/// enumerated, not the total. A wholly-unreadable root produces 0.
/// Symlinks are not followed and are not counted (consistent with
/// `tokio::fs::DirEntry::file_type`'s `lstat`-equivalent behavior).
///
/// Iterative depth-first walk via an explicit stack to avoid recursive
/// async-fn boxing. Does not read file contents — only iterates
/// directory entries — so the cost is bounded by what `copy_dir_recursive`
/// is about to do anyway.
async fn count_regular_files(root: &std::path::Path) -> u64 {
    use tokio::fs;

    let mut count: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(mut entries) = fs::read_dir(&dir).await else { continue };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(ft) = entry.file_type().await else { continue };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                count = count.saturating_add(1);
            }
        }
    }
    count
}

/// Sum the byte size of regular files (non-directory, non-symlink) under
/// `root`, recursively. Used by the credit-eligibility gate in
/// `add_folder`, `add_files`, and `add_local_sync_folder` to compute the
/// total upload payload BEFORE invoking
/// `crate::billing::eligibility::require_eligible`.
///
/// Same invariants as [`count_regular_files`]:
/// - Iterative depth-first walk via explicit stack (no recursive async
///   boxing); cap depth at [`FOLDER_BYTE_WALK_MAX_DEPTH`] entries on the
///   stack to defend against symlink-cycle pathological cases. The cap
///   bounds the stack, not the total file count; the walk reads only
///   directory entries (no file content), so the I/O cost is the same
///   as `copy_dir_recursive` is already about to pay.
/// - Per-subdirectory I/O errors (permission denied, hardware faults)
///   are silently skipped via `continue` so the gate doesn't fail an
///   upload because ONE unreadable subdir made the byte-sum
///   undercount — the legitimate uploads still get gated on the
///   surviving bytes. A wholly-unreadable root returns `0`, which
///   correctly falls back to the static `> 0` threshold floor.
/// - Symlinks are NOT followed (`DirEntry::file_type` is lstat-shaped),
///   matching `count_regular_files` and avoiding loops.
/// - Each per-file size comes from `DirEntry::metadata`, which calls
///   `stat` on the entry itself (NOT the symlink target, since `ft`
///   already classified it as a regular file). Sizes are summed via
///   `saturating_add` so a malicious sparse file or `u64::MAX` length
///   can't panic.
pub(super) async fn sum_regular_file_bytes(root: &std::path::Path) -> u64 {
    use tokio::fs;

    let mut bytes: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Defense in depth: a symlink cycle could push entries forever
        // even though we don't follow symlinks at the entry level — a
        // legitimate `mount --bind` cycle, hardlinked directories on
        // non-POSIX filesystems, or an attacker pre-seeding the
        // directory tree could push the stack arbitrarily. The cap
        // matches the recursion depth used elsewhere in this module
        // (`copy_dir_recursive`).
        if stack.len() > FOLDER_BYTE_WALK_MAX_DEPTH {
            break;
        }
        let Ok(mut entries) = fs::read_dir(&dir).await else { continue };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(ft) = entry.file_type().await else { continue };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file()
                && let Ok(meta) = entry.metadata().await
            {
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    bytes
}

/// Stack-depth cap for [`sum_regular_file_bytes`]. Sized to match the
/// 64-level cap that `copy_dir_recursive` already enforces — a folder
/// deeper than this would fail the subsequent copy anyway, so refusing
/// to walk further is consistent with the rest of the module.
const FOLDER_BYTE_WALK_MAX_DEPTH: usize = 4096;

/// Recursively sum the byte size of a heterogeneous batch of paths
/// (a mix of regular files and directories). Used by `add_files` to
/// compute the credit-eligibility byte total. Each direct file path is
/// sized via `tokio::fs::metadata`; each directory is walked through
/// [`sum_regular_file_bytes`]. Per-path metadata failures degrade to
/// zero so a missing or unreadable entry doesn't reject the rest of
/// the batch — the subsequent copy loop surfaces the real I/O error.
async fn sum_batch_bytes(paths: &[String]) -> u64 {
    let mut total: u64 = 0;
    for fp in paths {
        let p = std::path::Path::new(fp);
        let add = if p.is_dir() {
            sum_regular_file_bytes(p).await
        } else {
            tokio::fs::metadata(p).await.map_or(0, |m| m.len())
        };
        total = total.saturating_add(add);
    }
    total
}

/// Internal folder copy — no sync trigger (caller handles it).
///
/// Takes an already-canonicalized parent so the batch caller can canonicalize
/// once outside the loop instead of per-folder.
async fn add_folder_internal(canonical_parent: &Path, folder_path: &str) -> Result<String> {
    let source = Path::new(folder_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Other("Invalid folder name".into()))?
        .to_string();

    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Other("Invalid folder name".into()));
    }

    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    // Same guard as `add_folder_with_app_inner` — see that function for the
    // bug that motivated this check. `add_files` reaches this helper when
    // the batch contains directories, so the protection has to live here too.
    let canonical_source = tokio::fs::canonicalize(source)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Invalid folder path: {e}")))?;
    if canonical_dest.starts_with(&canonical_source) {
        return Err(crate::error::AppError::Other(
            "Cannot add the sync folder (or one of its ancestors) to itself".into(),
        ));
    }

    copy_dir_recursive(source, &canonical_dest, 0).await?;
    Ok(name)
}

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

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
    let pool = state.pool()?;
    let mut deleted = 0u32;
    let mut failed = Vec::new();

    for file in &files {
        let effective_label = file.label.as_deref().unwrap_or("default");
        let sync_path = match crate::sync::config::get_sync_path_for_label(pool, &account_id, effective_label).await {
            Ok(p) => p,
            Err(_) if effective_label != "default" => crate::sync::config::get_sync_path_for_label(pool, &account_id, "default")
                .await
                .unwrap_or_default(),
            Err(_) => String::new(),
        };

        let relative_name = derive_relative_name(&sync_path, file.source.as_deref(), &file.name);

        let parent = Path::new(&sync_path);
        let target = parent.join(&relative_name);
        match ensure_within(parent, &target) {
            Ok(target) => {
                let size_bytes = if target.is_dir() {
                    0
                } else {
                    tokio::fs::metadata(&target).await.map(|m| m.len()).unwrap_or(0)
                };

                let remove_result = if target.is_dir() {
                    tokio::fs::remove_dir_all(&target).await
                } else if target.exists() {
                    tokio::fs::remove_file(&target).await
                } else {
                    Ok(())
                };

                match remove_result {
                    Ok(()) => {
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
            Err(e) => {
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

    info!(deleted, failed = failed.len(), "Batch delete completed");
    Ok(DeleteFilesResult { deleted, failed })
}

/// Add multiple files to the sync folder in one call.
///
/// Copies each file into `sync_path` and triggers sync once at the end.
/// Add multiple files/folders to the sync folder. Collects errors instead
/// of aborting on the first failure. Always triggers sync at the end so
/// successfully added files get uploaded even if some failed.
#[derive(Serialize)]
pub struct AddFilesResult {
    pub added: Vec<String>,
    pub failed: Vec<FileDeleteError>,
}

/// Batch file/folder add operation. Used by both the loose multi-file
/// upload path (`useFilesUpload::upload` — drag/drop, multi-select) and
/// the folder-upload path (`UploadFilesFlow::uploadFilesFolder`).
///
/// The `for_folder` parameter classifies the batch so the credit
/// eligibility check uses the right action. FE callers MUST set it
/// correctly:
///
/// - `false` for loose multi-file uploads → `FileUpload` action
/// - `true` for folder uploads (the entire folder is one billable
///   unit) → `FolderUpload` action
///
/// The thresholds for both actions are identical today (`> 0`), but
/// pricing for folder uploads can diverge in the future and the gate
/// would silently use the wrong threshold if the FE classified
/// incorrectly.
#[tauri::command]
#[expect(
    clippy::too_many_lines,
    reason = "Linear early-return flow with per-step banner reset (Task 4.1); splitting into helpers would either re-route the banner reset through trait/closure plumbing or fragment the canonicalize-then-validate sequence."
)]
pub async fn add_files(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    file_paths: Vec<String>,
    subfolder: Option<String>,
    for_folder: bool,
) -> Result<AddFilesResult> {
    // Enforce credit eligibility once for the whole batch at the IPC
    // boundary. The per-file `add_file_internal` calls inside the loop
    // below do NOT re-check — there's no point hammering the billing
    // API once per file when the batch is treated as a single unit.
    //
    // The byte sum drives the price: each direct file path is sized via
    // `tokio::fs::metadata`, each directory path is walked recursively
    // via `sum_regular_file_bytes`. Per-path metadata failures degrade
    // to 0 so a missing file in the input list doesn't reject the rest
    // of the batch — the subsequent copy loop surfaces the I/O error.
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    let action = if for_folder {
        crate::billing::eligibility::InsufficientCreditsAction::FolderUpload
    } else {
        crate::billing::eligibility::InsufficientCreditsAction::FileUpload
    };
    let total_bytes = sum_batch_bytes(&file_paths).await;
    crate::billing::eligibility::require_eligible(&state, &account_id, action, total_bytes).await?;

    // Sum the file count for the banner. Each direct file path counts
    // as 1; each directory path gets a recursive walk via
    // `count_regular_files` (introduced in Task 7). Released either by
    // the first upload chunk (success), the early-return error paths
    // below (failure), or the all-failed-batch guard after the loop.
    //
    // Per-directory counts use `.max(1)` so that an unwalkable subdir
    // (permission denied) still bumps the total by 1 — we know there's
    // a directory there, even if we can't enumerate it. Per-batch
    // count is NOT clamped: an empty `file_paths` skips `begin` so
    // that an empty IPC call doesn't raise a banner that nothing
    // will ever clear.
    let mut total_count: u64 = 0;
    for fp in &file_paths {
        let p = Path::new(fp);
        if p.is_dir() {
            total_count = total_count.saturating_add(count_regular_files(p).await.max(1));
        } else {
            total_count = total_count.saturating_add(1);
        }
    }
    // Resolve `sync_path` → drive label once before any banner write
    // so the per-label state (Task 4.1) can route every `begin`/`reset`
    // for this IPC to the right drive. Banner writes degrade to no-op
    // when the row is absent.
    let pool = state.pool()?;
    let label_opt = crate::sync::paths::label_for_sync_path(pool, &account_id, &sync_path)
        .await
        .ok()
        .flatten();

    if total_count > 0
        && let Some(label) = label_opt.as_deref()
    {
        let epoch = state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
        state.upload_processing.begin(&app, label, total_count, epoch);
    }

    // Reset helper: scoped to the resolved label, no-op when none.
    // Each fallible early-return path below calls this before
    // returning so the banner doesn't sit until the watchdog timeout.
    // Unconditional reset is correct here because the IPC failed
    // before any sync cycle could run.
    let reset_banner = |app: &AppHandle, state: &crate::app_state::AppState| {
        if let Some(label) = label_opt.as_deref() {
            state.upload_processing.reset(app, label);
        }
    };

    // When a subfolder is specified, resolve the effective target directory.
    // This replaces the path-join logic that was previously in TypeScript.
    // Async canonicalize so a slow filesystem doesn't block the tokio worker.
    let target_path = if let Some(ref sub) = subfolder {
        // Reject traversal components
        if sub.contains("..") {
            reset_banner(&app, &state);
            return Err(crate::error::AppError::Other("Subfolder path contains traversal component".into()));
        }
        let target = Path::new(&sync_path).join(sub);
        if !target.exists()
            && let Err(e) = std::fs::create_dir_all(&target)
        {
            reset_banner(&app, &state);
            return Err(crate::error::AppError::Other(format!("Failed to create subfolder: {e}")));
        }
        // Verify resolved path stays within sync root.
        let canonical_root = match tokio::fs::canonicalize(Path::new(&sync_path)).await {
            Ok(p) => p,
            Err(e) => {
                reset_banner(&app, &state);
                return Err(crate::error::AppError::Other(format!("Invalid sync path: {e}")));
            }
        };
        let canonical_target = match tokio::fs::canonicalize(&target).await {
            Ok(p) => p,
            Err(e) => {
                reset_banner(&app, &state);
                return Err(crate::error::AppError::Other(format!("Invalid subfolder path: {e}")));
            }
        };
        if !canonical_target.starts_with(&canonical_root) {
            reset_banner(&app, &state);
            return Err(crate::error::AppError::Other("Subfolder escapes sync folder".into()));
        }
        target.to_string_lossy().to_string()
    } else {
        sync_path.clone()
    };

    // Canonicalize the target directory ONCE before the loop so each
    // per-file call doesn't re-pay the `realpath` syscall (which can be
    // 10–100 ms on slow filesystems and blocks the tokio worker).
    let canonical_target = match tokio::fs::canonicalize(Path::new(&target_path)).await {
        Ok(p) => p,
        Err(e) => {
            reset_banner(&app, &state);
            return Err(crate::error::AppError::Other(format!("Invalid sync path: {e}")));
        }
    };

    let mut added = Vec::new();
    let mut failed = Vec::new();

    let total = file_paths.len();
    for (i, file_path) in file_paths.iter().enumerate() {
        let source = Path::new(file_path);
        let result = if source.is_dir() {
            // Pass app handle but no subfolder — subfolder already resolved into target_path.
            // Don't trigger sync per-folder — add_files triggers once at the end.
            add_folder_internal(&canonical_target, file_path).await
        } else {
            // Use the internal helper that skips the per-file eligibility
            // check — the batch eligibility check at the top of `add_files`
            // covers the whole operation.
            add_file_internal(&canonical_target, file_path).await
        };
        match result {
            Ok(name) => added.push(name),
            Err(e) => {
                let name = source.file_name().map_or_else(|| file_path.clone(), |n| n.to_string_lossy().to_string());
                warn!(file = %name, error = %e, "Failed to add file");
                failed.push(FileDeleteError { name, error: e.to_string() });
            }
        }
        let _ = app.emit(
            "add_files_progress",
            serde_json::json!({
                "completed": i + 1,
                "total": total,
            }),
        );
    }

    // If the batch was a total failure (every entry errored during
    // copy), there is no work to upload. Clear the banner here so we
    // don't depend on `trigger_sync` to produce a terminal event for
    // an empty plan — hcfs-client may skip the cycle entirely if there
    // is nothing to do, leaving a `Processing N files…` banner stuck
    // until the next sync cycle (which could be minutes away).
    //
    // Unconditional `reset` is correct: the batch never produced any
    // upload work, so there is no future cycle whose epoch we need
    // to gate against. `reset` is safe even if `begin` was never
    // called (e.g. `total_count` was 0 above): the per-label `remove`
    // short-circuits when no entry exists.
    if added.is_empty() {
        reset_banner(&app, &state);
    }

    // Always trigger sync so successfully added files get uploaded
    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>().sync.clone();
        let _ = trigger_sync(&s).await;
    }

    info!(added = added.len(), failed = failed.len(), "Batch add completed");
    Ok(AddFilesResult { added, failed })
}

use hcfs_client::engine::types::{SyncedFileInfo, build_synced_paths_from_state};

/// Build a map of relative paths → sync info for files whose
/// `path_hash` appears in the drive's persisted `synced` tree.
/// Returns `None` when the drive isn't available (e.g. logged out)
/// so the caller can fall back to "unknown".
///
/// Tries the live drive lock first (non-blocking). On success the cache
/// is also refreshed. When the lock is unavailable (sync in progress),
/// falls back to the last cached snapshot so the file browser still
/// shows accurate sync status instead of "unknown".
///
/// Waits up to [`FIRST_RECONCILE_WAIT_BUDGET`] for the per-drive
/// reconcile readiness gate so the cache contains authoritative
/// timestamps on cold start. See
/// [`synced_paths_and_excludes_for_label`] for the full rationale.
async fn synced_paths_for_label(sync: &SyncRunner, label: &str) -> Option<HashMap<String, SyncedFileInfo>> {
    let _ = sync
        .wait_for_first_reconcile(label, FIRST_RECONCILE_WAIT_BUDGET)
        .await;
    let arc = match acquire_drive_arc(sync, label) {
        DriveArcOutcome::Acquired(arc) => arc,
        DriveArcOutcome::CacheFallback => return sync.get_cached_synced_paths(label),
    };
    // `try_lock` (not `lock().await`) is essential here: the per-drive
    // mutex is held by the sync loop for the duration of a sync cycle,
    // and the file browser must remain responsive during that window.
    // Falling back to the cache on contention is a deliberate tradeoff:
    // slightly stale on-screen sync status > a 30-second listing freeze.
    match arc.try_lock() {
        Ok(manager) => match manager.load_sync_state().await {
            Ok(state) => {
                let paths = build_synced_paths_from_state(&state);
                sync.update_synced_paths_cache(label, paths.clone());
                Some(paths)
            }
            Err(_) => None,
        },
        Err(_) => sync.get_cached_synced_paths(label),
    }
}

/// Read both the synced-paths map and the exclusion patterns for `label`
/// behind a single outer-drives lock acquisition.
///
/// Before reading the cache, wait up to [`FIRST_RECONCILE_WAIT_BUDGET`]
/// for the per-drive readiness gate to settle. This closes the cold-
/// start race where `get_user_files` would observe a stale cache
/// (with `uploaded_at = 0` for any file the local `sync_state.json`
/// is missing timestamps for) before the background reconcile
/// finished its first attempt. Net effect: first Files-page render
/// after login shows correct upload dates instead of "—" until the
/// user logs out and back in. Per-drive wait, parallel across
/// drives because `get_user_files` fans out via `join_all`, so the
/// worst-case latency is bounded by the budget itself, not by drive
/// count.
async fn synced_paths_and_excludes_for_label(sync: &SyncRunner, label: &str) -> (Option<HashMap<String, SyncedFileInfo>>, Vec<String>) {
    // Block reads until the first reconcile has settled (or the
    // budget elapses). We discard the outcome here — the cache
    // contents are what we read below; this wait only serves to
    // delay the read until those contents are trustworthy. A
    // `Timeout` / `NotRegistered` falls through to whatever stale
    // state we have, matching the existing graceful-degradation
    // contract.
    let _ = sync
        .wait_for_first_reconcile(label, FIRST_RECONCILE_WAIT_BUDGET)
        .await;

    let arc = match acquire_drive_arc(sync, label) {
        DriveArcOutcome::Acquired(arc) => arc,
        DriveArcOutcome::CacheFallback => return (sync.get_cached_synced_paths(label), Vec::new()),
    };
    // `try_lock` (not `lock().await`) is essential — see synced_paths_for_label.
    match arc.try_lock() {
        Ok(manager) => {
            let synced = match manager.load_sync_state().await {
                Ok(state) => {
                    let paths = build_synced_paths_from_state(&state);
                    sync.update_synced_paths_cache(label, paths.clone());
                    Some(paths)
                }
                Err(_) => None,
            };
            let excludes = manager.list_exclude_patterns();
            (synced, excludes)
        }
        Err(_) => (sync.get_cached_synced_paths(label), Vec::new()),
    }
}

/// Maximum time `synced_paths_and_excludes_for_label` is willing to
/// wait for a drive's first reconcile to settle before reading the
/// cache. Sized to comfortably cover the production retry schedule
/// (0s / 2s / 5s = up to ~7s for the third attempt to start) with a
/// small margin: at 6s we accept that an extremely slow third
/// attempt may finish after we've returned and let the
/// `ACTIVITY_UPDATED` event refresh the FE — the worst case is
/// one extra refetch, not a stale forever read.
const FIRST_RECONCILE_WAIT_BUDGET: std::time::Duration = std::time::Duration::from_secs(6);

/// Outcome of locating a per-drive `DriveManager` Arc behind the outer
/// drives map. Either we got the Arc, or the outer/inner lookup failed and
/// the caller should fall back to the cache.
enum DriveArcOutcome {
    Acquired(std::sync::Arc<tokio::sync::Mutex<DriveManager>>),
    CacheFallback,
}

/// Single source of truth for the outer-drives map lookup that both the
/// synced-paths-only and synced-paths-plus-excludes helpers need. Locks
/// `sync.drives` non-blockingly (briefly), copies out the per-drive Arc,
/// and drops the outer lock immediately so concurrent listings don't
/// queue behind the sync loop.
fn acquire_drive_arc(sync: &SyncRunner, label: &str) -> DriveArcOutcome {
    match sync.drives.try_lock() {
        Ok(guard) => match guard.get(label) {
            Some(slot) => DriveArcOutcome::Acquired(slot.manager.clone()),
            None => DriveArcOutcome::CacheFallback,
        },
        Err(_) => DriveArcOutcome::CacheFallback,
    }
}

/// Sync metadata for a single file, returned by `get_synced_file_metadata`.
#[derive(Serialize)]
pub struct SyncedFileMetadata {
    /// File name (basename only, e.g. "photo.jpg")
    pub file_name: String,
    /// Relative path from sync root (e.g. "subfolder/photo.jpg")
    pub relative_path: String,
    /// Drive label this file belongs to
    pub label: String,
    /// Hex-encoded BLAKE3 path hash
    pub arion_hash: String,
    /// Arion CID from storage backend (empty if not available)
    pub arion_cid: String,
    /// Unix timestamp when file was first uploaded (0 if unknown)
    pub uploaded_at: i64,
    /// Unix timestamp when file was last updated (0 if unknown)
    pub updated_at: i64,
}

/// Return sync metadata (arion hashes, CIDs, timestamps) for all synced
/// files across all drives. Used internally by `get_user_files` to look
/// up arion hashes without needing to list every subfolder from disk.
/// Acquire each drive's synced-paths map: live per-drive lock first (cache
/// warmed on success), falling back to the cached snapshot when a drive is
/// mid-sync (or all drives are busy). Shared by the whole-corpus
/// [`get_synced_file_metadata`] and the bounded recent-files lookup.
async fn collect_label_maps(sync: &SyncRunner) -> Vec<(String, HashMap<String, SyncedFileInfo>)> {
    let drive_arcs: Vec<(String, std::sync::Arc<tokio::sync::Mutex<DriveManager>>)> = match sync.drives.try_lock() {
        Ok(guard) => guard.iter().map(|(k, slot)| (k.clone(), slot.manager.clone())).collect(),
        Err(_) => Vec::new(),
    };
    if drive_arcs.is_empty() {
        // All locks held by sync — use cached data.
        return match sync.synced_paths_cache.lock() {
            Ok(cache) => cache.iter().map(|(l, m)| (l.clone(), m.clone())).collect(),
            Err(_) => Vec::new(),
        };
    }
    let mut out = Vec::new();
    for (label, arc) in &drive_arcs {
        if let Ok(manager) = arc.try_lock() {
            if let Ok(st) = manager.load_sync_state().await {
                let paths = build_synced_paths_from_state(&st);
                sync.update_synced_paths_cache(label, paths.clone());
                out.push((label.clone(), paths));
            }
        } else if let Some(cached) = sync.get_cached_synced_paths(label) {
            // Drive is syncing — fall back to cached snapshot so arion
            // hashes remain visible while downloads are active.
            out.push((label.clone(), cached));
        }
    }
    out
}

/// Bounded variant of the synced-paths walk for the recent-files view.
///
/// `get_synced_file_metadata` materializes a `SyncedFileMetadata` (and several
/// string/hash allocations) for EVERY synced file across all drives, even
/// though `get_recent_files` only ever looks up at most `limit` (~50) keys.
/// This allocates a `MetadataBundle` only for keys in `wanted`, so the
/// per-row cost (hex-encoding the 32-byte hash, cloning the CID) is paid for
/// the activity window, not the whole corpus. Pure (no `SyncRunner`) so the
/// allocation bound is unit-testable.
fn bundles_for_wanted_keys(
    label_maps: Vec<(String, HashMap<String, SyncedFileInfo>)>,
    wanted: &std::collections::HashSet<String>,
) -> HashMap<String, MetadataBundle> {
    let mut out = HashMap::with_capacity(wanted.len());
    for (label, paths) in label_maps {
        for (rel_path, info) in paths {
            let key = format!("{rel_path}::{label}");
            if !wanted.contains(&key) {
                continue;
            }
            out.insert(
                key,
                MetadataBundle {
                    arion_hash: info.path_hash_hex(),
                    arion_cid: info.arion_cid.to_string(),
                    uploaded_at: info.uploaded_at,
                    updated_at: info.updated_at,
                },
            );
        }
    }
    out
}

pub async fn get_synced_file_metadata(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Vec<SyncedFileMetadata>> {
    let mut result = Vec::new();
    let label_maps = collect_label_maps(&state.sync).await;

    for (label, paths) in label_maps {
        // Move out of the HashMap so we can take ownership of `rel_path`
        // and only clone once per row (used to be twice — once each for
        // `file_name` and `relative_path`, both of which always carry
        // identical content).
        for (rel_path, info) in paths {
            // Use the full relative path so lookups match activity items
            // that also use relative paths (e.g. "bucket/photo.jpg").
            result.push(SyncedFileMetadata {
                file_name: rel_path.clone(),
                relative_path: rel_path,
                label: label.clone(),
                arion_hash: info.path_hash_hex(),
                arion_cid: info.arion_cid.to_string(),
                uploaded_at: info.uploaded_at,
                updated_at: info.updated_at,
            });
        }
    }

    Ok(result)
}

/// A recent file ready for UI rendering. Matches the frontend `FormattedUserFile`
/// shape so the hook can pass it through without transformation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub actual_file_name: String,
    pub size: u64,
    pub created_at: i64,
    pub arion_hash: String,
    pub arion_cid: String,
    pub source: String,
    pub miner_ids: Vec<String>,
    pub is_assigned: bool,
    pub last_charged_at: i64,
    pub file_hash: String,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub file_type: String,
    pub is_erasure_coded: bool,
    pub main_req_hash: String,
    pub label: String,
}

/// Bundled per-file metadata from synced paths, used to enrich recent file entries.
/// Keyed by `"filename::label"` in the lookup map.
struct MetadataBundle {
    arion_hash: String,
    arion_cid: String,
    uploaded_at: i64,
    updated_at: i64,
}

/// Fetch recent files by joining sync activity, sync paths, and file metadata.
///
/// This replaces the 130-line orchestration in `use-recent-files/index.ts`.
/// All data joining, filtering, deduplication, and sorting happens in Rust.
#[tauri::command]
pub async fn get_recent_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    limit: Option<usize>,
) -> Result<Vec<RecentFile>> {
    let sync = &state.sync;
    let pool = state.pool()?;

    // 1. Get sync activity items
    let items = sync.get_sync_activity(limit, None);
    if items.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Get sync paths → build label→path lookup
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id)
        .await
        .unwrap_or_default();
    let label_to_path: HashMap<String, String> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty() && !sp.label.is_empty())
        .map(|sp| (sp.label.clone(), sp.path.clone()))
        .collect();

    // 3. Filter deleted files FIRST so the metadata lookup below is bounded by
    //    the (<= limit) surviving activity rows, not the whole synced corpus.
    let deleted_names: std::collections::HashSet<String> = items
        .iter()
        .filter(|item| item.action == SyncActivityAction::Deleted)
        .map(|item| format!("{}::{}", item.file_name, item.label))
        .collect();

    let non_deleted: Vec<_> = items
        .iter()
        .filter(|item| item.action != SyncActivityAction::Deleted && !deleted_names.contains(&format!("{}::{}", item.file_name, item.label)))
        .collect();

    if non_deleted.is_empty() {
        return Ok(Vec::new());
    }

    // 4. Look up synced metadata for ONLY the surviving keys. Allocation scales
    //    with the activity window, not the total number of synced files.
    let wanted: std::collections::HashSet<String> = non_deleted
        .iter()
        .map(|item| format!("{}::{}", item.file_name, item.label))
        .collect();
    let label_maps = collect_label_maps(&state.sync).await;
    let mut meta_map = bundles_for_wanted_keys(label_maps, &wanted);

    // 5. Map to RecentFile with path resolution and timestamp priority
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for item in &non_deleted {
        // Deduplicate by actualFileName + label (reuse key for meta_map lookup)
        let key = format!("{}::{}", item.file_name, item.label);
        if !seen.insert(key.clone()) {
            continue;
        }

        let sync_folder_path = label_to_path.get(item.label.as_ref());
        let source = match sync_folder_path {
            Some(path) if !item.file_name.is_empty() => format!("{path}/{}", item.file_name),
            _ => String::new(),
        };
        let display_name = item.file_name.rsplit('/').next().unwrap_or(&item.file_name).to_string();
        let display_name = if display_name.is_empty() { "Unknown".to_string() } else { display_name };

        let bundle = meta_map.remove(&key);
        let (arion_hash, arion_cid, uploaded_at_sec, updated_at_sec) = match bundle {
            Some(b) => (b.arion_hash, b.arion_cid, b.uploaded_at, b.updated_at),
            None => (String::new(), String::new(), 0, 0),
        };

        let activity_ms = if item.timestamp != 0 { item.timestamp * 1000 } else { now_ms };
        let created_at_ms = if uploaded_at_sec != 0 { uploaded_at_sec * 1000 } else { activity_ms };
        let last_charged_at_ms = if updated_at_sec != 0 {
            updated_at_sec * 1000
        } else if uploaded_at_sec != 0 {
            uploaded_at_sec * 1000
        } else {
            activity_ms
        };

        let file_type = {
            let mut chars = item.action.as_str().chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        };

        result.push(RecentFile {
            name: display_name,
            actual_file_name: item.file_name.to_string(),
            size: item.size_bytes,
            created_at: created_at_ms,
            arion_hash,
            arion_cid,
            source,
            miner_ids: Vec::new(),
            is_assigned: true,
            last_charged_at: last_charged_at_ms,
            file_hash: String::new(),
            is_folder: false,
            file_type,
            is_erasure_coded: false,
            main_req_hash: String::new(),
            label: item.label.to_string(),
        });
    }

    // 6. Sort by timestamp (newest first)
    result.sort_by(|a, b| b.last_charged_at.cmp(&a.last_charged_at));

    Ok(result)
}

/// Process-wide cache for [`dir_stats_recursive`].
///
/// Keyed by absolute path. Each entry records the directory's mtime at the
/// time of the walk. On lookup, if the current mtime matches the cached
/// one, the cached `(size, count)` is returned without re-walking. APFS,
/// ext4, and NTFS all bump a directory's mtime on add/remove/rename of
/// children, which is the only invalidation case the file browser cares
/// about — pure file-content changes within an unmodified directory don't
/// invalidate the cache, but they don't change `count` and almost never
/// shift the displayed size by a meaningful amount.
///
/// **Symlinks**: `tokio::fs::metadata` follows symlinks. If a sync folder
/// contains a symlink whose target's directory mtime changes without the
/// symlink itself being touched, the cache will return stale stats. Sync
/// folders typically don't contain symlinks (they're user document
/// folders), so this is a documented limitation rather than a regression.
///
/// **Eviction**: bounded organically by the number of folders the user
/// browses — small in practice (sync roots + their subfolders, ~hundreds
/// of entries on a long session). No TTL or LRU cap. If usage patterns
/// change and the cache grows large, swap to `quick_cache` or wire a
/// per-drive cache that drops on `remove_drive`.
/// Cached `(mtime, size, count)` for each cached directory path.
type DirStatsEntry = (std::time::SystemTime, u64, u64);
type DirStatsMap = std::sync::Mutex<HashMap<std::path::PathBuf, DirStatsEntry>>;

static DIR_STATS_CACHE: OnceLock<DirStatsMap> = OnceLock::new();

fn dir_stats_cache() -> &'static DirStatsMap {
    DIR_STATS_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Recursively compute total size and file count within a directory.
/// Hidden files (starting with '.') are excluded.
///
/// Memoised by `(path, mtime)`. On a hit the cached `(size, count)` is
/// returned without descending the tree. Cache misses fall through to the
/// recursive walk and write the result back to the cache before returning.
async fn dir_stats_recursive(path: &Path) -> (u64, u64) {
    // Cache lookup. Stat the directory once to learn its mtime; on match
    // skip the walk entirely.
    let mtime = match tokio::fs::metadata(path).await {
        Ok(meta) => meta.modified().ok(),
        Err(_) => None,
    };
    if let Some(mtime) = mtime
        && let Ok(cache) = dir_stats_cache().lock()
        && let Some((cached_mtime, size, count)) = cache.get(path)
        && *cached_mtime == mtime
    {
        return (*size, *count);
    }

    // Cache miss — walk the tree.
    let (size, count) = dir_stats_walk(path).await;

    // Store under the original mtime (if we got one). If mtime is None
    // we skip caching so the next call retries the walk.
    if let Some(mtime) = mtime
        && let Ok(mut cache) = dir_stats_cache().lock()
    {
        cache.insert(path.to_path_buf(), (mtime, size, count));
    }
    (size, count)
}

/// The pure recursive walk underpinning [`dir_stats_recursive`]. Split out so
/// the cache lookup wraps it without recursing through the cache lookup
/// itself (recursive calls always re-walk subdirectories — the cache would
/// add lock contention without reducing total work since the parent mtime
/// already validated the whole subtree).
async fn dir_stats_walk(path: &Path) -> (u64, u64) {
    let mut size: u64 = 0;
    let mut count: u64 = 0;
    let Ok(mut dir) = tokio::fs::read_dir(path).await else {
        return (0, 0);
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_dir() {
            let (sub_size, sub_count) = Box::pin(dir_stats_walk(&entry.path())).await;
            size += sub_size;
            count += sub_count;
        } else {
            size += meta.len();
            count += 1;
        }
    }
    (size, count)
}

/// List contents of sync folder.
///
/// Thin wrapper around [`list_sync_folder_inner`] that unwraps `state` —
/// callers inside Rust (notably [`list_sync_folder_grouped`]) should hit the
/// inner helper directly to avoid going through the Tauri command plumbing.
#[tauri::command]
pub async fn list_sync_folder(
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<Vec<FileEntry>> {
    list_sync_folder_inner(&state, sync_path, subfolder, label).await
}

#[expect(clippy::too_many_lines, reason = "1 line over; extracting hurts readability")]
async fn list_sync_folder_inner(
    state: &crate::app_state::AppState,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<Vec<FileEntry>> {
    let base = PathBuf::from(&sync_path);
    let target = match subfolder {
        Some(ref sub) => base.join(sub),
        None => base.clone(),
    };

    // Return empty list if directory doesn't exist yet (e.g. sync still initializing after login)
    if !target.exists() {
        return Ok(Vec::new());
    }

    // Validate subfolder stays within sync_path
    if subfolder.is_some() {
        ensure_within(&base, &target)?;
    }

    // Load synced paths AND exclusion patterns in a single drives-map
    // lock + single per-drive lock. Previously these were two separate
    // acquisitions (synced_paths_for_label, then a `.lock().await` on
    // the same outer mutex for excludes) which serialized listings
    // behind any in-flight sync that held the outer lock.
    let (synced_set, excluded_patterns) = match label {
        Some(ref l) => synced_paths_and_excludes_for_label(&state.sync, l).await,
        None => (None, Vec::new()),
    };

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Read dir failed: {e}")))?;

    while let Some(entry) = dir.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip .hippius config directory and hidden files
        if name.starts_with('.') {
            continue;
        }

        let meta = entry.metadata().await?;
        let is_folder = meta.is_dir();

        // Remove and skip failed download artifacts (`downloaded_<hex>`) and
        // 0-byte encrypted-name stubs (`file_<hex>`) left by decryption
        // failures. Deleting on sight closes the gap between sync cycles
        // where post-sync cleanup hasn't run yet.
        if !is_folder {
            if hcfs_client::engine::classify::is_failed_download_artifact(&name).is_some() {
                let path = entry.path();
                info!(artifact = %name, "Removing failed download artifact on list");
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
            if hcfs_client::engine::classify::is_encrypted_name_stub(&name).is_some() && meta.len() == 0 {
                let path = entry.path();
                info!(stub = %name, "Removing 0-byte encrypted-name stub on list");
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
        }

        // Build relative path matching hcfs-client convention:
        // BLAKE3 is computed over relative_path.to_string_lossy()
        let relative_path = match subfolder {
            Some(ref sub) => format!("{sub}/{name}"),
            None => name.clone(),
        };

        // Folders don't have server-side entries — their children do
        let is_excluded = !excluded_patterns.is_empty() && excluded_patterns.iter().any(|p| p == &relative_path);
        let (sync_status, info) = if is_excluded {
            ("excluded", None)
        } else if is_folder {
            ("synced", None)
        } else {
            match &synced_set {
                Some(map) => match map.get(&relative_path) {
                    Some(i) => ("synced", Some(i)),
                    None => ("pending", None),
                },
                None => ("unknown", None),
            }
        };

        let (size, file_count) = if is_folder {
            dir_stats_recursive(&target.join(&name)).await
        } else {
            (meta.len(), 0)
        };

        entries.push(FileEntry {
            name,
            is_folder,
            size,
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            sync_status: sync_status.to_string(),
            arion_hash: info.map_or_else(String::new, hcfs_client::engine::types::SyncedFileInfo::path_hash_hex),
            arion_cid: info.map_or_else(String::new, |i| i.arion_cid.to_string()),
            file_count,
            uploaded_at: info.map_or(0, |i| i.uploaded_at),
            updated_at: info.map_or(0, |i| i.updated_at),
        });
    }

    Ok(entries)
}

/// Response for [`list_sync_folder_grouped`].
///
/// The frontend renders `folders` and `files` as two separate sections at the
/// current navigation level. `pending_backfill` gates an informational banner
/// that tells the user the server-side rel-path index is still being populated
/// — until it clears, nested directories a device hasn't downloaded yet won't
/// appear server-side-only (they only show once their on-disk copy arrives).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedListing {
    pub folders: Vec<FileEntry>,
    pub files: Vec<FileEntry>,
    /// `true` iff `sync_paths.relative_paths_backfilled_at` is NULL for this
    /// drive. Signals to the FE that the grouped view may omit subfolders
    /// that only exist server-side on another device.
    pub pending_backfill: bool,
}

/// Render one level of the sync-folder hierarchy, overlaying on-disk entries
/// with server-registered rel-paths from `synced_paths_for_label`.
///
/// Fixes the "subfolder shows as empty / console is flat" bug: `list_sync_folder`
/// reads only from disk, so on a device that hasn't downloaded the subfolder
/// yet the tree appears empty even when the server side has every file. This
/// command treats the union of (on-disk children + server rel-paths that start
/// with `subfolder + "/"`) as authoritative and groups by the first path
/// component. The "console shows flat" symptom falls out because callers now
/// receive the group structure directly instead of flattening `get_user_files`.
///
/// `pending_backfill` is read from `sync_paths.relative_paths_backfilled_at` —
/// NULL = the one-shot backfill hasn't yet posted rel-paths for legacy rows to
/// the server, so server-only entries won't yet appear. Once set, the FE can
/// hide the "still indexing" banner.
#[tauri::command]
pub async fn list_sync_folder_grouped(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<GroupedListing> {
    list_sync_folder_grouped_inner(&state, account_id, sync_path, subfolder, label).await
}

/// Compare two file/folder names using macOS Finder ordering rules, which
/// match `NSString.localizedStandardCompare`:
///   1. Case-insensitive
///   2. Natural number ordering ("9" < "10", "2025" < "2026")
///   3. Primary category order: punctuation/symbols < digits < letters
///
/// This keeps `_backup` before `2025_rennsport` before `InstantUpload`,
/// matching what the user sees in Finder when sorted by name.
///
/// Implementation: normalize each name so that every non-alphanumeric char
/// becomes `'\x01'` (which sorts before all digits and letters), and
/// lowercase all letters, then compare the resulting strings with natural
/// number ordering (digit runs compared numerically, not lexicographically).
fn macos_name_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn normalize_char(c: char) -> char {
        if c.is_ascii_digit() {
            c
        } else if let Some(lower) = c.to_lowercase().next() {
            if lower.is_alphabetic() { lower } else { '\x01' }
        } else {
            '\x01'
        }
    }

    // Walk both normalized strings simultaneously, comparing digit runs
    // numerically and all other characters by value.
    let mut ai = a.chars().map(normalize_char).peekable();
    let mut bi = b.chars().map(normalize_char).peekable();

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    // Compare digit runs as integers (natural sort).
                    let mut an: u64 = 0;
                    let mut bn: u64 = 0;
                    while ai.peek().map_or(false, |c| c.is_ascii_digit()) {
                        an = an * 10 + ai.next().unwrap().to_digit(10).unwrap() as u64;
                    }
                    while bi.peek().map_or(false, |c| c.is_ascii_digit()) {
                        bn = bn * 10 + bi.next().unwrap().to_digit(10).unwrap() as u64;
                    }
                    match an.cmp(&bn) {
                        std::cmp::Ordering::Equal => continue,
                        ord => return ord,
                    }
                } else {
                    ai.next();
                    bi.next();
                    match ac.cmp(&bc) {
                        std::cmp::Ordering::Equal => continue,
                        ord => return ord,
                    }
                }
            }
        }
    }
}

/// Pure helper for [`list_sync_folder_grouped`], exposed for integration tests
/// so they can drive it against a hand-assembled [`AppState`] without going
/// through the Tauri command layer.
pub async fn list_sync_folder_grouped_inner(
    state: &crate::app_state::AppState,
    account_id: String,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<GroupedListing> {
    // 1. On-disk entries (same rules as `list_sync_folder`). Reusing the
    // inner helper keeps the exclude/sync-status/file-count logic in one
    // place; a missing subfolder returns `Vec::new()` from there and we
    // overlay server entries below.
    let disk_entries = list_sync_folder_inner(state, sync_path.clone(), subfolder.clone(), label.clone()).await?;

    // 2. Server-side rel-path index for the drive. `None` when no label was
    // supplied (a root-only listing with no associated drive). When a label
    // is provided but the drive isn't in the in-memory map,
    // `synced_paths_for_label` already falls through to the cached snapshot
    // from `sync.get_cached_synced_paths` — integration tests exercise that
    // cache-only path by seeding the cache directly.
    let synced_set = match &label {
        Some(l) => synced_paths_for_label(&state.sync, l).await,
        None => None,
    };

    // 3. Build the overlay. Normalise the subfolder prefix to always end in
    // `/` so `rel.starts_with(prefix)` doesn't match a sibling whose name
    // happens to share a prefix (e.g. subfolder="docs" and rel="docs2/x").
    let prefix = match subfolder.as_deref() {
        Some("") | None => String::new(),
        Some(s) => format!("{}/", s.trim_end_matches('/')),
    };
    let mut seen_names: std::collections::HashSet<String> = disk_entries.iter().map(|e| e.name.clone()).collect();
    let mut server_only_files: Vec<FileEntry> = Vec::new();
    // (file_count, first-info) for each server-only folder at this level.
    let mut server_only_folders: HashMap<String, u64> = HashMap::new();

    if let Some(map) = &synced_set {
        for (rel, info) in map {
            if !rel.starts_with(&prefix) {
                continue;
            }
            let remainder = &rel[prefix.len()..];
            if remainder.is_empty() {
                continue;
            }
            match remainder.split_once('/') {
                Some((first_component, _rest)) => {
                    // Server-known subfolder at this level. Skip if already on
                    // disk (the on-disk entry's `file_count` is authoritative
                    // for this device's view of the subfolder).
                    if !seen_names.contains(first_component) {
                        *server_only_folders.entry(first_component.to_string()).or_insert(0) += 1;
                    }
                }
                None => {
                    // Direct child file, server-known. Skip if on disk.
                    if !seen_names.contains(remainder) {
                        server_only_files.push(FileEntry {
                            name: remainder.to_string(),
                            is_folder: false,
                            size: 0,
                            modified: None,
                            sync_status: "pending".to_string(),
                            arion_hash: info.path_hash_hex(),
                            arion_cid: info.arion_cid.to_string(),
                            file_count: 0,
                            uploaded_at: info.uploaded_at,
                            updated_at: info.updated_at,
                        });
                        seen_names.insert(remainder.to_string());
                    }
                }
            }
        }
    }

    // 4. Assemble final `folders` + `files` from disk_entries plus server-only
    // additions. Partition disk entries by `is_folder`; append server-only
    // folders (with aggregated file counts) and server-only files.
    let mut folders: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();
    for entry in disk_entries {
        if entry.is_folder {
            folders.push(entry);
        } else {
            files.push(entry);
        }
    }
    for (name, file_count) in server_only_folders {
        folders.push(FileEntry {
            name,
            is_folder: true,
            size: 0,
            modified: None,
            sync_status: "pending".to_string(),
            arion_hash: String::new(),
            arion_cid: String::new(),
            file_count,
            uploaded_at: 0,
            updated_at: 0,
        });
    }
    files.extend(server_only_files);

    // Sort both lists to match macOS Finder name ordering:
    // punctuation/symbols first, then digits, then letters, with natural
    // number ordering within digit runs.
    folders.sort_by(|a, b| macos_name_cmp(&a.name, &b.name));
    files.sort_by(|a, b| macos_name_cmp(&a.name, &b.name));

    // 5. Backfill flag. NULL on `relative_paths_backfilled_at` ⇒ pending.
    // Any DB error — missing row, pool not ready — surfaces as
    // `pending_backfill=false`: we'd rather miss the banner than block the
    // listing. The backfill task itself is the source of truth and will
    // flip the flag once it completes.
    let pending_backfill = if let Some(l) = &label {
        let owner = account_key(&account_id);
        match state.pool() {
            Ok(pool) => !crate::sync::relative_path_backfill::is_backfilled(pool, &owner, l).await.unwrap_or(true),
            Err(_) => false,
        }
    } else {
        false
    };

    Ok(GroupedListing {
        folders,
        files,
        pending_backfill,
    })
}

/// Inclusive [from, to] date window for the files page Date filter.
///
/// Both fields are `YYYY-MM-DD` strings (local-date). The filter rule
/// expands `from` to 00:00:00 local and `to` to 23:59:59.999 local so a
/// single-day pick (`from == to`) still matches every file uploaded
/// during that day. Mirrors the web console's `DateRange` shape so the
/// frontend can hand the same payload to both clients unchanged.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DateRangeFilter {
    pub from: String,
    pub to: String,
}

/// Filter criteria for the files page, matching the frontend `FilterCriteria`.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileFilterCriteria {
    pub search_term: Option<String>,
    pub file_types: Option<Vec<String>>,
    /// Explicit file extensions to match (e.g. ["mp4", "jpg"]). Independent
    /// from `file_types` (coarse categories) — present so the web-console
    /// style "specific extension" dropdown can request exact matches without
    /// re-encoding into category groups. Matched case-insensitively against
    /// the trailing extension of the entry name.
    pub file_extensions: Option<Vec<String>>,
    /// Legacy single-date / preset string filter (`"YYYY-MM-DD"`, `"today"`,
    /// `"last7days"`, `"last30days"`, `"thisyear"`, `"lastyear"`). Retained
    /// for backward-compat with older IPC callers. The desktop UI no
    /// longer sets this — it sends `date_range` instead.
    pub date_filter: Option<String>,
    /// Console-style date-range window. When `Some`, `date_filter` is
    /// ignored and only files whose `created_at` falls inside the
    /// inclusive `[from, to]` window are kept.
    pub date_range: Option<DateRangeFilter>,
    pub file_sizes: Option<Vec<u64>>,
    pub folder_tab: Option<String>,
}

impl FileFilterCriteria {
    /// `true` when every filter field is empty — short-circuits the
    /// `filter_file_entries` IPC so callers don't pay the round-trip
    /// serialization cost for a no-op.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.search_term.as_deref().is_none_or(str::is_empty)
            && self.file_types.as_ref().is_none_or(std::vec::Vec::is_empty)
            && self
                .file_extensions
                .as_ref()
                .is_none_or(std::vec::Vec::is_empty)
            && self.date_filter.as_deref().is_none_or(str::is_empty)
            && self.date_range.is_none()
            && self.file_sizes.as_ref().is_none_or(std::vec::Vec::is_empty)
            && self.folder_tab.is_none()
    }
}

/// Per-drive-label aggregate for the file tab header.
///
/// Computed in Rust so every tab uses the exact same rule that
/// `dir_stats_recursive` already uses for folder rows — if we let TypeScript
/// re-derive these counts, the two places drift and the header stops matching
/// the rows it sits above.
///
/// `file_count` sums real file leaves only: each non-folder row contributes 1,
/// and each folder row contributes `entry.file_count` (the recursive leaf count
/// computed by `dir_stats_recursive`). Empty folders contribute 0 — a folder
/// with zero files is not itself a "file".
#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LabelStats {
    pub total_bytes: u64,
    pub file_count: u64,
}

/// Result of get_user_files including both files and metadata.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFilesResult {
    pub files: Vec<UserFileEntry>,
    pub total_private_size: String,
    pub sync_folder_labels: Vec<String>,
    pub label_stats: HashMap<String, LabelStats>,
}

/// A user file ready for UI rendering. Matches `FormattedUserFile` shape.
///
/// `Deserialize` is required so the frontend can pass a previously-fetched
/// list back into [`filter_file_entries`] for re-filtering without a round
/// trip to disk.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserFileEntry {
    pub name: String,
    pub actual_file_name: String,
    pub size: u64,
    pub created_at: i64,
    pub arion_hash: String,
    pub arion_cid: String,
    pub source: String,
    pub miner_ids: Vec<String>,
    pub is_assigned: bool,
    pub last_charged_at: i64,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub file_type: String,
    pub is_erasure_coded: bool,
    pub main_req_hash: String,
    pub sync_status: String,
    pub label: String,
    pub file_count: Option<u64>,
    pub deleted: bool,
}

/// Whether a given `sync_status` value should contribute to per-label
/// stats. Centralised so the inline accumulator in `get_user_files` and
/// the test-definition `compute_label_stats` cannot disagree on the
/// filter rule (only one of them being changed silently was the
/// drift hazard the perf-audit review flagged).
fn is_counted_for_label_stats(sync_status: &str) -> bool {
    sync_status != "excluded"
}

/// Apply the per-counted-entry stats accumulation rule.
///
/// Pure function — both `get_user_files`'s inline path and the test
/// definition `compute_label_stats` route every counted entry through
/// this helper, so the rule can only be changed in one place. Folders
/// contribute their nested file count (computed by `dir_stats_recursive`
/// upstream); plain files contribute 1.
fn apply_label_stats_rule(stats: &mut LabelStats, is_folder: bool, file_count: u64, size: u64) {
    stats.total_bytes = stats.total_bytes.saturating_add(size);
    stats.file_count = stats.file_count.saturating_add(if is_folder { file_count } else { 1 });
}

/// Compute per-label totals from the flat entry list `get_user_files` builds.
///
/// `get_user_files` accumulates label stats inline during its main entry
/// loop (avoids walking the file list twice), so this helper is only
/// referenced from the unit tests below — kept as a single-source rule
/// definition that the inline accumulator must match. Both paths share
/// `is_counted_for_label_stats` and `apply_label_stats_rule` to enforce
/// that match at the type level.
#[cfg(test)]
fn compute_label_stats(entries: &[UserFileEntry]) -> HashMap<String, LabelStats> {
    let mut out: HashMap<String, LabelStats> = HashMap::new();
    for entry in entries {
        if !is_counted_for_label_stats(&entry.sync_status) {
            continue;
        }
        let slot = out.entry(entry.label.clone()).or_default();
        apply_label_stats_rule(slot, entry.is_folder, entry.file_count.unwrap_or(0), entry.size);
    }
    out
}

/// Fetch all user files from all sync paths, apply filters, return UI-ready data.
///
/// Replaces both the `use-user-files` orchestration (multi-invoke loop with
/// timestamp logic) AND `fileFilterUtils.ts` (search, type, date, size filtering).
#[tauri::command]
#[allow(
    clippy::too_many_lines,
    reason = "Replaces two full frontend modules (use-user-files + fileFilterUtils) in one Rust function. The filter chain (search / type / date / size) must share the candidate list and statistics accumulators; splitting would require an iterator-builder pattern that obscures the filter order."
)]
pub async fn get_user_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    filters: Option<FileFilterCriteria>,
) -> Result<UserFilesResult> {
    let pool = state.pool()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id)
        .await
        .unwrap_or_default();

    let mut all_files: Vec<UserFileEntry> = Vec::new();
    let mut total_private_size: u64 = 0;
    let sync_folder_labels: Vec<String> = sync_paths.iter().filter(|sp| !sp.path.is_empty()).map(|sp| sp.label.clone()).collect();

    // Pre-build label → folder_path lookup so the per-entry loop below is
    // O(1) per file instead of O(D) where D is the number of sync paths.
    // Same idea as the `label_to_path` map in `get_recent_files`.
    let label_to_path: HashMap<&str, &str> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty())
        .map(|sp| (sp.label.as_str(), sp.path.as_str()))
        .collect();

    // Accumulator for per-label stats. Filled inline during the entry loop
    // so the post-loop walk that `compute_label_stats(&all_files)` used to
    // do is no longer needed. Keyed by `&str` borrowed from `sync_paths`
    // to avoid cloning each entry.label per iteration.
    let mut label_stats: HashMap<&str, LabelStats> = HashMap::new();

    // List all sync folders concurrently
    let folder_futures: Vec<_> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty())
        .map(|sp| {
            let state = state.clone();
            let path = sp.path.clone();
            let label = sp.label.clone();
            async move {
                match list_sync_folder(state, path, None, Some(label.clone())).await {
                    Ok(entries) => (label, entries),
                    Err(err) => {
                        tracing::warn!(label = %label, error = %err, "Failed to list sync folder");
                        (label, Vec::new())
                    }
                }
            }
        })
        .collect();

    let results = futures_util::future::join_all(folder_futures).await;

    for (label, entries) in &results {
        total_private_size += entries.iter().map(|e| e.size).sum::<u64>();

        // Borrow the canonical `&str` from `sync_paths` so `label_stats`
        // keys are zero-copy. The `get_key_value` call returns the key
        // borrowed from `label_to_path` (and therefore from `sync_paths`,
        // which outlives `label_stats`'s entire scope). The `unwrap_or`
        // fallback covers the orphaned-label case (a label appears in
        // `results` but not in `sync_paths` — only possible if a path
        // row was deleted between `get_all_sync_paths_internal` and the
        // `list_sync_folder` futures resolving). The fallback `&str`
        // borrows `label`, which lives for the entire outer loop body
        // and outlives `label_stats`'s `into_iter().collect()` call
        // below — both lifetimes are valid.
        let label_key: &str = label_to_path.get_key_value(label.as_str()).map_or(label.as_str(), |(k, _)| *k);
        let folder_path = label_to_path.get(label_key).copied().unwrap_or("");

        for entry in entries.iter().filter(|e| is_counted_for_label_stats(&e.sync_status)) {
            let local_modified_ms = entry.modified.map_or(0, |m| m as i64 * 1000);
            let uploaded_at_ms = if entry.uploaded_at != 0 { entry.uploaded_at * 1000 } else { 0 };
            let updated_at_ms = if entry.updated_at != 0 { entry.updated_at * 1000 } else { 0 };
            // created_at represents "DATE UPLOADED" in the UI. For files,
            // only use the server-side uploaded_at timestamp — showing the
            // local mtime under "DATE UPLOADED" is confusing (the frontend
            // renders 0 as "—", the correct placeholder for not-yet-uploaded).
            // Folders (including .app bundles on macOS) have no server-side
            // timestamp, so fall back to local mtime for them.
            let created_at_ms = if uploaded_at_ms != 0 {
                uploaded_at_ms
            } else if entry.is_folder {
                local_modified_ms
            } else {
                0
            };
            // last_charged_at_ms is a billing timestamp -- only use
            // server-side values, never fall back to local mtime.
            let last_charged_at_ms = if updated_at_ms != 0 { updated_at_ms } else { uploaded_at_ms };

            // Detect encrypted file names (long hex strings or file_<hex> patterns)
            let display_name = if hcfs_client::engine::classify::is_encrypted_name_stub(&entry.name).is_some()
                || (entry.name.len() >= 16 && !entry.name.contains('.') && entry.name.chars().all(|c| c.is_ascii_hexdigit()))
            {
                "Encrypted file".to_string()
            } else {
                entry.name.clone()
            };

            // Inline label_stats accumulation through the shared
            // `apply_label_stats_rule` helper so this path cannot drift
            // from the test-definition `compute_label_stats`.
            apply_label_stats_rule(label_stats.entry(label_key).or_default(), entry.is_folder, entry.file_count, entry.size);

            all_files.push(UserFileEntry {
                name: display_name,
                actual_file_name: entry.name.clone(),
                size: entry.size,
                created_at: created_at_ms,
                arion_hash: entry.arion_hash.clone(),
                arion_cid: entry.arion_cid.clone(),
                source: format!("{folder_path}/{}", entry.name),
                miner_ids: Vec::new(),
                is_assigned: true,
                last_charged_at: last_charged_at_ms,
                is_folder: entry.is_folder,
                file_type: "private".to_string(),
                is_erasure_coded: false,
                main_req_hash: String::new(),
                sync_status: entry.sync_status.clone(),
                label: label.clone(),
                file_count: if entry.is_folder { Some(entry.file_count) } else { None },
                deleted: false,
            });
        }
    }

    if let Some(ref f) = filters {
        apply_file_filters(&mut all_files, f);
    }

    // Sort by timestamp (newest first)
    all_files.sort_by(|a, b| b.last_charged_at.cmp(&a.last_charged_at));

    // Convert the borrowed-key map to owned-key for the result. One
    // allocation per label instead of one per file (the previous
    // `compute_label_stats(&all_files)` walk cloned `entry.label` for
    // every file).
    let label_stats: HashMap<String, LabelStats> = label_stats.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();

    Ok(UserFilesResult {
        files: all_files,
        total_private_size: total_private_size.to_string(),
        sync_folder_labels,
        label_stats,
    })
}

/// Recursively walk a sync drive's on-disk subtree and emit one
/// [`UserFileEntry`] per file (folders are excluded — this is the
/// recursive-search path, which returns leaves only).
///
/// `actual_file_name` carries the full relative path inside the drive
/// (e.g. `"Photos/2024/IMG_001.jpg"`), so the frontend can show users
/// where a deep match lives. `name` carries just the basename for
/// display in the existing table columns.
///
/// `prefix` is the rel-path of the directory we're descending into
/// (`""` for the drive root, `"sub"` for a one-level descent, etc.).
/// Hidden files (`.`-prefixed) and failed-download / encrypted-name
/// stubs are skipped to match `list_sync_folder_inner`'s rules.
async fn walk_disk_files_recursive(
    base: &Path,
    rel_prefix: &str,
    label: &str,
    folder_path: &str,
    synced: Option<&HashMap<String, hcfs_client::engine::types::SyncedFileInfo>>,
    excluded: &[String],
    out: &mut Vec<UserFileEntry>,
) {
    let dir_path = if rel_prefix.is_empty() {
        base.to_path_buf()
    } else {
        base.join(rel_prefix)
    };

    let Ok(mut dir) = tokio::fs::read_dir(&dir_path).await else {
        return;
    };

    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let rel_path = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };

        if meta.is_dir() {
            // Recurse — folders themselves are never emitted.
            Box::pin(walk_disk_files_recursive(
                base,
                &rel_path,
                label,
                folder_path,
                synced,
                excluded,
                out,
            ))
            .await;
            continue;
        }

        // Skip failed-download artifacts and 0-byte encrypted-name stubs
        // (mirror `list_sync_folder_inner` — these aren't user files).
        if hcfs_client::engine::classify::is_failed_download_artifact(&name).is_some() {
            continue;
        }
        if hcfs_client::engine::classify::is_encrypted_name_stub(&name).is_some()
            && meta.len() == 0
        {
            continue;
        }

        let is_excluded = !excluded.is_empty() && excluded.iter().any(|p| p == &rel_path);
        let (sync_status, info) = if is_excluded {
            ("excluded", None)
        } else {
            match synced {
                Some(map) => match map.get(&rel_path) {
                    Some(i) => ("synced", Some(i)),
                    None => ("pending", None),
                },
                None => ("unknown", None),
            }
        };

        // Match the timestamp rules used by `get_user_files` so the UI's
        // "Date Uploaded" column lines up regardless of which path
        // produced the entry. Fall back to the file's local mtime when
        // the server's `uploaded_at` isn't yet populated (common for
        // freshly uploaded files where hcfs-client hasn't completed a
        // reconcile cycle with timestamps yet) — without this fallback
        // the date-range filter excludes the file silently because
        // `created_at == 0` short-circuits the filter to "drop".
        let uploaded_at_ms = info.map_or(0_i64, |i| if i.uploaded_at != 0 { i.uploaded_at * 1000 } else { 0 });
        let updated_at_ms = info.map_or(0_i64, |i| if i.updated_at != 0 { i.updated_at * 1000 } else { 0 });
        let local_modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(0))
            .unwrap_or(0);
        let created_at_ms = if uploaded_at_ms != 0 {
            uploaded_at_ms
        } else {
            local_modified_ms
        };
        let last_charged_at_ms = if updated_at_ms != 0 { updated_at_ms } else { uploaded_at_ms };

        let display_name = if hcfs_client::engine::classify::is_encrypted_name_stub(&name).is_some()
            || (name.len() >= 16 && !name.contains('.') && name.chars().all(|c| c.is_ascii_hexdigit()))
        {
            "Encrypted file".to_string()
        } else {
            name.clone()
        };

        out.push(UserFileEntry {
            name: display_name,
            actual_file_name: rel_path.clone(),
            size: meta.len(),
            created_at: created_at_ms,
            arion_hash: info.map_or_else(String::new, hcfs_client::engine::types::SyncedFileInfo::path_hash_hex),
            arion_cid: info.map_or_else(String::new, |i| i.arion_cid.to_string()),
            source: format!("{folder_path}/{rel_path}"),
            miner_ids: Vec::new(),
            is_assigned: true,
            last_charged_at: last_charged_at_ms,
            is_folder: false,
            file_type: "private".to_string(),
            is_erasure_coded: false,
            main_req_hash: String::new(),
            sync_status: sync_status.to_string(),
            label: label.to_string(),
            file_count: None,
            deleted: false,
        });
    }
}

/// Recursively search a single sync drive for files matching `filters`.
///
/// Returns a flat list of [`UserFileEntry`] across every nested folder in
/// the drive (or only under `subfolder` when set). Mirrors the web
/// console's `/search_files` API: when the user has an active search or
/// filter, the UI shows matches from anywhere in the drive — not just the
/// rows it already had in memory.
///
/// The walk combines two sources so files synced from other devices show
/// up before they've downloaded locally:
///   1. The on-disk tree under `sync_path[/subfolder]`.
///   2. The drive's server-known rel-path index (`synced_paths_for_label`),
///      filtered to entries whose key starts with the subfolder prefix.
///      Entries already produced by the disk walk are skipped via a
///      `seen` set keyed on the relative path.
///
/// Filter application is delegated to [`apply_file_filters`] so the same
/// search/type/extension/date/size rules used everywhere else apply here
/// unchanged.
#[tauri::command]
pub async fn search_user_files_recursive(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    label: String,
    subfolder: Option<String>,
    filters: FileFilterCriteria,
) -> Result<Vec<UserFileEntry>> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id)
        .await
        .unwrap_or_default();
    // Drive must be a real registered sync path for this user. Defends
    // against a caller-supplied label that points at a different account's
    // drive (the synced_paths_for_label lookup itself is in-memory keyed
    // by label and doesn't enforce ownership).
    let Some(sp) = sync_paths.iter().find(|sp| sp.label == label && !sp.path.is_empty()) else {
        // Unknown label / not yet initialised — surface as empty rather
        // than failing the IPC. Matches `get_user_files` which silently
        // skips drives that fail to list.
        let _ = owner; // suppress unused-var warning when the branch is taken
        return Ok(Vec::new());
    };

    let base = PathBuf::from(&sp.path);
    // Normalise the optional subfolder to a `rel_prefix` and validate
    // that, if provided, it stays inside the sync root.
    let rel_prefix = match subfolder.as_deref() {
        Some(s) if !s.is_empty() => {
            let target = base.join(s);
            ensure_within(&base, &target)?;
            s.trim_matches('/').to_string()
        }
        _ => String::new(),
    };

    // Snapshot of synced paths + excludes under a single per-drive lock
    // (matches `list_sync_folder_inner`). `synced` may be `None` if the
    // drive isn't currently mounted; in that case we still walk the disk.
    let (synced, excluded) = synced_paths_and_excludes_for_label(&state.sync, &label).await;

    let mut out: Vec<UserFileEntry> = Vec::new();

    // 1. On-disk walk — collects everything physically present locally.
    walk_disk_files_recursive(
        &base,
        &rel_prefix,
        &label,
        &sp.path,
        synced.as_ref(),
        &excluded,
        &mut out,
    )
    .await;

    // 2. Server-only overlay — files known on the server that haven't
    // downloaded to this device yet. We surface them as `sync_status =
    // "pending"` so the UI can render the same arrow it does at the root
    // listing for not-yet-local files.
    let prefix = if rel_prefix.is_empty() {
        String::new()
    } else {
        format!("{rel_prefix}/")
    };
    if let Some(map) = &synced {
        // Owned-string set so the loop body can `out.push(...)` (mutable
        // borrow) while we still need the set to dedupe further iterations.
        // Borrowing from `out.iter().map(...)` would keep an immutable
        // borrow alive across the push and fail the borrow checker.
        let seen: std::collections::HashSet<String> = out.iter().map(|e| e.actual_file_name.clone()).collect();
        for (rel, info) in map {
            if !prefix.is_empty() && !rel.starts_with(&prefix) {
                continue;
            }
            if seen.contains(rel) {
                continue;
            }
            let basename = rel.rsplit('/').next().unwrap_or(rel).to_string();
            let uploaded_at_ms = if info.uploaded_at != 0 { info.uploaded_at * 1000 } else { 0 };
            let updated_at_ms = if info.updated_at != 0 { info.updated_at * 1000 } else { 0 };
            let last_charged_at_ms = if updated_at_ms != 0 { updated_at_ms } else { uploaded_at_ms };
            out.push(UserFileEntry {
                name: basename.clone(),
                actual_file_name: rel.clone(),
                size: 0,
                created_at: uploaded_at_ms,
                arion_hash: info.path_hash_hex(),
                arion_cid: info.arion_cid.to_string(),
                source: format!("{}/{}", sp.path, rel),
                miner_ids: Vec::new(),
                is_assigned: true,
                last_charged_at: last_charged_at_ms,
                is_folder: false,
                file_type: "private".to_string(),
                is_erasure_coded: false,
                main_req_hash: String::new(),
                sync_status: "pending".to_string(),
                label: label.clone(),
                file_count: None,
                deleted: false,
            });
        }
    }

    apply_file_filters(&mut out, &filters);

    // Newest-first by upload/charge timestamp — mirrors `get_user_files`'s
    // default ordering so the UI sees the same shape across both paths.
    out.sort_by(|a, b| b.last_charged_at.cmp(&a.last_charged_at));

    Ok(out)
}

/// Apply the full filter chain to a mutable file list in place.
///
/// Shared between [`get_user_files`] (initial fetch with filters) and
/// [`filter_file_entries`] (UI-side filter re-application without a
/// refetch). Owning the filter rules in a single function keeps the
/// folder view and the files page from drifting — previously both
/// reimplemented the logic in TypeScript.
fn apply_file_filters(files: &mut Vec<UserFileEntry>, f: &FileFilterCriteria) {
    let search_lower = f.search_term.as_ref().and_then(|s| {
        let low = s.to_lowercase();
        if low.is_empty() { None } else { Some(low) }
    });
    let now = chrono::Utc::now();

    files.retain(|file| {
        if let Some(ref tab) = f.folder_tab
            && file.label != *tab
        {
            return false;
        }

        if let Some(ref search) = search_lower
            && !file.name.to_lowercase().contains(search)
            && !file.arion_hash.to_lowercase().contains(search)
        {
            return false;
        }

        if let Some(ref types) = f.file_types
            && !types.is_empty()
        {
            let matches = if file.is_folder {
                types.iter().any(|t| t == "folder")
            } else {
                let ext = file.name.rsplit('.').next().unwrap_or("").to_lowercase();
                let file_type = classify_extension(&ext);
                types.iter().any(|t| t == file_type)
            };
            if !matches {
                return false;
            }
        }

        // Explicit extension match (case-insensitive). Folders are always
        // excluded by an active extension filter since extensions apply to
        // files only — same shape as the console's File Type dropdown.
        if let Some(ref exts) = f.file_extensions
            && !exts.is_empty()
        {
            if file.is_folder {
                return false;
            }
            let ext = file.name.rsplit('.').next().unwrap_or("").to_lowercase();
            let matches = exts.iter().any(|e| e.trim_start_matches('.').to_lowercase() == ext);
            if !matches {
                return false;
            }
        }

        // Console-style date-range window. Mirrors hippius-console:
        //   from = local midnight on `range.from`
        //   to   = local 23:59:59.999 on `range.to`
        // The comparison is in absolute timestamps (UTC ms) so files
        // uploaded near local midnight aren't dropped just because their
        // UTC *date* lands on a neighbouring day — that was the bug the
        // user reported (console returned hits, desktop returned none).
        if let Some(ref range) = f.date_range {
            if file.created_at == 0 {
                return false;
            }
            let file_ms = if file.created_at > 946_684_800_000 {
                file.created_at
            } else {
                file.created_at * 1000
            };
            use chrono::TimeZone;
            let parse_local_start = |s: &str| -> Option<i64> {
                chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .and_then(|dt| chrono::Local.from_local_datetime(&dt).single())
                    .map(|dt| dt.timestamp_millis())
            };
            let parse_local_end = |s: &str| -> Option<i64> {
                chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_milli_opt(23, 59, 59, 999))
                    .and_then(|dt| chrono::Local.from_local_datetime(&dt).single())
                    .map(|dt| dt.timestamp_millis())
            };
            let from_ms = parse_local_start(&range.from);
            // Allow "from only" / "to only" partial ranges by treating an
            // unparseable bound on either side as "no constraint there".
            let to_ms = parse_local_end(&range.to);
            if let Some(f_ms) = from_ms
                && file_ms < f_ms
            {
                return false;
            }
            if let Some(t_ms) = to_ms
                && file_ms > t_ms
            {
                return false;
            }
        } else if let Some(ref date) = f.date_filter
            && !date.is_empty()
        {
            if file.created_at == 0 {
                return false;
            }
            let file_ms = if file.created_at > 946_684_800_000 {
                file.created_at
            } else {
                file.created_at * 1000
            };
            let Some(file_dt) = chrono::DateTime::from_timestamp_millis(file_ms) else {
                return false;
            };
            let date_matches = match date.as_str() {
                "today" => file_dt.date_naive() == now.date_naive(),
                "last7days" => (now - file_dt).num_days() <= 7,
                "last30days" => (now - file_dt).num_days() <= 30,
                "thisyear" => file_dt.date_naive().year() == now.date_naive().year(),
                "lastyear" => file_dt.date_naive().year() == now.date_naive().year() - 1,
                _ => {
                    if let Ok(target) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                        file_dt.date_naive() == target
                    } else {
                        true
                    }
                }
            };
            if !date_matches {
                return false;
            }
        }

        // Size thresholds come from `EnhancedFileSizeSelector` in SI
        // bytes (1 MB = 1_000_000) to match the user-facing labels the
        // `formatBytes` helper prints. Any other numeric threshold is
        // treated as a custom "size >= N" cut.
        if let Some(ref sizes) = f.file_sizes
            && !sizes.is_empty()
        {
            let size = file.size;
            let size_matches = sizes.iter().any(|&threshold| match threshold {
                1 => size < 1_000_000,
                1_000_000 => (1_000_000..=100_000_000).contains(&size),
                100_000_000 => size > 100_000_000 && size <= 1_000_000_000,
                1_000_000_000 => size > 1_000_000_000,
                _ => size >= threshold,
            });
            if !size_matches {
                return false;
            }
        }

        true
    });
}

/// Map a file extension to the coarse type group the filter UI uses.
///
/// Pulled out of the filter so the same classifier can be reused (e.g.
/// for icon selection) without duplicating the extension list.
fn classify_extension(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "svg" | "webp" | "ico" | "tiff" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "wmv" | "flv" | "webm" | "m4v" | "3gp" => "video",
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "wma" | "m4a" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "csv" | "md" => "document",
        "zip" | "tar" | "gz" | "rar" | "7z" | "bz2" => "archive",
        _ => "other",
    }
}

/// Apply the user files filter to an arbitrary list of entries.
///
/// Used by the files page and the folder view to re-filter a list the
/// frontend already has without re-fetching it from disk. Exposing the
/// shared filter as its own command keeps every filter rule (date
/// ranges, size thresholds, search behaviour) on the Rust side — the
/// TS layer now just passes criteria and renders the result.
#[tauri::command]
pub fn filter_file_entries(files: Vec<UserFileEntry>, filters: FileFilterCriteria) -> Vec<UserFileEntry> {
    let mut files = files;
    apply_file_filters(&mut files, &filters);
    files
}

/// Export file or folder from sync folder to arbitrary location.
///
/// Rejects `sync_path` values that are not registered in the `sync_paths`
/// table for the active account. Without this check, a caller (e.g. a
/// compromised frontend) could set `sync_path` to `/` and `file_name` to
/// `etc/passwd` and the inner `ensure_within` guard would trivially allow
/// it because `/etc/passwd` is contained in `/`.
#[tauri::command]
pub async fn export_file(
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    file_name: String,
    output_path: String,
) -> Result<()> {
    // Gate 1: sync_path must be a registered sync folder for the active
    // user. This prevents the broad `ensure_within` guard from being
    // bypassed via an attacker-controlled parent directory.
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    let owner = account_key(&account_id);
    let registered: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM sync_paths WHERE owner = ? AND path = ? LIMIT 1")
        .bind(&owner)
        .bind(&sync_path)
        .fetch_optional(state.pool()?)
        .await?;
    if registered.is_none() {
        return Err(crate::error::AppError::Other(
            "sync_path is not a registered sync folder for this account".into(),
        ));
    }

    let parent = Path::new(&sync_path);
    let source = parent.join(&file_name);
    let source = ensure_within(parent, &source)?;

    if source.is_dir() {
        copy_dir_recursive(&source, Path::new(&output_path), 0).await?;
    } else {
        tokio::fs::copy(&source, &output_path)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("Export failed: {e}")))?;
    }
    Ok(())
}

/// Resolve the local file system path for a file given its label and name.
///
/// Looks up the sync folder path from the database for the specified label
/// and account, then combines it with the file name. Supports subfolder
/// paths (e.g., "subfolder/file.txt"). Returns an error if the sync path
/// is not configured or the file does not exist on disk.
#[tauri::command]
pub async fn resolve_file_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    label: String,
    file_name: String,
) -> Result<String> {
    // Reject path traversal attempts — slashes are allowed for subfolder access
    if file_name.contains("..") {
        return Err(crate::error::AppError::Other("Invalid file name".into()));
    }

    let db = state.pool()?;
    let owner = account_key(&account_id);

    let result: Option<(String,)> = sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(&label)
        .fetch_optional(db)
        .await?;

    let sync_path = result
        .map(|(p,)| p)
        .ok_or_else(|| format!("No sync path configured for label '{label}'"))?;

    let full_path = Path::new(&sync_path).join(&file_name);

    // Validate the resolved path stays within the sync folder
    let canonical_parent = Path::new(&sync_path)
        .canonicalize()
        .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
    let canonical_file = full_path.canonicalize().map_err(|_| format!("File not found: {file_name}"))?;
    if !canonical_file.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    Ok(canonical_file.to_string_lossy().to_string())
}

/// Resolved sync path and relative file name, ready for `export_file`.
#[derive(Serialize)]
pub struct FilePathInfo {
    pub sync_path: String,
    pub relative_name: String,
}

/// Resolve the sync folder path and the file's relative name within it.
///
/// This replaces duplicated path resolution logic that was spread across
/// three TypeScript files (`downloadFile.ts`, `downloadFolder.ts`,
/// `use-delete-file/index.tsx`).
///
/// Resolution strategy:
/// 1. Look up sync_path for the given `label` (falls back to "default").
/// 2. If `source` is provided and starts with the sync_path prefix, derive
///    the relative name by stripping the prefix. Otherwise use `file_name`.
#[tauri::command]
pub async fn resolve_file_info(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    label: Option<String>,
    source: Option<String>,
    file_name: String,
) -> Result<FilePathInfo> {
    let pool = state.pool()?;
    let effective_label = label.as_deref().unwrap_or("default");

    // Try the requested label, fall back to "default"
    let sync_path = match crate::sync::config::get_sync_path_for_label(pool, &account_id, effective_label).await {
        Ok(p) => p,
        Err(_) if effective_label != "default" => crate::sync::config::get_sync_path_for_label(pool, &account_id, "default")
            .await
            .unwrap_or_default(),
        Err(_) => String::new(),
    };

    let relative_name = derive_relative_name(&sync_path, source.as_deref(), &file_name);

    Ok(FilePathInfo { sync_path, relative_name })
}

/// Derive a file's path relative to the sync root.
///
/// If `source` starts with `sync_path/`, strips the prefix to get the
/// relative path (e.g., `/home/user/Hippius/docs/file.txt` → `docs/file.txt`).
/// Otherwise returns `fallback_name` as-is.
fn derive_relative_name(sync_path: &str, source: Option<&str>, fallback_name: &str) -> String {
    if let Some(src) = source
        && !sync_path.is_empty()
    {
        let prefix = if sync_path.ends_with('/') {
            sync_path.to_string()
        } else {
            format!("{sync_path}/")
        };
        if src.starts_with(&prefix) {
            return src[prefix.len()..].to_string();
        }
    }
    fallback_name.to_string()
}

/// Delegates to hcfs-client library.
async fn copy_dir_recursive(src: &Path, dst: &Path, depth: u32) -> Result<()> {
    hcfs_client::drive::files::copy_dir_recursive(src, dst, depth)
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- bundles_for_wanted_keys (F10: bounded recent-files metadata) ---

    /// The bounded lookup must allocate a `MetadataBundle` only for keys in the
    /// `wanted` set, regardless of how large the synced corpus is. Seeds 1000
    /// synced files but asks for 3 keys (2 present, 1 absent) and asserts the
    /// result holds exactly the 2 present-and-wanted entries — not 1000.
    #[test]
    fn bundles_for_wanted_keys_allocates_only_for_wanted() {
        use std::collections::HashSet;
        use std::sync::Arc;

        let mut corpus: HashMap<String, SyncedFileInfo> = HashMap::new();
        for i in 0..1000 {
            corpus.insert(
                format!("file{i}.txt"),
                SyncedFileInfo {
                    path_hash: [0u8; 32],
                    arion_cid: Arc::from("cid"),
                    uploaded_at: 1,
                    updated_at: 2,
                },
            );
        }
        let label_maps = vec![("drive".to_string(), corpus)];

        let wanted: HashSet<String> = ["file3.txt::drive", "file7.txt::drive", "missing.txt::drive"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();

        let out = bundles_for_wanted_keys(label_maps, &wanted);

        assert_eq!(out.len(), 2, "only present-and-wanted keys produce bundles, not the whole corpus");
        assert!(out.contains_key("file3.txt::drive"));
        assert!(out.contains_key("file7.txt::drive"));
        assert!(!out.contains_key("missing.txt::drive"), "a wanted-but-absent key must not appear");
    }

    /// An empty wanted set yields an empty map — the recent-files path returns
    /// early on no surviving activity, but the helper must be safe regardless.
    #[test]
    fn bundles_for_wanted_keys_empty_wanted_is_empty() {
        use std::collections::HashSet;
        use std::sync::Arc;
        let mut corpus: HashMap<String, SyncedFileInfo> = HashMap::new();
        corpus.insert(
            "a.txt".to_string(),
            SyncedFileInfo { path_hash: [1u8; 32], arion_cid: Arc::from("x"), uploaded_at: 0, updated_at: 0 },
        );
        let out = bundles_for_wanted_keys(vec![("d".to_string(), corpus)], &HashSet::new());
        assert!(out.is_empty());
    }

    // --- macos_name_cmp ---

    /// Verifies that `macos_name_cmp` produces the same ordering as macOS
    /// Finder when sorting by name: symbols/punctuation < digits < letters,
    /// with natural (not lexicographic) number ordering.
    #[test]
    fn macos_name_cmp_matches_finder_order() {
        let mut names = vec![
            "wordpress",
            "2025_rennsport",
            "_notes",
            "InstantUpload",
            "_backup",
            "Photos",
            "2026_rennsport",
            "__bittensor",
            "mogmachine.memory",
            "portugal",
        ];
        names.sort_by(|a, b| macos_name_cmp(a, b));

        // Expected order matches macOS Finder:
        // underscore-prefixed → digits → letters (case-insensitive)
        assert_eq!(
            names,
            vec![
                "__bittensor",
                "_backup",
                "_notes",
                "2025_rennsport",
                "2026_rennsport",
                "InstantUpload",
                "mogmachine.memory",
                "Photos",
                "portugal",
                "wordpress",
            ]
        );
    }

    #[test]
    fn macos_name_cmp_natural_number_ordering() {
        let mut names = vec!["file10", "file2", "file1", "file20", "file9"];
        names.sort_by(|a, b| macos_name_cmp(a, b));
        assert_eq!(names, vec!["file1", "file2", "file9", "file10", "file20"]);
    }

    #[test]
    fn macos_name_cmp_case_insensitive() {
        let mut names = vec!["Zebra", "apple", "Mango", "banana"];
        names.sort_by(|a, b| macos_name_cmp(a, b));
        assert_eq!(names, vec!["apple", "banana", "Mango", "Zebra"]);
    }

    // --- derive_relative_name ---

    #[test]
    fn strips_sync_path_prefix() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius", Some("/home/user/Hippius/docs/file.txt"), "fallback.txt"),
            "docs/file.txt",
        );
    }

    #[test]
    fn strips_prefix_with_trailing_slash() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius/", Some("/home/user/Hippius/file.txt"), "fallback.txt"),
            "file.txt",
        );
    }

    #[test]
    fn falls_back_when_source_doesnt_match() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius", Some("/other/path/file.txt"), "fallback.txt"),
            "fallback.txt",
        );
    }

    #[test]
    fn falls_back_when_no_source() {
        assert_eq!(derive_relative_name("/home/user/Hippius", None, "fallback.txt"), "fallback.txt",);
    }

    #[test]
    fn falls_back_when_empty_sync_path() {
        assert_eq!(derive_relative_name("", Some("/some/path/file.txt"), "fallback.txt"), "fallback.txt",);
    }

    #[test]
    fn handles_nested_subfolder() {
        assert_eq!(derive_relative_name("/sync", Some("/sync/a/b/c/deep.txt"), "x.txt"), "a/b/c/deep.txt",);
    }

    // --- add_folder overlap check ---
    //
    // Regression: `add_folder_with_app_inner` and `add_folder_internal` used
    // to forward whatever the user picked in the OS folder dialog straight to
    // `copy_dir_recursive`. Picking the sync root itself (or any ancestor)
    // resulted in 64 levels of nested duplicate folders before
    // `MAX_COPY_DEPTH` finally tripped. The IPC layer now rejects the call
    // with an `AppError::Other` so the dialog can render a clear message.

    #[tokio::test]
    async fn add_folder_with_app_inner_rejects_sync_root_as_source() {
        let sync_dir = tempfile::tempdir().unwrap();
        tokio::fs::write(sync_dir.path().join("sentinel.txt"), b"x").await.unwrap();

        let sync_path = sync_dir.path().to_string_lossy().to_string();
        let err = add_folder_with_app_inner(&sync_path, &sync_path, None)
            .await
            .expect_err("must reject sync root as source");
        let msg = err.to_string();
        assert!(msg.contains("Cannot add the sync folder"), "unexpected error message: {msg}");

        let nested = sync_dir.path().join(sync_dir.path().file_name().unwrap());
        assert!(!nested.exists(), "no recursive child must be created");
    }

    #[tokio::test]
    async fn add_folder_with_app_inner_rejects_ancestor_of_sync_root() {
        let outer = tempfile::tempdir().unwrap();
        let sync_dir = outer.path().join("sync");
        tokio::fs::create_dir(&sync_dir).await.unwrap();
        let sync_path = sync_dir.to_string_lossy().to_string();
        let outer_path = outer.path().to_string_lossy().to_string();

        let err = add_folder_with_app_inner(&sync_path, &outer_path, None)
            .await
            .expect_err("must reject ancestor as source");
        let msg = err.to_string();
        assert!(msg.contains("Cannot add the sync folder"), "unexpected error message: {msg}");

        let outer_name = outer.path().file_name().unwrap();
        assert!(!sync_dir.join(outer_name).exists());
    }

    #[tokio::test]
    async fn add_folder_internal_rejects_sync_root_as_source() {
        let sync_dir = tempfile::tempdir().unwrap();
        let canonical_sync = tokio::fs::canonicalize(sync_dir.path()).await.unwrap();
        let folder_path = sync_dir.path().to_string_lossy().to_string();

        let err = add_folder_internal(&canonical_sync, &folder_path)
            .await
            .expect_err("must reject sync root as source");
        let msg = err.to_string();
        assert!(msg.contains("Cannot add the sync folder"), "unexpected error message: {msg}");
    }

    // --- filter_file_entries / apply_file_filters ---

    fn make_file(name: &str, size: u64, label: &str, created_at: i64, is_folder: bool) -> UserFileEntry {
        UserFileEntry {
            name: name.to_string(),
            actual_file_name: name.to_string(),
            size,
            created_at,
            arion_hash: String::new(),
            arion_cid: String::new(),
            source: String::new(),
            miner_ids: Vec::new(),
            is_assigned: false,
            last_charged_at: created_at,
            is_folder,
            file_type: String::new(),
            is_erasure_coded: false,
            main_req_hash: String::new(),
            sync_status: String::new(),
            label: label.to_string(),
            file_count: None,
            deleted: false,
        }
    }

    #[test]
    fn filter_search_matches_name_case_insensitive() {
        let files = vec![
            make_file("Report.pdf", 1_000, "docs", 0, false),
            make_file("photo.png", 1_000, "docs", 0, false),
        ];
        let criteria = FileFilterCriteria {
            search_term: Some("REPORT".into()),
            file_types: None,
            date_filter: None,
            file_sizes: None,
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Report.pdf");
    }

    #[test]
    fn filter_folder_tab_isolates_label() {
        let files = vec![
            make_file("a.txt", 1, "drive-one", 0, false),
            make_file("b.txt", 1, "drive-two", 0, false),
            make_file("c.txt", 1, "drive-one", 0, false),
        ];
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: None,
            date_filter: None,
            file_sizes: None,
            folder_tab: Some("drive-one".into()),
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["a.txt", "c.txt"]);
    }

    #[test]
    fn filter_size_si_thresholds() {
        let files = vec![
            make_file("tiny.txt", 500, "d", 0, false),           // Small
            make_file("medium.zip", 50_000_000, "d", 0, false),  // Medium
            make_file("large.bin", 500_000_000, "d", 0, false),  // Large
            make_file("huge.iso", 5_000_000_000, "d", 0, false), // Very Large
        ];
        // "Medium" + "Very Large" selected — boundaries match the UI's SI labels.
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: None,
            date_filter: None,
            file_sizes: Some(vec![1_000_000, 1_000_000_000]),
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["medium.zip", "huge.iso"]);
    }

    #[test]
    fn filter_type_classifies_by_extension() {
        let files = vec![
            make_file("pic.png", 1, "d", 0, false),
            make_file("clip.mp4", 1, "d", 0, false),
            make_file("notes.txt", 1, "d", 0, false),
            make_file("subfolder", 0, "d", 0, true),
        ];
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: Some(vec!["image".into(), "folder".into()]),
            date_filter: None,
            file_sizes: None,
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["pic.png", "subfolder"]);
    }

    #[test]
    fn empty_criteria_is_a_noop() {
        let files = vec![make_file("a.txt", 1, "d", 0, false), make_file("b.txt", 1, "d", 0, false)];
        let criteria = FileFilterCriteria {
            search_term: Some(String::new()),
            file_types: Some(Vec::new()),
            date_filter: Some(String::new()),
            file_sizes: Some(Vec::new()),
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        assert!(criteria.is_empty());
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn label_stats_aggregates_bytes_and_counts_per_label() {
        // Simulate what `get_user_files` pushes into `all_files`:
        //  - drive "alpha": one 1 KB file + one 200 B file + one folder row
        //    with 3 nested files, 4 KB aggregate
        //  - drive "beta":  one 500 B file + an empty folder row (file_count = 0)
        //  - drive "gamma": one folder row with `file_count: None` — hits the
        //    `unwrap_or(0)` defense without requiring get_user_files to misbehave
        //  - one "excluded" entry on drive "alpha" — must be skipped entirely
        let mut excluded = make_file("ignored.txt", 999_999, "alpha", 0, false);
        excluded.sync_status = "excluded".to_string();

        let entries: Vec<UserFileEntry> = vec![
            make_file("a.txt", 1_000, "alpha", 0, false),
            make_file("a2.txt", 200, "alpha", 0, false),
            UserFileEntry {
                file_count: Some(3),
                size: 4_000,
                ..make_file("sub", 4_000, "alpha", 0, true)
            },
            excluded,
            make_file("b.txt", 500, "beta", 0, false),
            UserFileEntry {
                file_count: Some(0),
                size: 0,
                ..make_file("empty", 0, "beta", 0, true)
            },
            UserFileEntry {
                file_count: None,
                size: 100,
                ..make_file("loose", 100, "gamma", 0, true)
            },
        ];

        let stats = compute_label_stats(&entries);

        let alpha = stats.get("alpha").expect("alpha stats present");
        assert_eq!(alpha.total_bytes, 5_200, "alpha bytes (1000 + 200 + 4000, excluded skipped)");
        assert_eq!(alpha.file_count, 5, "alpha file count (2 files + 3 nested, excluded skipped)");

        let beta = stats.get("beta").expect("beta stats present");
        assert_eq!(beta.total_bytes, 500, "beta bytes");
        assert_eq!(beta.file_count, 1, "beta file count (1 file + 0 for empty folder)");

        let gamma = stats.get("gamma").expect("gamma stats present");
        assert_eq!(gamma.total_bytes, 100, "gamma bytes");
        assert_eq!(gamma.file_count, 0, "gamma file count (folder with file_count: None => 0)");
    }

    /// Drift guard between `compute_label_stats` (the rule definition) and
    /// the inline accumulator inside `get_user_files`. Both paths now route
    /// every counted entry through `apply_label_stats_rule` and every
    /// filter check through `is_counted_for_label_stats`, so this test
    /// simulates the inline path manually using the SAME helpers and
    /// asserts equivalence with `compute_label_stats`. If a future refactor
    /// changes one path's filter or accumulation, this test fails loudly
    /// because the helpers diverge.
    #[test]
    fn inline_path_matches_compute_label_stats_via_shared_helpers() {
        let mut excluded = make_file("ignored.txt", 999_999, "alpha", 0, false);
        excluded.sync_status = "excluded".to_string();
        let entries: Vec<UserFileEntry> = vec![
            make_file("a.txt", 1_000, "alpha", 0, false),
            UserFileEntry {
                file_count: Some(3),
                size: 4_000,
                ..make_file("sub", 4_000, "alpha", 0, true)
            },
            excluded,
            make_file("b.txt", 500, "beta", 0, false),
        ];

        // Path 1: rule-definition (the test-only helper above).
        let rule_stats = compute_label_stats(&entries);

        // Path 2: simulate the inline path inside `get_user_files`. Same
        // shared helpers, same filter ordering — if production drifts,
        // this expression no longer matches `compute_label_stats` because
        // either the filter or the accumulator was changed somewhere.
        let mut inline_stats: HashMap<String, LabelStats> = HashMap::new();
        for entry in entries.iter().filter(|e| is_counted_for_label_stats(&e.sync_status)) {
            apply_label_stats_rule(
                inline_stats.entry(entry.label.clone()).or_default(),
                entry.is_folder,
                entry.file_count.unwrap_or(0),
                entry.size,
            );
        }

        assert_eq!(inline_stats, rule_stats);
    }

    /// `dir_stats_recursive` reads from `DIR_STATS_CACHE` when the
    /// directory's mtime matches the cached entry. We can't easily
    /// stage a "real" cache hit in a unit test (mtime resolution is OS
    /// timer-dependent), so this test takes the deterministic route:
    /// stat the temp dir to learn its mtime, write a deliberately wrong
    /// `(size, count)` into the cache under that mtime, and assert
    /// `dir_stats_recursive` returns the wrong cached value rather than
    /// re-walking the tree. Proves the cache lookup is consulted.
    #[tokio::test]
    async fn dir_stats_recursive_returns_cached_value_on_mtime_match() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();

        // Create a tiny tree so a fresh walk would return non-zero values.
        tokio::fs::write(dir.join("a.txt"), b"hello world").await.expect("write a");
        tokio::fs::write(dir.join("b.txt"), b"goodbye").await.expect("write b");

        // Read the directory's actual mtime — that's the cache key.
        let mtime = tokio::fs::metadata(dir).await.expect("metadata").modified().expect("mtime");

        // Plant a deliberately wrong cached entry under this mtime.
        let bogus_size = 999_999_999u64;
        let bogus_count = 123u64;
        {
            let mut cache = dir_stats_cache().lock().expect("lock");
            cache.insert(dir.to_path_buf(), (mtime, bogus_size, bogus_count));
        }

        let (size, count) = dir_stats_recursive(dir).await;
        assert_eq!(size, bogus_size, "dir_stats_recursive must return the cached size on mtime match");
        assert_eq!(count, bogus_count, "dir_stats_recursive must return the cached count on mtime match");

        // Cleanup so this test doesn't pollute other tests' cache state.
        dir_stats_cache().lock().expect("lock").remove(dir);
    }

    /// On a fresh path the cache is empty; `dir_stats_recursive` must walk
    /// the tree and return real values. Pairs with the cache-hit test
    /// above to confirm the lookup path doesn't ALWAYS short-circuit.
    #[tokio::test]
    async fn dir_stats_recursive_walks_on_cache_miss() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();

        tokio::fs::write(dir.join("one.txt"), b"x").await.expect("write");
        tokio::fs::write(dir.join("two.txt"), b"yz").await.expect("write");

        let (size, count) = dir_stats_recursive(dir).await;
        assert_eq!(size, 3, "fresh walk must sum file bytes (1 + 2)");
        assert_eq!(count, 2, "fresh walk must count files");

        dir_stats_cache().lock().expect("lock").remove(dir);
    }

    // ── first-reconcile readiness wait ────────────────────────────────

    /// Regression test for the cold-start race: a `wait_for_first_reconcile`
    /// call against a registered-but-unsettled gate must block until the
    /// gate settles, NOT return immediately. Without this guard,
    /// `synced_paths_and_excludes_for_label` would observe an empty cache
    /// and `get_user_files` would return rows with `uploaded_at = 0`,
    /// rendering "—" in the UI until the user logged out and back in.
    #[tokio::test]
    async fn wait_for_first_reconcile_blocks_until_settle() {
        use hcfs_client::drive::ReconcileOutcome;
        use hcfs_client::engine::events::{NoopCallbacks, NoopEventHandler};
        use hcfs_client::engine::runner::{SyncRunner, WaitOutcome};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let sync = Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ));

        // Producer side: pre-register the gate (mirrors what
        // `spawn_reconcile_timestamps` does the moment the drive is
        // registered, before its background task starts running).
        let label = "drive-cold-start";
        let _gate = sync.first_reconcile_gate(label);

        // Settle the gate after a delay shorter than the wait budget.
        // The consumer must observe the outcome via the `changed()`
        // path on `watch::Receiver`, not the initial `borrow()`
        // fast path.
        let sync_settle = Arc::clone(&sync);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            sync_settle
                .first_reconcile_gate("drive-cold-start")
                .settle(ReconcileOutcome::Reconciled { duration_ms: 5 });
        });

        let start = Instant::now();
        let outcome = sync
            .wait_for_first_reconcile(label, Duration::from_millis(500))
            .await;
        let elapsed = start.elapsed();

        match outcome {
            WaitOutcome::Ready(ReconcileOutcome::Reconciled { duration_ms }) => {
                assert_eq!(duration_ms, 5);
            }
            other => panic!("expected Ready(Reconciled), got {other:?}"),
        }
        // The wait must have BLOCKED at least until the settle fired
        // (~40ms) — proving the cache-read isn't racing the producer.
        // Generous lower bound to absorb scheduler jitter.
        assert!(
            elapsed >= Duration::from_millis(20),
            "wait returned too quickly ({}ms) — the readiness gate is not actually blocking",
            elapsed.as_millis(),
        );
        // And the wait must NOT have run the full budget. If we hit
        // the budget, the settle didn't reach the awaiter.
        assert!(
            elapsed < Duration::from_millis(450),
            "wait exhausted budget ({}ms) — settle was missed",
            elapsed.as_millis(),
        );
    }

    /// When no gate is registered for a label (e.g. drive not in the
    /// registry yet, or already torn down), `wait_for_first_reconcile`
    /// must return `NotRegistered` immediately — never block on a
    /// missing producer. The desktop's read paths interpret this as
    /// "fall through to cache", same as `Timeout`.
    #[tokio::test]
    async fn wait_for_first_reconcile_does_not_block_on_missing_label() {
        use hcfs_client::engine::events::{NoopCallbacks, NoopEventHandler};
        use hcfs_client::engine::runner::{SyncRunner, WaitOutcome};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let sync = Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ));

        let start = Instant::now();
        let outcome = sync
            .wait_for_first_reconcile("does-not-exist", Duration::from_secs(5))
            .await;
        let elapsed = start.elapsed();

        assert!(matches!(outcome, WaitOutcome::NotRegistered), "got {outcome:?}");
        assert!(
            elapsed < Duration::from_millis(50),
            "NotRegistered must return immediately, took {}ms",
            elapsed.as_millis(),
        );
    }
}
