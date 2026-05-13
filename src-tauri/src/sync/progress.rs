//! Sync progress IPC commands.
//!
//! Thin wrappers that delegate to the library's `ProgressTracker` and emit
//! snapshots via `SyncRunner::emit_snapshot()`. All business logic lives in
//! `hcfs_client::sync::progress_tracker`.

// Core types re-exported from library
pub use hcfs_client::engine::progress::snapshot::{SyncSnapshot, build_snapshot};
pub use hcfs_client::engine::progress::state::{
    FileAction, FileProgress, FileProgressStatus, FileStatus, OverallProgress, RECENT_FILES_RETENTION_MS, RecentFile, SessionFileList, SyncFile,
    SyncProgressState, SyncSession, SyncSessionHandle, count_expected_for_label,
};

use hcfs_client::engine::runner::SyncRunner;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

use crate::error::{AppError, Result};
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

/// Update per-file byte progress in the active sync session.
///
/// The underlying `SyncRunner::emit_snapshot(false)` call is **trailing-edge
/// throttled** to one emit per [`SNAPSHOT_THROTTLE_MS`] across the whole
/// process. File-completion ticks (`bytes_transferred == total_bytes` with
/// `total_bytes > 0`) use a shorter 100 ms window (see
/// [`crate::sync::logic::COMPLETION_THROTTLE_MS`]) to batch burst
/// completions while remaining responsive.
///
/// Without this throttle, upload/download/encrypt/decrypt callbacks fired by
/// `hcfs-client` can flood `webview.eval` with hundreds of large
/// `SyncSnapshot` JSON payloads per second, which blocks the macOS main
/// thread in `NSString` UTF-8 decoding and hangs the app. See the bug report
/// dated 2026-04-05 and the unit tests in `src/sync/logic.rs` for details.
///
/// Accepts `&str` for `path` and `Option<&str>` for `label` to avoid
/// heap-allocating on every progress tick — this is a hot path called
/// hundreds of times per second during large transfers. The `String`
/// conversions required by the inner `hcfs-client` API happen exactly once
/// here, at the crate boundary.
pub fn update_file_progress(
    sync: &SyncRunner,
    path: &str,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<&str>,
) -> Result<()> {
    sync.progress
        .update_file_progress(path.to_owned(), bytes_transferred, total_bytes, action, label.map(ToOwned::to_owned))
        .map_err(AppError::Progress)?;
    let is_file_complete = is_file_completion_tick(bytes_transferred, total_bytes);
    if try_claim_snapshot_emit(&LAST_THROTTLED_EMIT_MS, monotonic_now_ms(), is_file_complete, SNAPSHOT_THROTTLE_MS) {
        sync.emit_snapshot(false);
    }
    Ok(())
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
) -> Result<()> {
    sync.progress
        .merge_into_session(
            expected_uploads,
            expected_downloads,
            expected_local_deletes,
            expected_remote_deletes,
            file_list,
            label.as_deref(),
        )
        .map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Remove all files for a label from the current session.
pub fn remove_files_for_label(sync: &SyncRunner, label: String) -> Result<()> {
    sync.progress.remove_files_for_label(label).map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Clear all sync progress data (session + recent files).
pub fn clear_all_data(sync: &SyncRunner) -> Result<()> {
    sync.progress.clear_all_data().map_err(AppError::Progress)?;
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
) -> Result<SyncSessionHandle> {
    let result = sync
        .progress
        .start_session(
            expected_uploads,
            expected_downloads,
            expected_local_deletes,
            expected_remote_deletes,
            file_list,
            label.as_deref(),
        )
        .map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(result)
}

/// Complete the current session.
pub fn complete_session(sync: &SyncRunner, files_uploaded: u32, files_downloaded: u32) -> Result<()> {
    sync.progress
        .complete_session(files_uploaded, files_downloaded)
        .map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Stop the current session.
pub fn stop_session(sync: &SyncRunner) -> Result<()> {
    sync.progress.stop_session().map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Force-complete all pending files for a label.
pub fn complete_pending_files(sync: &SyncRunner, label: &str) -> Result<()> {
    sync.progress.complete_pending_files(label).map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark excess pending files as failed.
pub fn mark_pending_files_as_failed(sync: &SyncRunner, actual_uploads: u32, actual_downloads: u32, label: &str) -> Result<()> {
    sync.progress
        .mark_pending_files_as_failed(actual_uploads, actual_downloads, label)
        .map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark every pending/in-progress file as failed.
pub fn mark_all_pending_files_as_failed(sync: &SyncRunner, error_message: String) -> Result<()> {
    sync.progress
        .mark_all_pending_files_as_failed(error_message)
        .map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark a specific file as errored.
pub fn mark_file_error(sync: &SyncRunner, path: String, error: String) -> Result<()> {
    sync.progress.mark_file_error(path, error).map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark a single file as fully synced (download/upload + AEAD verification
/// complete) and emit a snapshot.
///
/// Called from `build_file_synced_callback` in `lifecycle.rs`, which fires
/// from hcfs-client's per-file `on_file_synced` callback. That callback is
/// invoked from `drive/sync_flow.rs` only after the upload OR download task
/// completes successfully — for downloads this happens AFTER chunked
/// download AND AEAD-tag-verifying decryption have both succeeded.
///
/// Why this exists: hcfs-client's `update_file_progress` parks decrypted
/// files in `Decrypting` status until `complete_pending_files` runs at
/// end-of-cycle. The reasoning is sound — the on_decrypt_progress callback
/// fires with `bytes == total` *during* the streaming decryption, before
/// AEAD verification, so flipping to Completed at that moment would risk
/// claiming success for a file that fails verification. But it conflates
/// "AEAD verification complete" with "the entire sync cycle complete",
/// which means a 493-byte file gets pinned at "Decrypting" while a 1 GB
/// file finishes downloading alongside it. This helper resolves the
/// individual file as soon as its own AEAD verification has succeeded,
/// independent of other in-flight files.
///
/// No-op if there's no current session, no file at the given path, or the
/// file is already Completed.
///
/// As of hcfs-client `33048ff5bc9228939b521c8a147533dcb221dfb5` (PR #110),
/// `path_for_progress` in `drive/download.rs` always uses the full
/// decrypted relative path, so the key passed to the per-chunk decrypt
/// callback matches the key passed to `on_file_synced`. A simple
/// `session.files.get_mut(path)` lookup is sufficient — no basename
/// fallback needed.
pub fn mark_file_synced(sync: &SyncRunner, path: &str) -> Result<()> {
    use hcfs_client::engine::progress::state::FileStatus;

    {
        let mut state = sync.progress.lock_state();
        let Some(session) = state.current_session.as_mut() else {
            return Ok(());
        };
        let Some(file) = session.files.get_mut(path) else {
            return Ok(());
        };
        if file.status == FileStatus::Completed {
            return Ok(());
        }
        let now = chrono::Utc::now().timestamp_millis();
        file.status = FileStatus::Completed;
        file.progress = 100;
        file.completed_at = Some(now);
        if file.total_bytes > 0 {
            file.bytes_transferred = file.total_bytes;
            file.bytes_encrypted = file.total_bytes;
        }
    }
    sync.emit_snapshot(true);
    Ok(())
}

/// Mark a single file as failed (per-file upload or download error) and
/// emit a snapshot.
///
/// Called from `build_file_failed_callback` in `lifecycle.rs`, which fires
/// from hcfs-client's per-file `on_file_failed` callback the moment the
/// per-file task returns `Err`. This is the synchronous counterpart to
/// [`mark_file_synced`] for the failure path: the file's progress row
/// flips to terminal `FileStatus::Error` immediately instead of waiting
/// for end-of-cycle `mark_pending_files_as_failed`.
///
/// Why this exists: cycle-level `mark_pending_files_as_failed` only sees
/// the shortfall (`expected_uploads - actual_uploads`), so a partial
/// failure scenario (some files 402, some succeed inside the same cycle)
/// arrives at the FE only after the whole cycle finalises — the failure
/// banner UX needs the signal at the failure site, not 30 seconds later.
///
/// Field semantics mirror hcfs-client's [`hcfs_client::engine::progress::tracker::ProgressTracker::mark_file_error`]:
///
/// - `file.status = FileStatus::Error` — terminal for this cycle.
/// - `file.error = Some(error.into())` — display text for the FE row tooltip.
/// - `file.bytes_transferred = 0`, `file.progress = 0` — reset so the
///   progress bar doesn't show "99% then Error" (the upstream tracker
///   resets too, see `engine/progress/tracker.rs:491-492`).
/// - `file.completed_at = Some(now)` — terminal timestamp, sorts the row
///   to the recent-activity tail.
///
/// No-op if there's no current session, no file at the given path
/// (rename races), or the file is already in `Error` state (re-entry from
/// a retry that also failed — keep the first error message).
pub fn mark_file_failed(sync: &SyncRunner, path: &str, error: &str) -> Result<()> {
    use hcfs_client::engine::progress::state::FileStatus;
    use std::sync::Arc;

    {
        let mut state = sync.progress.lock_state();
        let Some(session) = state.current_session.as_mut() else {
            return Ok(());
        };
        let Some(file) = session.files.get_mut(path) else {
            return Ok(());
        };
        if file.status == FileStatus::Error {
            // Already terminal — preserve the first error to avoid the
            // hcfs-client retry loop clobbering the 402 message with a
            // subsequent generic network error.
            return Ok(());
        }
        let now = chrono::Utc::now().timestamp_millis();
        file.status = FileStatus::Error;
        file.error = Some(Arc::from(error));
        file.completed_at = Some(now);
        file.bytes_transferred = 0;
        file.progress = 0;
    }
    sync.emit_snapshot(true);
    Ok(())
}

/// Compute overall progress.
pub fn get_overall_progress(sync: &SyncRunner) -> Result<OverallProgress> {
    sync.progress.get_overall_progress().map_err(AppError::Progress)
}

/// Maximum number of per-file or per-path entries sent to the frontend in a
/// single Tauri event payload.
///
/// Applies to `SyncSnapshot.files`, `SyncPlanReadyPayload.*_files`, and
/// `SyncStartedPayload.*_files`.  Aggregate counters remain accurate; only the
/// detailed arrays are truncated.  This prevents massive JSON payloads from
/// flooding `webview.eval` and freezing the macOS main thread when a migration
/// produces thousands of files.
pub(crate) const MAX_EVENT_FILES: usize = 50;

/// Maximum number of per-file entries carried in a
/// [`crate::sync::events::SyncCompletedPayload`]. Separate from
/// [`MAX_EVENT_FILES`] because the sync-completed event is only
/// emitted once per cycle and is read by the notification layer,
/// which can render a longer scrollable list than the per-tick
/// snapshot widget can reasonably handle. Still capped so a
/// 10,000-file migration doesn't produce a 2 MB JSON payload.
pub(crate) const MAX_NOTIFICATION_FILES: usize = 200;

/// Truncate `snapshot.files` to at most [`MAX_EVENT_FILES`] entries while
/// preserving the priority order already established by `build_snapshot`
/// (errors, then in-progress, then pending, then completed). Aggregate
/// counters on the snapshot are untouched.
pub(crate) fn cap_snapshot_files(snapshot: &mut SyncSnapshot) {
    if snapshot.files.len() <= MAX_EVENT_FILES {
        return;
    }
    snapshot.files.truncate(MAX_EVENT_FILES);
}

/// Truncate a file-path vector to at most [`MAX_EVENT_FILES`] entries.
pub(crate) fn cap_file_list(v: &mut Vec<String>) {
    v.truncate(MAX_EVENT_FILES);
}

/// Snapshot the files completed in the most recent cycle for a given
/// drive label, suitable for attaching to a
/// [`crate::sync::events::SyncCompletedPayload`] before emission.
///
/// Reads `sync.progress.current_session.files` — the internal session
/// state, which is NOT truncated by [`MAX_EVENT_FILES`] — and filters to
/// entries whose `label` matches and whose status is `Completed`.
/// Sorts by `completed_at` descending so the newest cycle's files win
/// over lingering entries from earlier cycles (the session may persist
/// completed files across cycles for the UI's recent-activity panel).
///
/// Capped at `max_files` (typically
/// [`MAX_NOTIFICATION_FILES`] intersected with the event's own reported
/// count — passing `files_uploaded + files_downloaded + …` is the usual
/// caller choice so a multi-cycle residue can't over-report).
///
/// Returns an empty vec if there is no active session. The notification
/// hook treats an empty `files` field as "no detail available" and
/// still writes the description row, so an empty result is not fatal.
pub fn collect_cycle_files_for_label(sync: &SyncRunner, label: &str, max_files: usize) -> Vec<crate::sync::events::SyncedFileDetail> {
    use hcfs_client::engine::progress::state::FileStatus;

    if max_files == 0 {
        return Vec::new();
    }
    let state = sync.progress.lock_state();
    let Some(session) = state.current_session.as_ref() else {
        return Vec::new();
    };
    let mut matching: Vec<&hcfs_client::engine::progress::state::SyncFile> = session
        .files
        .values()
        .filter(|f| f.label.as_ref() == label && f.status == FileStatus::Completed)
        .collect();
    // Most recently completed first, so a truncation to `max_files`
    // always keeps the cycle that just finished. `completed_at` is
    // `Option<i64>`; treat `None` as 0 so unmarked files sort last.
    matching.sort_by(|a, b| b.completed_at.unwrap_or(0).cmp(&a.completed_at.unwrap_or(0)));
    matching
        .into_iter()
        .take(max_files)
        .map(|f| crate::sync::events::SyncedFileDetail {
            file_name: f.file_name.to_string(),
            total_bytes: f.total_bytes,
            action: f.action.clone(),
        })
        .collect()
}

/// Get a full snapshot with retry state injected.
pub fn get_snapshot(sync: &SyncRunner, preparing: &crate::sync::preparing::PreparingState) -> Result<SyncSnapshot> {
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
    prepare_snapshot_for_emit(&mut snapshot, preparing);
    Ok(snapshot)
}

/// Apply every mutation a snapshot needs before leaving the Rust side for
/// the frontend. Called from both the `sp_get_snapshot` bootstrap path
/// (widget/tray mount) and the `SyncEvent::ProgressSnapshot` bridge
/// (every live update). Keeping a single funnel guarantees the two paths
/// can't drift — a stalled-completion snapshot seen at mount must look
/// identical to one observed mid-session.
///
/// Order of operations matters. `fixup_stalled_completion` may flip
/// the snapshot into a visible "completed" state; we run it first so
/// the preparing override does not paper over a real completion.
/// `apply_preparing_override` runs second and only takes effect when
/// the snapshot is still invisible (no real session yet). `cap_snapshot_files`
/// runs last to truncate the file list — order-independent relative
/// to the previous two.
pub(crate) fn prepare_snapshot_for_emit(snapshot: &mut SyncSnapshot, preparing: &crate::sync::preparing::PreparingState) {
    fixup_stalled_completion(snapshot);
    apply_preparing_override(snapshot, preparing);
    cap_snapshot_files(snapshot);
}

/// Surface a "preparing" widget state when any drive is between
/// `SyncStarted` and its first session-populated snapshot.
///
/// Only takes effect when the snapshot is otherwise invisible — never
/// demotes an already-visible widget. Sets `widget_state` to
/// `"preparing"` — a fourth variant added on top of the
/// `"active" | "completed" | "idle"` set that hcfs-client's
/// `build_snapshot` produces (see `hcfs-client/src/engine/progress/snapshot.rs`).
/// The frontend widget and tray treat the new value as the
/// preparing-state branch in their badge/title/icon switches without
/// having to inspect the preparing set directly.
///
/// We deliberately leave `effective_in_progress` / `total_files` /
/// `overall_percent` at their original (zero/false) values: the
/// dialog's badge logic already has a "Preparing sync…" fallback
/// branch for the (not-error, not-completed, not-in-progress) case
/// (see `app/(pages)/SyncStatusDialog.tsx`), and flipping
/// `effective_in_progress=true` here would force it into the
/// `"0 of 0 files synced"` branch instead.
fn apply_preparing_override(snapshot: &mut SyncSnapshot, preparing: &crate::sync::preparing::PreparingState) {
    if snapshot.widget_visible {
        return;
    }
    if !preparing.is_any_preparing() {
        return;
    }
    snapshot.widget_visible = true;
    snapshot.widget_state = "preparing".to_string();
}

/// Detect and correct a stalled completion state.
///
/// The hcfs-client file watcher can detect the sync engine's own writes
/// and set `changes_pending = true`, which prevents `complete_session`
/// from being called even though all files are fully synced. This leaves
/// `is_active = true` indefinitely with 100% progress.
///
/// When we detect this (active session, all files accounted for, 100%
/// progress), override the display fields so the frontend shows
/// "Complete" instead of "Syncing...".
fn fixup_stalled_completion(snapshot: &mut SyncSnapshot) {
    if !snapshot.is_active || snapshot.total_files == 0 {
        return;
    }
    let all_files_done = snapshot.completed_files + snapshot.failed_files >= snapshot.total_files;
    let progress_complete = snapshot.overall_percent >= 100;
    if all_files_done && progress_complete {
        snapshot.effective_in_progress = false;
        snapshot.effective_completed = true;
        snapshot.widget_state = "completed".to_string();
        snapshot.status_variant = if snapshot.failed_files > 0 {
            "error".to_string()
        } else {
            "success".to_string()
        };
    }
}

/// Record a deleted file in recent files.
pub fn record_deleted_file(sync: &SyncRunner, file_name: String, size_bytes: u64) -> Result<()> {
    sync.progress.record_deleted_file(file_name, size_bytes).map_err(AppError::Progress)?;
    sync.emit_snapshot(true);
    Ok(())
}

// ── Tauri IPC Wrappers ─────────────────────────────────────────────────
//
// Only three `sp_*` commands remain exposed to the frontend:
//
// - `sp_get_snapshot` — bootstrap fetch on widget mount, before the first
//   `sync_progress_snapshot` event arrives.
// - `sp_dismiss_sync_widget` — user closes the floating sync widget.
// - `sp_clear_all_data` — full reset path during logout / `hcfs_sync_reset`.
//
// The rest of the session-management primitives (`start_session`,
// `merge_into_session`, `complete_session`, `update_file_progress`, the
// `mark_*` family, `record_deleted_file`, `remove_files_for_label`, etc.)
// used to be exposed as `sp_*` IPCs back when the frontend drove session
// lifecycle. hcfs-client now owns the session lifecycle entirely — those
// inner functions are still called from `lifecycle.rs` and the
// hcfs-client callback wiring, but their Tauri wrappers were dead and
// have been removed (2026-04-09).

#[tauri::command]
pub fn sp_clear_all_data(state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    clear_all_data(&state.sync)
}

#[tauri::command]
pub fn sp_get_snapshot(state: tauri::State<'_, crate::app_state::AppState>) -> Result<SyncSnapshot> {
    get_snapshot(&state.sync, &state.preparing)
}

/// Dismiss the sync status widget for the current session.
#[tauri::command]
pub fn sp_dismiss_sync_widget(state: tauri::State<'_, crate::app_state::AppState>) {
    state.sync.progress.dismiss();
    state.sync.emit_snapshot(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create a minimal snapshot with sensible defaults.
    fn base_snapshot() -> SyncSnapshot {
        SyncSnapshot {
            is_active: false,
            overall_percent: 0,
            progress_bytes: 0,
            bytes_expected: 0,
            total_files: 0,
            completed_files: 0,
            failed_files: 0,
            retry_in_secs: 0,
            last_error: None,
            expected_uploads: 0,
            expected_downloads: 0,
            expected_local_deletes: 0,
            expected_remote_deletes: 0,
            started_at: None,
            completed_at: None,
            files: vec![],
            widget_state: "idle".to_string(),
            widget_visible: false,
            combined_progress_bytes: 0,
            combined_bytes_expected: 0,
            deleted_count: 0,
            synced_count: 0,
            actual_total: 0,
            status_variant: "progress".to_string(),
            sync_direction: "upload".to_string(),
            effective_in_progress: false,
            effective_completed: false,
        }
    }

    #[test]
    fn fixup_corrects_stalled_active_session_with_all_files_done() {
        let mut snap = base_snapshot();
        snap.is_active = true;
        snap.total_files = 3;
        snap.completed_files = 3;
        snap.failed_files = 0;
        snap.overall_percent = 100;
        snap.effective_in_progress = true;
        snap.effective_completed = false;
        snap.widget_state = "active".to_string();
        snap.status_variant = "progress".to_string();

        fixup_stalled_completion(&mut snap);

        assert!(!snap.effective_in_progress);
        assert!(snap.effective_completed);
        assert_eq!(snap.widget_state, "completed");
        assert_eq!(snap.status_variant, "success");
    }

    #[test]
    fn fixup_preserves_error_variant_when_files_failed() {
        let mut snap = base_snapshot();
        snap.is_active = true;
        snap.total_files = 3;
        snap.completed_files = 2;
        snap.failed_files = 1;
        snap.overall_percent = 100;
        snap.effective_in_progress = true;
        snap.effective_completed = false;

        fixup_stalled_completion(&mut snap);

        assert!(snap.effective_completed);
        assert_eq!(snap.status_variant, "error");
    }

    #[test]
    fn fixup_does_not_modify_genuinely_in_progress_session() {
        let mut snap = base_snapshot();
        snap.is_active = true;
        snap.total_files = 5;
        snap.completed_files = 2;
        snap.failed_files = 0;
        snap.overall_percent = 40;
        snap.effective_in_progress = true;
        snap.effective_completed = false;
        snap.widget_state = "active".to_string();

        fixup_stalled_completion(&mut snap);

        assert!(snap.effective_in_progress);
        assert!(!snap.effective_completed);
        assert_eq!(snap.widget_state, "active");
    }

    #[test]
    fn fixup_does_not_modify_inactive_session() {
        let mut snap = base_snapshot();
        snap.is_active = false;
        snap.total_files = 3;
        snap.completed_files = 3;
        snap.overall_percent = 100;
        snap.effective_completed = true;

        fixup_stalled_completion(&mut snap);

        // Already correctly completed, no changes needed
        assert!(snap.effective_completed);
    }

    /// Regression: the bridge path at
    /// `src/sync/tauri_bridge.rs::on_event::ProgressSnapshot` emits every
    /// live snapshot through `prepare_snapshot_for_emit`. If the helper
    /// stops applying `fixup_stalled_completion`, a stalled session would
    /// leak through as `widget_state="active"` forever and the tray would
    /// be pinned at "⟳ Syncing: 100%". This test pins the contract at the
    /// helper boundary so either path can trust its output equally.
    #[test]
    fn prepare_snapshot_for_emit_applies_stalled_completion_fixup() {
        let mut snap = base_snapshot();
        snap.is_active = true;
        snap.total_files = 93;
        snap.completed_files = 93;
        snap.failed_files = 0;
        snap.overall_percent = 100;
        snap.effective_in_progress = true;
        snap.effective_completed = false;
        snap.widget_state = "active".to_string();
        snap.status_variant = "progress".to_string();

        let preparing = crate::sync::preparing::PreparingState::new();
        prepare_snapshot_for_emit(&mut snap, &preparing);

        assert!(!snap.effective_in_progress, "stall should flip effective_in_progress to false");
        assert!(snap.effective_completed, "stall should flip effective_completed to true");
        assert_eq!(snap.widget_state, "completed");
        assert_eq!(snap.status_variant, "success");
    }

    /// `prepare_snapshot_for_emit` also caps the `files` vec. Cover the cap
    /// side of the helper so a future refactor that drops the cap call
    /// (flooding the webview with a 10k-file payload during migration)
    /// trips a test rather than hitting users.
    #[test]
    fn prepare_snapshot_for_emit_caps_files() {
        use hcfs_client::engine::progress::state::{FileAction, FileProgress, FileProgressStatus};
        let mut snap = base_snapshot();
        snap.files = (0..MAX_EVENT_FILES + 25)
            .map(|i| FileProgress {
                path: std::sync::Arc::from(format!("f{i}.txt")),
                file_name: std::sync::Arc::from(format!("f{i}.txt")),
                label: std::sync::Arc::from("default"),
                action: FileAction::Upload,
                status: FileProgressStatus::Pending,
                progress_percent: 0,
                bytes_encrypted: 0,
                bytes_transferred: 0,
                total_bytes: 100,
                resumed_from_bytes: None,
                error: None,
            })
            .collect();

        let preparing = crate::sync::preparing::PreparingState::new();
        prepare_snapshot_for_emit(&mut snap, &preparing);

        assert_eq!(snap.files.len(), MAX_EVENT_FILES);
    }

    /// When a drive is marked preparing AND the snapshot would otherwise
    /// be invisible (no active session yet), the override sets
    /// `widget_visible=true` and `widget_state="preparing"` so the
    /// bottom-right widget and tray show feedback during the
    /// SyncStarted → first-snapshot gap.
    #[test]
    fn preparing_override_makes_invisible_snapshot_visible() {
        let mut snap = base_snapshot();
        // Empty snapshot, widget would otherwise be hidden.
        assert!(!snap.widget_visible);

        let preparing = crate::sync::preparing::PreparingState::new();
        preparing.mark_preparing("drive-a");

        prepare_snapshot_for_emit(&mut snap, &preparing);

        assert!(snap.widget_visible, "preparing should force widget_visible=true");
        assert_eq!(snap.widget_state, "preparing");
        // `effective_in_progress` deliberately stays false so the
        // dialog's "Preparing sync…" fallback branch renders instead
        // of "0 of 0 files synced". See `apply_preparing_override`'s
        // doc comment for the rationale.
        assert!(!snap.effective_in_progress);
        assert_eq!(snap.total_files, 0);
    }

    /// Override is a no-op when no drive is preparing. Snapshots whose
    /// session is genuinely empty (e.g. between sync cycles, with no
    /// pending work) must stay hidden.
    #[test]
    fn preparing_override_is_noop_when_set_empty() {
        let mut snap = base_snapshot();
        let preparing = crate::sync::preparing::PreparingState::new();

        prepare_snapshot_for_emit(&mut snap, &preparing);

        assert!(!snap.widget_visible);
        assert_eq!(snap.widget_state, "idle");
    }

    /// The override must never demote an already-visible widget. An
    /// active sync mid-cycle has `widget_visible=true` from
    /// `build_snapshot`; the preparing helper should leave it alone
    /// (otherwise it would clobber the real `widget_state="active"`
    /// label with `"preparing"` in the gap between a SyncStarted for
    /// drive B and B's plan_ready, while drive A is still uploading).
    #[test]
    fn preparing_override_does_not_demote_visible_snapshot() {
        let mut snap = base_snapshot();
        snap.widget_visible = true;
        snap.widget_state = "active".to_string();
        snap.is_active = true;
        snap.total_files = 5;

        let preparing = crate::sync::preparing::PreparingState::new();
        preparing.mark_preparing("drive-b");

        prepare_snapshot_for_emit(&mut snap, &preparing);

        assert!(snap.widget_visible);
        assert_eq!(snap.widget_state, "active");
    }

    #[test]
    fn fixup_does_not_modify_empty_active_session() {
        let mut snap = base_snapshot();
        snap.is_active = true;
        snap.total_files = 0;
        snap.effective_in_progress = true;

        fixup_stalled_completion(&mut snap);

        // Empty heartbeat session, should not be marked complete
        assert!(snap.effective_in_progress);
        assert!(!snap.effective_completed);
    }

    // ── collect_cycle_files_for_label ───────────────────────────────
    //
    // These tests build a fake `SyncRunner` via the same helper used
    // by the existing `remove_drive_inmemory` tests in lifecycle.rs,
    // then seed `current_session.files` directly and exercise the
    // helper end-to-end. They pin the filter+sort+cap contract that
    // `sync/tauri_bridge.rs::on_event::SyncCompleted` relies on to
    // prevent the count-vs-list mismatch in the FE notification.
    //
    // The tests deliberately do NOT go through
    // `ProgressTracker::update_file_progress` / `start_session` etc.
    // — they reach into `state.current_session` directly so a
    // regression in `collect_cycle_files_for_label` can be isolated
    // from unrelated changes in the upstream progress tracker.

    use hcfs_client::engine::progress::state::{FileAction, FileStatus, SyncFile, SyncSession};
    use std::collections::HashMap;
    use std::sync::Arc;

    fn test_runner() -> Arc<hcfs_client::engine::runner::SyncRunner> {
        use hcfs_client::engine::{NoopCallbacks, NoopEventHandler};
        Arc::new(hcfs_client::engine::runner::SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ))
    }

    fn make_file(path: &str, label: &str, status: FileStatus, completed_at: Option<i64>, total_bytes: u64, action: FileAction) -> SyncFile {
        SyncFile {
            id: Arc::from(path),
            path: Arc::from(path),
            file_name: Arc::from(path.rsplit('/').next().unwrap_or(path)),
            label: Arc::from(label),
            action,
            status,
            progress: if completed_at.is_some() { 100 } else { 0 },
            bytes_encrypted: total_bytes,
            bytes_transferred: total_bytes,
            total_bytes,
            resumed_from_bytes: None,
            started_at: 0,
            completed_at,
            error: None,
        }
    }

    /// Seed `current_session.files` with the given files. Overwrites
    /// any existing session.
    fn seed_session(sync: &hcfs_client::engine::runner::SyncRunner, files: Vec<SyncFile>) {
        let mut state = sync.progress.lock_state();
        let file_map: HashMap<String, SyncFile> = files.into_iter().map(|f| (f.path.to_string(), f)).collect();
        state.current_session = Some(SyncSession {
            session_id: Arc::from("test-session"),
            started_at: 0,
            completed_at: None,
            is_active: true,
            expected_uploads: 0,
            expected_downloads: 0,
            expected_local_deletes: 0,
            expected_remote_deletes: 0,
            files: file_map,
        });
    }

    #[test]
    fn collect_cycle_files_returns_empty_when_no_session() {
        let sync = test_runner();
        // Deliberately do not seed a session.
        let result = collect_cycle_files_for_label(&sync, "default", 10);
        assert!(result.is_empty(), "expected empty vec, got {} files", result.len());
    }

    #[test]
    fn collect_cycle_files_returns_empty_when_max_files_zero() {
        let sync = test_runner();
        seed_session(
            &sync,
            vec![make_file("a.txt", "default", FileStatus::Completed, Some(100), 1024, FileAction::Upload)],
        );
        let result = collect_cycle_files_for_label(&sync, "default", 0);
        assert!(result.is_empty(), "expected empty vec for max_files=0, got {} files", result.len());
    }

    #[test]
    fn collect_cycle_files_filters_by_label() {
        let sync = test_runner();
        seed_session(
            &sync,
            vec![
                make_file("match1.txt", "target", FileStatus::Completed, Some(100), 10, FileAction::Upload),
                make_file("match2.txt", "target", FileStatus::Completed, Some(200), 20, FileAction::Upload),
                make_file("other.txt", "different", FileStatus::Completed, Some(300), 30, FileAction::Upload),
            ],
        );
        let result = collect_cycle_files_for_label(&sync, "target", 10);
        assert_eq!(result.len(), 2);
        let names: Vec<&str> = result.iter().map(|f| f.file_name.as_str()).collect();
        assert!(names.contains(&"match1.txt"));
        assert!(names.contains(&"match2.txt"));
        assert!(!names.contains(&"other.txt"));
    }

    #[test]
    fn collect_cycle_files_filters_out_non_completed() {
        let sync = test_runner();
        seed_session(
            &sync,
            vec![
                make_file("done.txt", "default", FileStatus::Completed, Some(100), 10, FileAction::Upload),
                make_file("uploading.txt", "default", FileStatus::Uploading, None, 20, FileAction::Upload),
                make_file("errored.txt", "default", FileStatus::Error, Some(200), 30, FileAction::Upload),
                make_file("pending.txt", "default", FileStatus::Pending, None, 40, FileAction::Upload),
            ],
        );
        let result = collect_cycle_files_for_label(&sync, "default", 10);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name, "done.txt");
    }

    #[test]
    fn collect_cycle_files_sorts_by_completed_at_descending() {
        // Multi-cycle residue scenario: old files from a previous
        // cycle share the label with newer files from the current
        // cycle. The helper must return the most-recent ones first
        // so that a `max_files` cap keeps the current cycle's files.
        let sync = test_runner();
        seed_session(
            &sync,
            vec![
                make_file("old.txt", "default", FileStatus::Completed, Some(100), 10, FileAction::Upload),
                make_file("newer.txt", "default", FileStatus::Completed, Some(300), 20, FileAction::Upload),
                make_file("newest.txt", "default", FileStatus::Completed, Some(500), 30, FileAction::Upload),
                make_file("middle.txt", "default", FileStatus::Completed, Some(200), 40, FileAction::Upload),
            ],
        );
        let result = collect_cycle_files_for_label(&sync, "default", 10);
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].file_name, "newest.txt");
        assert_eq!(result[1].file_name, "newer.txt");
        assert_eq!(result[2].file_name, "middle.txt");
        assert_eq!(result[3].file_name, "old.txt");
    }

    #[test]
    fn collect_cycle_files_caps_at_max_files_keeping_newest() {
        // Over-reporting guard: when `max_files` is smaller than the
        // matching set (multi-cycle residue from a long-running
        // session), keep the newest entries by `completed_at`.
        let sync = test_runner();
        seed_session(
            &sync,
            vec![
                make_file("old.txt", "default", FileStatus::Completed, Some(100), 10, FileAction::Upload),
                make_file("mid.txt", "default", FileStatus::Completed, Some(200), 20, FileAction::Upload),
                make_file("newest.txt", "default", FileStatus::Completed, Some(300), 30, FileAction::Upload),
            ],
        );
        let result = collect_cycle_files_for_label(&sync, "default", 2);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].file_name, "newest.txt");
        assert_eq!(result[1].file_name, "mid.txt");
    }

    #[test]
    fn collect_cycle_files_treats_missing_completed_at_as_oldest() {
        // Defensive: if a file landed in `Completed` without a
        // `completed_at` timestamp (partial-update race), the sort
        // fallback treats `None` as 0, pushing it to the end.
        let sync = test_runner();
        seed_session(
            &sync,
            vec![
                make_file("no_ts.txt", "default", FileStatus::Completed, None, 10, FileAction::Upload),
                make_file("with_ts.txt", "default", FileStatus::Completed, Some(500), 20, FileAction::Upload),
            ],
        );
        let result = collect_cycle_files_for_label(&sync, "default", 10);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].file_name, "with_ts.txt");
        assert_eq!(result[1].file_name, "no_ts.txt");
    }

    #[test]
    fn collect_cycle_files_preserves_action_variant() {
        // The FE `FileAction` union expects snake_case strings
        // ("upload", "download", "local_delete", "remote_delete"),
        // and serde produces those via `#[serde(rename_all)]` on the
        // upstream enum. Ensure the helper carries the variant
        // through unchanged.
        let sync = test_runner();
        seed_session(
            &sync,
            vec![
                make_file("up.txt", "default", FileStatus::Completed, Some(100), 10, FileAction::Upload),
                make_file("down.txt", "default", FileStatus::Completed, Some(200), 20, FileAction::Download),
                make_file("ldel.txt", "default", FileStatus::Completed, Some(300), 30, FileAction::LocalDelete),
                make_file("rdel.txt", "default", FileStatus::Completed, Some(400), 40, FileAction::RemoteDelete),
            ],
        );
        let result = collect_cycle_files_for_label(&sync, "default", 10);
        assert_eq!(result.len(), 4);
        // Sorted newest first: rdel (400), ldel (300), down (200), up (100)
        assert_eq!(result[0].action, FileAction::RemoteDelete);
        assert_eq!(result[1].action, FileAction::LocalDelete);
        assert_eq!(result[2].action, FileAction::Download);
        assert_eq!(result[3].action, FileAction::Upload);
    }
}
