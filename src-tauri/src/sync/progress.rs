//! Sync progress IPC commands.
//!
//! Thin wrappers that delegate to the library's `ProgressTracker` and emit
//! snapshots via `SyncRunner::emit_snapshot()`. All business logic lives in
//! `hcfs_client::sync::progress_tracker`.

// Core types re-exported from library
pub use hcfs_client::engine::progress::snapshot::{SyncSnapshot, build_snapshot};
pub use hcfs_client::engine::progress::state::{
    FileAction, FileProgress, FileProgressStatus, FileStatus, OverallProgress, RECENT_FILES_RETENTION_MS, RecentFile, SessionFileList, SyncFile,
    SyncProgressState, SyncSession, count_expected_for_label,
};

use hcfs_client::engine::runner::SyncRunner;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

use crate::sync::logic::{NEVER_EMITTED, is_file_completion_tick, try_claim_snapshot_emit};

/// Minimum milliseconds between throttled `emit_snapshot(false)` calls from
/// the per-chunk progress hot path.
///
/// Per-chunk emits are the only code path that can fire hundreds of times per
/// second; state-transition emits (`emit_snapshot(true)`) are not throttled.
/// 250 ms matches the trailing-edge cadence the frontend `useSyncSnapshot`
/// listener is designed for and keeps the perceived UI update rate at 4 Hz,
/// which is visually smooth without flooding the WebKit main-thread eval
/// queue. See `src/sync/logic.rs` for the motivating bug report and the
/// underlying throttle logic.
const SNAPSHOT_THROTTLE_MS: u64 = 250;

/// Process-wide cursor (millis since process start) tracking the most recent
/// throttled snapshot emit. Monotonic by construction — see
/// [`monotonic_now_ms`]. Initialised to [`NEVER_EMITTED`] so the first
/// progress tick of the process always emits, regardless of how early in
/// startup it arrives.
static LAST_THROTTLED_EMIT_MS: AtomicU64 = AtomicU64::new(NEVER_EMITTED);

/// Milliseconds since the current process started.
///
/// Uses [`Instant`] so the value is immune to wall-clock adjustments (NTP
/// jumps, DST, manual clock changes). The value is truncated to `u64::MAX` in
/// the astronomically unlikely event the process runs for >584 million years.
fn monotonic_now_ms() -> u64 {
    static PROCESS_START: OnceLock<Instant> = OnceLock::new();
    let start = PROCESS_START.get_or_init(Instant::now);
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

// ── Inner functions (called from lifecycle.rs, auth/session.rs) ────────

/// Update progress for a single file. Called from progress callbacks.
///
/// The underlying `SyncRunner::emit_snapshot(false)` call is **trailing-edge
/// throttled** to one emit per [`SNAPSHOT_THROTTLE_MS`] across the whole
/// process. File-completion ticks (`bytes_transferred == total_bytes` with
/// `total_bytes > 0`) bypass the throttle so the UI reflects per-file
/// completion without waiting for the next window.
///
/// Without this throttle, upload/download/encrypt/decrypt callbacks fired by
/// `hcfs-client` can flood `webview.eval` with hundreds of large
/// `SyncSnapshot` JSON payloads per second, which blocks the macOS main
/// thread in `NSString` UTF-8 decoding and hangs the app. See the bug report
/// dated 2026-04-05 and the unit tests in `src/sync/logic.rs` for details.
pub fn update_file_progress(
    sync: &SyncRunner,
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<String>,
) -> Result<Option<SyncFile>, String> {
    let result = sync.progress.update_file_progress(path, bytes_transferred, total_bytes, action, label)?;
    let is_file_complete = is_file_completion_tick(bytes_transferred, total_bytes);
    if try_claim_snapshot_emit(&LAST_THROTTLED_EMIT_MS, monotonic_now_ms(), is_file_complete, SNAPSHOT_THROTTLE_MS) {
        sync.emit_snapshot(false);
    }
    Ok(result)
}

/// Merge file expectations into the current session, or start a new one.
pub fn merge_into_session(
    sync: &SyncRunner,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<(), String> {
    sync.progress.merge_into_session(
        expected_uploads,
        expected_downloads,
        expected_local_deletes,
        expected_remote_deletes,
        file_list,
        label.as_deref(),
    )?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Remove all files for a label from the current session.
pub fn remove_files_for_label(sync: &SyncRunner, label: String) -> Result<(), String> {
    sync.progress.remove_files_for_label(label)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Clear all sync progress data (session + recent files).
pub fn clear_all_data(sync: &SyncRunner) -> Result<(), String> {
    sync.progress.clear_all_data()?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Start a new sync session.
pub fn start_session(
    sync: &SyncRunner,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<SyncSession, String> {
    let result = sync.progress.start_session(
        expected_uploads,
        expected_downloads,
        expected_local_deletes,
        expected_remote_deletes,
        file_list,
        label.as_deref(),
    )?;
    sync.emit_snapshot(true);
    Ok(result)
}

/// Complete the current session.
pub fn complete_session(sync: &SyncRunner, files_uploaded: u32, files_downloaded: u32) -> Result<(), String> {
    sync.progress.complete_session(files_uploaded, files_downloaded)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Stop the current session.
pub fn stop_session(sync: &SyncRunner) -> Result<(), String> {
    sync.progress.stop_session()?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Force-complete all pending files for a label.
pub fn complete_pending_files(sync: &SyncRunner, label: &str) -> Result<(), String> {
    sync.progress.complete_pending_files(label)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark excess pending files as failed.
pub fn mark_pending_files_as_failed(sync: &SyncRunner, actual_uploads: u32, actual_downloads: u32, label: &str) -> Result<(), String> {
    sync.progress.mark_pending_files_as_failed(actual_uploads, actual_downloads, label)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark every pending/in-progress file as failed.
pub fn mark_all_pending_files_as_failed(sync: &SyncRunner, error_message: String) -> Result<(), String> {
    sync.progress.mark_all_pending_files_as_failed(error_message)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark a specific file as errored.
pub fn mark_file_error(sync: &SyncRunner, path: String, error: String) -> Result<(), String> {
    sync.progress.mark_file_error(path, error)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Compute overall progress.
pub fn get_overall_progress(sync: &SyncRunner) -> Result<OverallProgress, String> {
    sync.progress.get_overall_progress()
}

/// Get a full snapshot with retry state injected.
pub fn get_snapshot(sync: &SyncRunner) -> Result<SyncSnapshot, String> {
    let mut snapshot = sync.progress.build_snapshot();
    let retry_at = sync.retry_at.load(std::sync::atomic::Ordering::Relaxed);
    if retry_at > 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        snapshot.retry_in_secs = (retry_at - now).max(0) as u64;
    }
    snapshot.last_error = sync.last_error.lock().ok().and_then(|g| g.clone());
    Ok(snapshot)
}

/// Record a deleted file in recent files.
pub fn record_deleted_file(sync: &SyncRunner, file_name: String, size_bytes: u64) -> Result<(), String> {
    sync.progress.record_deleted_file(file_name, size_bytes)?;
    sync.emit_snapshot(true);
    Ok(())
}

// ── Tauri IPC Wrappers ─────────────────────────────────────────────────

#[tauri::command]
pub fn sp_start_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<SyncSession, String> {
    start_session(
        &state.sync,
        expected_uploads,
        expected_downloads,
        expected_local_deletes,
        expected_remote_deletes,
        file_list,
        label,
    )
}

#[tauri::command]
pub fn sp_merge_into_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<(), String> {
    merge_into_session(
        &state.sync,
        expected_uploads,
        expected_downloads,
        expected_local_deletes,
        expected_remote_deletes,
        file_list,
        label,
    )
}

#[tauri::command]
pub fn sp_complete_session(state: tauri::State<'_, crate::app_state::AppState>, files_uploaded: u32, files_downloaded: u32) -> Result<(), String> {
    complete_session(&state.sync, files_uploaded, files_downloaded)
}

#[tauri::command]
pub fn sp_stop_session(state: tauri::State<'_, crate::app_state::AppState>) -> Result<(), String> {
    stop_session(&state.sync)
}

#[tauri::command]
pub fn sp_update_file_progress(
    state: tauri::State<'_, crate::app_state::AppState>,
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<String>,
) -> Result<Option<SyncFile>, String> {
    update_file_progress(&state.sync, path, bytes_transferred, total_bytes, action, label)
}

#[tauri::command]
pub fn sp_complete_pending_files(state: tauri::State<'_, crate::app_state::AppState>, label: Option<String>) -> Result<(), String> {
    complete_pending_files(&state.sync, label.as_deref().unwrap_or("default"))
}

#[tauri::command]
pub fn sp_mark_pending_files_as_failed(
    state: tauri::State<'_, crate::app_state::AppState>,
    actual_uploads: u32,
    actual_downloads: u32,
    label: Option<String>,
) -> Result<(), String> {
    mark_pending_files_as_failed(&state.sync, actual_uploads, actual_downloads, label.as_deref().unwrap_or("default"))
}

#[tauri::command]
pub fn sp_mark_all_pending_files_as_failed(state: tauri::State<'_, crate::app_state::AppState>, error_message: String) -> Result<(), String> {
    mark_all_pending_files_as_failed(&state.sync, error_message)
}

#[tauri::command]
pub fn sp_mark_file_error(state: tauri::State<'_, crate::app_state::AppState>, path: String, error: String) -> Result<(), String> {
    mark_file_error(&state.sync, path, error)
}

#[tauri::command]
pub fn sp_get_overall_progress(state: tauri::State<'_, crate::app_state::AppState>) -> Result<OverallProgress, String> {
    get_overall_progress(&state.sync)
}

#[tauri::command]
pub fn sp_record_deleted_file(state: tauri::State<'_, crate::app_state::AppState>, file_name: String, size_bytes: u64) -> Result<(), String> {
    record_deleted_file(&state.sync, file_name, size_bytes)
}

#[tauri::command]
pub fn sp_remove_files_for_label(state: tauri::State<'_, crate::app_state::AppState>, label: String) -> Result<(), String> {
    remove_files_for_label(&state.sync, label)
}

#[tauri::command]
pub fn sp_clear_all_data(state: tauri::State<'_, crate::app_state::AppState>) -> Result<(), String> {
    clear_all_data(&state.sync)
}

#[tauri::command]
pub fn sp_get_snapshot(state: tauri::State<'_, crate::app_state::AppState>) -> Result<SyncSnapshot, String> {
    get_snapshot(&state.sync)
}

/// Dismiss the sync status widget for the current session.
#[tauri::command]
pub fn sp_dismiss_sync_widget(state: tauri::State<'_, crate::app_state::AppState>) {
    state.sync.progress.dismiss();
    state.sync.emit_snapshot(true);
}
