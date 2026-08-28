//! Adding files and folders to a sync drive (single, batch, and folder).
//!
//! Owns the upload byte/count walkers used by the startup pending summary and
//! the credit gate.

use super::delete::FileDeleteError;
use super::pathops::copy_dir_recursive;
use crate::error::Result;
use hcfs_client::engine::runner::trigger_sync;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

/// Hidden staging sibling for a dest that does not exist yet.
///
/// The live file watcher fires on every write into a watched tree.
/// hcfs-client skips `.*` names in `collect_files`, so a 35 GB copy
/// into `.hippius-incoming-*` is not hashed mid-flight; `rename`
/// then makes the folder visible as a complete tree.
fn incoming_staging_path(dest: &Path) -> PathBuf {
    let parent = dest.parent().unwrap_or(dest);
    let stem = dest.file_name().and_then(|n| n.to_str()).unwrap_or("folder");
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    parent.join(format!(".hippius-incoming-{stem}-{unique}"))
}

/// Copy `source` onto `dest`.
///
/// New dest: copy into a hidden sibling then `rename` into place so the
/// watcher does not scan a growing tree. Existing dest: in-place merge
/// (two uploads of the same folder name).
async fn copy_tree_into_sync_dest(source: &Path, dest: &Path) -> Result<()> {
    if tokio::fs::try_exists(dest).await.unwrap_or(false) {
        return copy_dir_recursive(source, dest, 0).await;
    }
    let staging = incoming_staging_path(dest);
    match copy_dir_recursive(source, &staging, 0).await {
        Ok(()) => match tokio::fs::rename(&staging, dest).await {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                Err(crate::error::AppError::Io(e))
            }
        },
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            Err(e)
        }
    }
}

async fn create_dir_all_spawn(path: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(path))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Join error creating dir: {e}")))??;
    Ok(())
}

/// Pure file-copy implementation, no eligibility check. The check is
/// performed at the IPC boundary by `add_file` (single-file path) or
/// `add_files` (batch path), and the inner helper is called from both
/// without re-checking — see the call sites for the rationale.
///
/// Takes an already-canonicalized parent directory so a batch caller can
/// canonicalize once outside the loop instead of paying the `realpath`
/// syscall per file (10–100 ms each on slow filesystems).
// Error-taxonomy convention for this module: rejected name/path input (bad name,
// traversal, path-escape, self-add) is `Validation` (the FE renders the message);
// filesystem faults (copy / canonicalize / create_dir) are `Io` (#[from], via `?`
// where control flow allows, else `Io(e)` in a cleanup-then-return arm).
async fn add_file_internal(canonical_parent: &Path, file_path: &str) -> Result<String> {
    let source = Path::new(file_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Validation("Invalid file name".into()))?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Validation("Invalid file name".into()));
    }

    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(canonical_parent) {
        return Err(crate::error::AppError::Validation("Path escapes sync folder".into()));
    }

    tokio::fs::copy(source, &canonical_dest).await?;

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
    let account_id = state.current_account_id()?;
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
            return Err(crate::error::AppError::Io(e));
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
    let account_id = state.current_account_id()?;
    // One walk of the source tree for BOTH the credit-gate byte total and the
    // banner file count (previously two separate full traversals). The byte
    // total is a best-effort lower bound on permission-denied subdirs, which
    // under-charges rather than over-charges — the server 402 is the backstop.
    let (bytes, count) = walk_regular_files_stats(Path::new(&folder_path)).await;
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
        .ok_or(crate::error::AppError::Validation("Invalid folder name".into()))?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Validation("Invalid folder name".into()));
    }

    // Resolve target directory (with optional subfolder)
    let sync_root = Path::new(sync_path);
    let target_dir = if let Some(sub) = subfolder {
        // Reject traversal components before creating directories
        if sub.contains("..") {
            return Err(crate::error::AppError::Validation("Subfolder path contains traversal component".into()));
        }
        let t = sync_root.join(sub);
        if !tokio::fs::try_exists(&t).await.unwrap_or(false) {
            create_dir_all_spawn(t.clone()).await?;
        }
        // Verify resolved path is within sync root (async canonicalize so
        // we don't block the tokio worker thread on `realpath`).
        let canonical_root = tokio::fs::canonicalize(sync_root).await?;
        let canonical_target = tokio::fs::canonicalize(&t).await?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(crate::error::AppError::Validation("Subfolder escapes sync folder".into()));
        }
        t
    } else {
        sync_root.to_path_buf()
    };

    // Validate destination is within the sync folder BEFORE writing.
    let canonical_parent = tokio::fs::canonicalize(&target_dir).await?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Validation("Path escapes sync folder".into()));
    }

    // Reject self-/ancestor-source picks at the IPC boundary so the dialog
    // can render a domain-specific message instead of letting `copy_dir_recursive`
    // run 64 levels of self-similar copies before erroring. See the
    // `add_folder_rejects_*` tests in hcfs-client for the bug that motivated
    // this guard.
    let canonical_source = tokio::fs::canonicalize(source).await?;
    if canonical_dest.starts_with(&canonical_source) {
        return Err(crate::error::AppError::Validation(
            "Cannot add the sync folder (or one of its ancestors) to itself".into(),
        ));
    }

    copy_tree_into_sync_dest(source, &canonical_dest).await?;

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
/// Single-pass walk returning `(total_bytes, regular_file_count)` for the tree
/// under `root`. Folder uploads previously walked the identical tree TWICE —
/// once for the credit-gate byte total and once for the banner count — before
/// `copy_dir_recursive` walked it a third time; this collapses the first two
/// into one traversal. Same invariants as [`sum_regular_file_bytes`]: symlinks
/// are not followed, per-subdir I/O errors are skipped, the stack is capped at
/// [`FOLDER_BYTE_WALK_MAX_DEPTH`], and both accumulators use `saturating_add`.
async fn walk_regular_files_stats(root: &std::path::Path) -> (u64, u64) {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || walk_regular_files_stats_std(&root))
        .await
        .unwrap_or((0, 0))
}

/// One `DirEntry::metadata` per entry (lstat-shaped, does not follow
/// symlinks) so we do not pay `file_type` + `metadata` on every file.
fn walk_regular_files_stats_std(root: &std::path::Path) -> (u64, u64) {
    let mut bytes: u64 = 0;
    let mut count: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if stack.len() > FOLDER_BYTE_WALK_MAX_DEPTH {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                count = count.saturating_add(1);
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    (bytes, count)
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
pub(in crate::sync) async fn sum_regular_file_bytes(root: &std::path::Path) -> u64 {
    walk_regular_files_stats(root).await.0
}

/// Stack-depth cap for [`sum_regular_file_bytes`]. Sized to match the
/// 64-level cap that `copy_dir_recursive` already enforces — a folder
/// deeper than this would fail the subsequent copy anyway, so refusing
/// to walk further is consistent with the rest of the module.
const FOLDER_BYTE_WALK_MAX_DEPTH: usize = 4096;

/// Fast, LOCAL "pending upload" summary for a drive at startup: the count and
/// byte total of on-disk files under `sync_root` that are NOT yet in the drive's
/// synced baseline (`sync_state.json` in `folder_dir`).
///
/// Reads the baseline directly off disk and deserializes it — deliberately NOT
/// via the drive manager's `load_sync_state`, which needs the per-drive lock the
/// sync loop grabs at init (we'd lose that race at cold start) and waits on the
/// remote reconcile (the slow window we're front-running). A missing/unreadable
/// baseline yields an EMPTY synced set, so a never-synced drive correctly
/// reports all of its files as pending.
///
/// This is a PROVISIONAL estimate, shown only during the startup "preparing"
/// window: it ignores exclude patterns (rare; a handful of files at most) and
/// the download direction (server-only files are unknowable without a fetch).
/// The authoritative live `ProgressSnapshot` supersedes it the moment the
/// engine's first cycle reaches the FE. The rel-path key is built by joining
/// `Component::Normal` segments with '/' to match hcfs-client's
/// `relative_path.to_string_lossy()` index keys cross-platform.
pub(in crate::sync) async fn compute_startup_pending_summary(folder_dir: &std::path::Path, sync_root: &std::path::Path) -> (u64, u64) {
    let folder_dir = folder_dir.to_path_buf();
    let sync_root = sync_root.to_path_buf();
    tokio::task::spawn_blocking(move || compute_startup_pending_summary_std(&folder_dir, &sync_root))
        .await
        .unwrap_or((0, 0))
}

fn compute_startup_pending_summary_std(folder_dir: &std::path::Path, sync_root: &std::path::Path) -> (u64, u64) {
    // 1. Load the synced baseline (sync_state.json, .bak fallback) → key set.
    let synced: std::collections::HashSet<String> = {
        let raw = std::fs::read_to_string(folder_dir.join("sync_state.json"))
            .ok()
            .or_else(|| std::fs::read_to_string(folder_dir.join("sync_state.json.bak")).ok());
        match raw.and_then(|s| serde_json::from_str::<hcfs_client::sync::SyncState>(&s).ok()) {
            Some(state) => hcfs_client::engine::types::build_synced_paths_from_state(&state).into_keys().collect(),
            None => std::collections::HashSet::new(),
        }
    };

    // 2. Walk on-disk files; count + sum those absent from the synced set.
    let mut files: u64 = 0;
    let mut bytes: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![sync_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if stack.len() > FOLDER_BYTE_WALK_MAX_DEPTH {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            // Mirror hcfs-client's `drive::exclude::should_skip_path` — the rule
            // its real `Drive::collect_files` scan applies: skip the `.hippius`
            // config dir and every hidden entry (name starting with '.'). Those
            // are never uploaded, so they never enter `sync_state.json`; without
            // this skip a macOS `.DS_Store` (never synced) is counted as pending
            // on every launch, painting a spurious "N files · Preparing" the
            // engine then never transfers. `to_str()`-gated so a non-UTF-8 name
            // is NOT skipped — matching upstream exactly. Same local
            // reproduction as `migrate::folder_entries_backfill::is_skipped_dir_name`
            // (upstream `should_skip_path` is `pub(super)`, hence re-derived).
            // Skipping a hidden dir here means its whole subtree is never pushed,
            // so descendants are excluded too — again matching the engine walk.
            if entry.file_name().to_str().is_some_and(|name| name.starts_with('.')) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let path = entry.path();
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let Ok(rel_path) = path.strip_prefix(sync_root) else { continue };
                let rel: String = rel_path
                    .components()
                    .filter_map(|c| match c {
                        std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("/");
                if rel.is_empty() || synced.contains(&rel) {
                    continue;
                }
                files = files.saturating_add(1);
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    (files, bytes)
}

/// Single pass over a heterogeneous batch of paths (a mix of regular files and
/// directories) returning `(total_bytes, regular_file_count)`. Used by
/// `add_files` for both the credit-eligibility byte total and the banner count
/// — previously two separate passes that each walked every directory. Each
/// file is sized via `tokio::fs::metadata`; each directory is walked once via
/// [`walk_regular_files_stats`]. Per-path metadata failures degrade to zero so
/// a missing/unreadable entry doesn't reject the rest of the batch — the copy
/// loop surfaces the real I/O error.
async fn sum_and_count_batch(paths: &[String]) -> (u64, u64) {
    let paths = paths.to_vec();
    tokio::task::spawn_blocking(move || sum_and_count_batch_std(&paths))
        .await
        .unwrap_or((0, 0))
}

fn sum_and_count_batch_std(paths: &[String]) -> (u64, u64) {
    let mut bytes: u64 = 0;
    let mut count: u64 = 0;
    for fp in paths {
        let p = std::path::Path::new(fp);
        // `is_dir()` follows, matching the previous top-level classification
        // so a symlink-to-folder in the batch is still walked.
        if p.is_dir() {
            let (b, c) = walk_regular_files_stats_std(p);
            bytes = bytes.saturating_add(b);
            // Floor a directory's count at 1 so an unwalkable subdir still
            // raises the banner (mirrors the prior `count_regular_files().max(1)`).
            count = count.saturating_add(c.max(1));
        } else {
            bytes = bytes.saturating_add(std::fs::metadata(p).map_or(0, |m| m.len()));
            count = count.saturating_add(1);
        }
    }
    (bytes, count)
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
        .ok_or(crate::error::AppError::Validation("Invalid folder name".into()))?
        .to_string();

    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Validation("Invalid folder name".into()));
    }

    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(canonical_parent) {
        return Err(crate::error::AppError::Validation("Path escapes sync folder".into()));
    }

    // Same guard as `add_folder_with_app_inner` — see that function for the
    // bug that motivated this check. `add_files` reaches this helper when
    // the batch contains directories, so the protection has to live here too.
    let canonical_source = tokio::fs::canonicalize(source).await?;
    if canonical_dest.starts_with(&canonical_source) {
        return Err(crate::error::AppError::Validation(
            "Cannot add the sync folder (or one of its ancestors) to itself".into(),
        ));
    }

    copy_tree_into_sync_dest(source, &canonical_dest).await?;
    Ok(name)
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
    // One pass over the batch yields BOTH the credit-gate byte total and the
    // banner file count (previously two passes that each walked every directory
    // in the batch). Each file path counts as 1; each directory contributes its
    // recursive count floored at 1 so an unwalkable subdir still raises the
    // banner. Per-path metadata failures degrade to 0 so a missing entry
    // doesn't reject the rest — the copy loop surfaces the real I/O error. An
    // empty `file_paths` yields count 0, which skips `begin` so an empty IPC
    // doesn't raise a banner nothing will clear.
    let account_id = state.current_account_id()?;
    let action = if for_folder {
        crate::billing::eligibility::InsufficientCreditsAction::FolderUpload
    } else {
        crate::billing::eligibility::InsufficientCreditsAction::FileUpload
    };
    let (total_bytes, total_count) = sum_and_count_batch(&file_paths).await;
    crate::billing::eligibility::require_eligible(&state, &account_id, action, total_bytes).await?;

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
            return Err(crate::error::AppError::Validation("Subfolder path contains traversal component".into()));
        }
        let target = Path::new(&sync_path).join(sub);
        if !tokio::fs::try_exists(&target).await.unwrap_or(false)
            && let Err(e) = create_dir_all_spawn(target.clone()).await
        {
            reset_banner(&app, &state);
            return Err(e);
        }
        // Verify resolved path stays within sync root.
        let canonical_root = match tokio::fs::canonicalize(Path::new(&sync_path)).await {
            Ok(p) => p,
            Err(e) => {
                reset_banner(&app, &state);
                return Err(crate::error::AppError::Io(e));
            }
        };
        let canonical_target = match tokio::fs::canonicalize(&target).await {
            Ok(p) => p,
            Err(e) => {
                reset_banner(&app, &state);
                return Err(crate::error::AppError::Io(e));
            }
        };
        if !canonical_target.starts_with(&canonical_root) {
            reset_banner(&app, &state);
            return Err(crate::error::AppError::Validation("Subfolder escapes sync folder".into()));
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
            return Err(crate::error::AppError::Io(e));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// One walk yields both the byte total and the regular-file count across
    /// nested directories — the single-pass replacement for the prior two
    /// separate traversals in the folder-upload credit gate + banner.
    #[tokio::test]
    async fn walk_regular_files_stats_counts_and_sizes_nested_tree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        tokio::fs::write(root.join("a.txt"), b"hello").await.unwrap(); // 5 bytes
        tokio::fs::write(root.join("b.txt"), b"hi").await.unwrap(); // 2 bytes
        let sub = root.join("sub");
        tokio::fs::create_dir(&sub).await.unwrap();
        tokio::fs::write(sub.join("c.txt"), b"xyz").await.unwrap(); // 3 bytes

        let (bytes, count) = walk_regular_files_stats(root).await;
        assert_eq!(count, 3, "all three regular files counted across the nested dir");
        assert_eq!(bytes, 10, "byte total summed across the nested dir (5+2+3)");
    }

    #[test]
    fn incoming_staging_path_is_hidden_and_stays_in_the_parent() {
        let dest = PathBuf::from("/sync/Photos");
        let staging = incoming_staging_path(&dest);
        let name = staging.file_name().and_then(|n| n.to_str()).unwrap();
        assert!(
            name.starts_with(".hippius-incoming-Photos-"),
            "staging name must be skipped by hcfs-client collect_files: {name}"
        );
        assert_eq!(staging.parent(), dest.parent());
    }

    #[tokio::test]
    async fn copy_tree_into_sync_dest_renames_staging_away() {
        let tmp = tempfile::TempDir::new().unwrap();
        let src = tmp.path().join("src");
        tokio::fs::create_dir(&src).await.unwrap();
        tokio::fs::write(src.join("a.txt"), b"hi").await.unwrap();
        let dest = tmp.path().join("Photos");
        copy_tree_into_sync_dest(&src, &dest).await.unwrap();
        assert_eq!(tokio::fs::read(dest.join("a.txt")).await.unwrap(), b"hi");
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".hippius-incoming-"))
            .collect();
        assert!(leftovers.is_empty(), "staging sibling must be renamed away, left {leftovers:?}");
    }

    #[tokio::test]
    async fn copy_tree_into_sync_dest_cleans_staging_when_copy_fails() {
        let tmp = tempfile::TempDir::new().unwrap();
        let src = tmp.path().join("missing-src");
        let dest = tmp.path().join("Photos");
        let err = copy_tree_into_sync_dest(&src, &dest).await;
        assert!(err.is_err(), "missing source must fail the copy");
        assert!(!dest.exists(), "failed add must not leave a dest folder");
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".hippius-incoming-"))
            .collect();
        assert!(leftovers.is_empty(), "failed copy must remove the staging sibling, left {leftovers:?}");
    }

    #[tokio::test]
    async fn copy_tree_into_sync_dest_merges_into_existing_dest() {
        let tmp = tempfile::TempDir::new().unwrap();
        let src = tmp.path().join("src");
        tokio::fs::create_dir(&src).await.unwrap();
        tokio::fs::write(src.join("new.txt"), b"n").await.unwrap();
        let dest = tmp.path().join("Photos");
        tokio::fs::create_dir(&dest).await.unwrap();
        tokio::fs::write(dest.join("old.txt"), b"o").await.unwrap();
        copy_tree_into_sync_dest(&src, &dest).await.unwrap();
        assert_eq!(tokio::fs::read(dest.join("old.txt")).await.unwrap(), b"o");
        assert_eq!(tokio::fs::read(dest.join("new.txt")).await.unwrap(), b"n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn walk_regular_files_stats_skips_symlinks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        tokio::fs::write(root.join("real.txt"), b"abc").await.unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();

        let (bytes, count) = walk_regular_files_stats(root).await;
        assert_eq!(count, 1, "symlink must not be counted as a regular file");
        assert_eq!(bytes, 3);
    }

    /// No baseline on disk → empty synced set → ALL on-disk files are pending.
    /// Also pins the nested-walk byte/count totals and the graceful missing-file
    /// behavior (a never-synced or freshly-added drive reports everything).
    #[tokio::test]
    async fn pending_summary_no_baseline_counts_all_files() {
        let folder_dir = tempfile::TempDir::new().unwrap(); // empty: no sync_state.json
        let sync_root = tempfile::TempDir::new().unwrap();
        let root = sync_root.path();
        tokio::fs::write(root.join("a.bin"), b"hello").await.unwrap(); // 5
        let sub = root.join("ui/shell");
        tokio::fs::create_dir_all(&sub).await.unwrap();
        tokio::fs::write(sub.join("c.bin"), b"xyz").await.unwrap(); // 3

        let (files, bytes) = compute_startup_pending_summary(folder_dir.path(), root).await;
        assert_eq!(files, 2);
        assert_eq!(bytes, 8);
    }

    #[tokio::test]
    async fn pending_summary_empty_folder_is_zero() {
        let folder_dir = tempfile::TempDir::new().unwrap();
        let sync_root = tempfile::TempDir::new().unwrap();
        let (files, bytes) = compute_startup_pending_summary(folder_dir.path(), sync_root.path()).await;
        assert_eq!((files, bytes), (0, 0));
    }

    /// A VALID (default/empty) `sync_state.json` parses, yields an empty synced
    /// set, so files still count as pending — proving the deserialize +
    /// `build_synced_paths_from_state` path works end to end (not just the
    /// missing-file fallback).
    #[tokio::test]
    async fn pending_summary_valid_empty_baseline_still_pending() {
        let folder_dir = tempfile::TempDir::new().unwrap();
        let json = serde_json::to_string(&hcfs_client::sync::SyncState::default()).unwrap();
        tokio::fs::write(folder_dir.path().join("sync_state.json"), json).await.unwrap();
        let sync_root = tempfile::TempDir::new().unwrap();
        tokio::fs::write(sync_root.path().join("a.bin"), b"data").await.unwrap(); // 4
        let (files, bytes) = compute_startup_pending_summary(folder_dir.path(), sync_root.path()).await;
        assert_eq!((files, bytes), (1, 4));
    }

    /// A corrupt baseline must NOT panic or error — it degrades to an empty
    /// synced set (everything pending), the graceful path the startup seed needs.
    #[tokio::test]
    async fn pending_summary_corrupt_baseline_degrades_gracefully() {
        let folder_dir = tempfile::TempDir::new().unwrap();
        tokio::fs::write(folder_dir.path().join("sync_state.json"), b"{ not json").await.unwrap();
        let sync_root = tempfile::TempDir::new().unwrap();
        tokio::fs::write(sync_root.path().join("a.bin"), b"data").await.unwrap();
        let (files, _bytes) = compute_startup_pending_summary(folder_dir.path(), sync_root.path()).await;
        assert_eq!(files, 1);
    }

    /// Hidden entries — a macOS `.DS_Store`, a generic dotfile, and a hidden
    /// directory's entire subtree — are skipped, mirroring hcfs-client's
    /// `should_skip_path` (the rule its real scan applies). Regression for the
    /// spurious "1 file · 8 KB · Preparing" flash on every launch: a `.DS_Store`
    /// is never uploaded, so it must never be counted as pending. A normal
    /// unsynced file alongside them is still counted, proving the skip is scoped
    /// to hidden names only (and does not swallow real pending work).
    #[tokio::test]
    async fn pending_summary_skips_hidden_entries() {
        let folder_dir = tempfile::TempDir::new().unwrap(); // no baseline: every non-hidden file is pending
        let sync_root = tempfile::TempDir::new().unwrap();
        let root = sync_root.path();
        // A real file the engine WOULD upload — the only thing that should count.
        tokio::fs::write(root.join("real.bin"), b"hello").await.unwrap(); // 5 bytes
        // macOS Finder metadata + a generic dotfile at the root — both skipped.
        tokio::fs::write(root.join(".DS_Store"), b"12345678").await.unwrap(); // 8 bytes
        tokio::fs::write(root.join(".hidden"), b"x").await.unwrap();
        // A hidden directory whose contents must NOT be walked at all (the
        // subtree-exclusion half of the skip).
        let hidden_dir = root.join(".hippius");
        tokio::fs::create_dir(&hidden_dir).await.unwrap();
        tokio::fs::write(hidden_dir.join("state.json"), b"deep").await.unwrap();

        let (files, bytes) = compute_startup_pending_summary(folder_dir.path(), root).await;
        assert_eq!(files, 1, "only the non-hidden file is pending");
        assert_eq!(bytes, 5, "only the non-hidden file's bytes are summed");
    }

    // --- add_folder overlap check ---
    //
    // Regression: `add_folder_with_app_inner` and `add_folder_internal` used
    // to forward whatever the user picked in the OS folder dialog straight to
    // `copy_dir_recursive`. Picking the sync root itself (or any ancestor)
    // resulted in 64 levels of nested duplicate folders before
    // `MAX_COPY_DEPTH` finally tripped. The IPC layer now rejects the call
    // with an `AppError::Validation` so the dialog can render a clear message.

    #[tokio::test]
    async fn add_folder_with_app_inner_rejects_sync_root_as_source() {
        let sync_dir = tempfile::tempdir().unwrap();
        tokio::fs::write(sync_dir.path().join("sentinel.txt"), b"x").await.unwrap();

        let sync_path = sync_dir.path().to_string_lossy().to_string();
        let err = add_folder_with_app_inner(&sync_path, &sync_path, None)
            .await
            .expect_err("must reject sync root as source");
        // Pin the taxonomy: a self-add reject is Validation, not the old Other.
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "self-add must be Validation, got {err:?}"
        );
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
}
