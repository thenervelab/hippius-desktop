//! Tauri adapter for hcfs-client sync runner.
//!
//! Implements `SyncEventHandler` and `SyncCallbacks` to bridge the library's
//! generic sync engine to Tauri's IPC event system and desktop-specific
//! operations (auth tokens, database queries).

use hcfs_client::engine::events::{SyncCallbacks, SyncEvent, SyncEventHandler};
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

use super::events;
use crate::sync::progress::{SyncSnapshot, cap_file_list, prepare_snapshot_for_emit};

/// Process-wide cursor holding the last-emitted snapshot fingerprint.
///
/// Pre-emit short-circuit: if the new snapshot hashes to the same value as
/// the last emitted one, skip `app.emit` entirely. The throttle in
/// `progress::update_file_progress` already gates by time (250 ms); this
/// gate adds a content check so a state-transition emit (`emit_snapshot(true)`,
/// not throttled) immediately followed by a chunk-tick emit with identical
/// headline data only goes over the IPC once. `0` is reserved for "never
/// emitted, always allow first emit through."
static LAST_EMITTED_FINGERPRINT: AtomicU64 = AtomicU64::new(0);

/// Bridge between the hcfs-client sync engine and Tauri's event system.
///
/// The `app` handle is set exactly once during app setup via [`set_app_handle`]
/// and read on every sync event. [`OnceLock`] provides lock-free reads after
/// initialization, eliminating contention on the hot event path.
pub struct TauriSyncBridge {
    app: std::sync::OnceLock<AppHandle>,
}

impl Default for TauriSyncBridge {
    fn default() -> Self {
        Self {
            app: std::sync::OnceLock::new(),
        }
    }
}

impl TauriSyncBridge {
    /// Create a new bridge with no `AppHandle` set yet.
    ///
    /// Call [`set_app_handle`] once during app setup to wire in the handle
    /// before the sync engine fires its first event.
    pub fn new() -> Self {
        Self {
            app: std::sync::OnceLock::new(),
        }
    }

    /// Sets the Tauri app handle. Must be called exactly once during setup.
    ///
    /// Subsequent calls are silently ignored (the first handle wins).
    pub fn set_app_handle(&self, handle: AppHandle) {
        let _ = self.app.set(handle);
    }

    /// Clone the stored `AppHandle`, if one has been set via [`set_app_handle`].
    ///
    /// Returns `None` before `set_app_handle` is called (i.e., during the brief
    /// window between `AppState::new()` and the first `setup()` call). Event
    /// handlers silently no-op when `None` is returned.
    fn app(&self) -> Option<AppHandle> {
        self.app.get().cloned()
    }

    /// Emit the `hippius_auth_ready` signal. Called from login and
    /// session-restore once `AuthInfo` has been fully written. The FE
    /// uses this as a retry trigger for `auto_init_sync` on slow
    /// systems where the first invocation lost the race against
    /// `rehydrate_full_session`.
    ///
    /// No-op if the `AppHandle` has not been wired in yet — at that
    /// point there's no FE to receive the event anyway.
    pub fn emit_auth_ready(&self) {
        if let Some(app) = self.app() {
            let _ = app.emit(events::AUTH_READY, ());
        }
    }
}

/// Inspect the progress tracker after a sync cycle completes to update
/// per-file failure counters. If any file reaches the threshold, emit
/// the `FILES_FAILED_REPEATEDLY` event to trigger the frontend modal.
fn update_failure_counts(app: &AppHandle, label: &str) {
    use hcfs_client::engine::progress::state::FileStatus;
    use tauri::Manager;

    let app_state = app.state::<crate::app_state::AppState>();
    let failure_state = &app_state.file_failures;

    // Single lock acquisition AND single pass over the file map: split
    // entries into the two outcome buckets in one scan instead of two
    // back-to-back sweeps. For a drive that just completed thousands of
    // files this halves the work done under the progress lock.
    let (failed_files, succeeded_paths): (Vec<(String, Option<String>)>, Vec<String>) = {
        let state = app_state.sync.progress.lock_state();
        let Some(session) = &state.current_session else {
            return;
        };
        let mut failed: Vec<(String, Option<String>)> = Vec::new();
        let mut succeeded: Vec<String> = Vec::new();
        for f in session.files.values() {
            if f.label.as_ref() != label {
                continue;
            }
            match f.status {
                FileStatus::Error => failed.push((f.path.to_string(), f.error.as_deref().map(str::to_owned))),
                FileStatus::Completed => succeeded.push(f.path.to_string()),
                _ => {}
            }
        }
        (failed, succeeded)
    };

    if failed_files.is_empty() {
        // All files succeeded for this label -- clear counters.
        failure_state.clear_all_for_label(label);
        return;
    }

    // Clear counters for files that succeeded this cycle.
    for path in &succeeded_paths {
        failure_state.clear_failure(label, path);
    }

    // Increment counters for failed files.
    let mut any_newly_at_threshold = false;
    for (path, error) in &failed_files {
        failure_state.record_failure(label, path, error.clone());
        if failure_state.just_reached_threshold(label, path) {
            any_newly_at_threshold = true;
        }
    }

    // Emit the event if any file just reached the threshold.
    if any_newly_at_threshold {
        let at_threshold = failure_state.files_at_threshold();
        if !at_threshold.is_empty() {
            let _ = app.emit(
                super::events::FILES_FAILED_REPEATEDLY,
                super::events::FilesFailedRepeatedlyPayload { files: at_threshold },
            );
        }
    }
}

impl SyncEventHandler for TauriSyncBridge {
    #[expect(
        clippy::too_many_lines,
        reason = "One match arm per SyncEvent variant, each with a distinct payload shape. Splitting per-variant requires either trait objects or N helper functions with different signatures; the giant match keeps the mapping between Rust event and Tauri event name auditable in one place."
    )]
    fn on_event(&self, event: SyncEvent) {
        let Some(app) = self.app() else { return };

        match event {
            SyncEvent::SyncStarted {
                label,
                uploads,
                downloads,
                local_deletes,
                remote_deletes,
                mut upload_files,
                mut download_files,
                mut local_delete_files,
                mut remote_delete_files,
            } => {
                cap_file_list(&mut upload_files);
                cap_file_list(&mut download_files);
                cap_file_list(&mut local_delete_files);
                cap_file_list(&mut remote_delete_files);
                let _ = app.emit(
                    events::SYNC_STARTED,
                    events::SyncStartedPayload {
                        label,
                        uploads,
                        downloads,
                        local_deletes,
                        remote_deletes,
                        upload_files,
                        download_files,
                        local_delete_files,
                        remote_delete_files,
                    },
                );
            }
            SyncEvent::SyncCompleted {
                label,
                files_uploaded,
                files_downloaded,
                files_deleted_locally,
                files_deleted_remotely,
                conflicts_resolved,
                conflicts_skipped,
            } => {
                use tauri::Manager;

                // Belt-and-suspenders snapshot emit. As of hcfs >= a26f4296,
                // `finalize_session_for_label` already emits a snapshot at
                // its exit, so the success and conflicts-skipped code paths
                // are covered upstream. This emit additionally covers the
                // `ConflictsPending` branch in `dispatch_sync_result` which
                // fires `SyncCompleted` without calling
                // `finalize_session_for_label` — without it the UI would
                // miss the conflict-pending transition. Idempotent if the
                // upstream emit already fired this cycle.
                let app_state = app.state::<crate::app_state::AppState>();
                app_state.sync.emit_snapshot(true);

                // Update per-file failure counters from the finalized session.
                update_failure_counts(&app, &label);

                // Snapshot the cycle's completed files from the session
                // state BEFORE the next cycle starts. `MAX_NOTIFICATION_FILES`
                // caps the payload so a 10k-file migration doesn't blow up
                // the webview. The second cap — the reported completion
                // counts — prevents a multi-cycle residue of stale
                // Completed files in the session map from over-reporting.
                let reported_count = files_uploaded + files_downloaded + files_deleted_locally + files_deleted_remotely;
                let max_files = reported_count.min(crate::sync::progress::MAX_NOTIFICATION_FILES);
                let files = crate::sync::progress::collect_cycle_files_for_label(&app_state.sync, &label, max_files);

                let _ = app.emit(
                    events::SYNC_COMPLETED,
                    events::SyncCompletedPayload {
                        label,
                        files_uploaded,
                        files_downloaded,
                        files_deleted_locally,
                        files_deleted_remotely,
                        conflicts_resolved,
                        conflicts_skipped,
                        files,
                    },
                );
            }
            SyncEvent::SyncError {
                label,
                error,
                retry_in_secs,
                consecutive_failures,
            } => {
                // Cancels (pause, remove, logout teardown, stall watchdog
                // self-cancel) are never user-actionable and must not produce
                // persisted "Sync Failed" notifications. The upstream library
                // routes every cancellation through `SyncError::Cancelled`,
                // which stringifies to `events::CANCELLED_MARKER` — silence
                // at the bridge so the `hcfs_sync_error` channel only
                // carries real failures (network, auth, rate limit, etc.).
                if error == events::CANCELLED_MARKER {
                    tracing::debug!(label = %label, "Silenced sync cancel (not emitted as error)");
                    return;
                }
                let _ = app.emit(
                    events::SYNC_ERROR,
                    events::SyncErrorPayload {
                        label,
                        error,
                        retry_in_secs,
                        consecutive_failures,
                    },
                );
            }
            SyncEvent::SyncStopped { label } => {
                let _ = app.emit(events::SYNC_STOPPED, events::LabelPayload { label });
            }
            SyncEvent::SyncReset { account_id, message } => {
                let _ = app.emit(events::SYNC_RESET, events::SyncResetPayload { account_id, message });
            }
            SyncEvent::PlanReady {
                label,
                uploads,
                downloads,
                local_deletes,
                remote_deletes,
                mut upload_files,
                mut download_files,
                mut local_delete_files,
                mut remote_delete_files,
            } => {
                cap_file_list(&mut upload_files);
                cap_file_list(&mut download_files);
                cap_file_list(&mut local_delete_files);
                cap_file_list(&mut remote_delete_files);
                let _ = app.emit(
                    events::SYNC_PLAN_READY,
                    events::SyncPlanReadyPayload {
                        label,
                        uploads,
                        downloads,
                        local_deletes,
                        remote_deletes,
                        upload_files,
                        download_files,
                        local_delete_files,
                        remote_delete_files,
                    },
                );
            }
            SyncEvent::ConflictsPending { label, staged } => {
                let _ = app.emit(events::CONFLICTS_PENDING, events::ConflictsPendingPayload { label, staged });
            }
            // Per-chunk transfer progress is served via the throttled
            // `sync_progress_snapshot` event emitted from
            // `crate::sync::progress::update_file_progress`. Forwarding these
            // variants to Tauri would flood the webview. See lifecycle.rs
            // `handle_transfer_progress` for the live path.
            SyncEvent::UploadProgress { .. } | SyncEvent::DownloadProgress { .. } => {}
            SyncEvent::ScanProgress { label, scanned, path } => {
                let _ = app.emit(events::SCAN_PROGRESS, events::ScanProgressPayload { label, scanned, path });
            }
            SyncEvent::FetchProgress { label, fetched, total } => {
                let _ = app.emit(events::FETCH_PROGRESS, events::FetchProgressPayload { label, fetched, total });
            }
            SyncEvent::FileTransferComplete { label } => {
                let _ = app.emit(events::FILE_TRANSFER_COMPLETE, events::LabelPayload { label });
            }
            SyncEvent::HealthChanged { health } => {
                let _ = app.emit(events::CONNECTIVITY_CHANGED, &health);
            }
            SyncEvent::FolderRecovered { label } => {
                let _ = app.emit(events::FOLDER_RECOVERED, events::LabelPayload { label });
            }
            SyncEvent::ReviewModeTimeout { label } => {
                let _ = app.emit(events::REVIEW_MODE_TIMEOUT, events::LabelPayload { label });
            }
            SyncEvent::ActivityUpdated => {
                let _ = app.emit(events::ACTIVITY_UPDATED, ());
            }
            SyncEvent::AuthRequired { error } => {
                let _ = app.emit(events::AUTH_RELOGIN_REQUIRED, events::AuthRequiredPayload { error });
            }
            SyncEvent::ProgressSnapshot { mut snapshot } => {
                // `prepare_snapshot_for_emit` applies BOTH the stalled-completion
                // fixup and the file-cap. Without the fixup, hcfs-client's own
                // file-watcher-driven `changes_pending=true` leaves `is_active`
                // stuck at `true` indefinitely after all files are synced, so
                // `widget_state`, `effective_in_progress`, `effective_completed`,
                // and `status_variant` all still say "syncing" despite 100%
                // progress. Only the bootstrap `sp_get_snapshot` path used to
                // apply the fixup, which meant a session that stalled after the
                // widget/tray had already mounted would display "Syncing: 100%"
                // forever. See `progress::fixup_stalled_completion`.
                prepare_snapshot_for_emit(&mut snapshot);

                // Skip the IPC if this snapshot is structurally identical to
                // the last one we emitted. The throttle in
                // `progress::update_file_progress` already gates by time;
                // this fingerprint gate covers the case where two emits land
                // back-to-back with the same content (e.g. an
                // `emit_snapshot(true)` after a no-op state mutation, or a
                // state-transition emit that races with a chunk-tick emit
                // both seeing the same headline data). Avoiding `app.emit`
                // skips the JSON serialization + IPC tunnel.
                let fp = snapshot_fingerprint(&snapshot);
                if try_claim_snapshot_fingerprint(&LAST_EMITTED_FINGERPRINT, fp) {
                    let _ = app.emit(events::PROGRESS_SNAPSHOT, &snapshot);
                }
            }
        }
    }
}

impl SyncCallbacks for TauriSyncBridge {
    fn refresh_auth_token(&self) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>> {
        Box::pin(async {
            let app = self.app().ok_or_else(|| "AppHandle not available".to_string())?;
            use tauri::Manager;
            let app_state = app.state::<crate::app_state::AppState>();
            let pool = app_state.pool().map_err(|e| e.to_string())?;
            let acct = app_state.current_account_id().map_err(|e| e.clone())?;

            crate::auth::service::refresh_auth_token_internal(pool, &app, &acct).await?;

            // Return the fresh token for the runner to update live drives
            crate::auth::tokens::get_api_token(pool, &acct)
                .await
                .map_err(|e| format!("Failed to read refreshed token: {e}"))?
                .ok_or_else(|| "No token found after refresh".to_string())
        })
    }

    fn is_token_expiring(&self) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        Box::pin(async {
            let Some(app) = self.app() else { return false };
            use tauri::Manager;
            let app_state = app.state::<crate::app_state::AppState>();
            if let (Ok(pool), Ok(acct)) = (app_state.pool(), app_state.current_account_id()) {
                crate::auth::tokens::is_token_expiring(pool, &acct, crate::auth::tokens::TOKEN_REFRESH_MARGIN_SECS).await
            } else {
                false
            }
        })
    }

    fn device_name(&self) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        Box::pin(async {
            let app = self.app()?;
            use tauri::Manager;
            let app_state = app.state::<crate::app_state::AppState>();
            let pool = app_state.pool().ok()?;
            sqlx::query_scalar::<_, String>("SELECT device_name FROM device_settings WHERE id = 1")
                .fetch_optional(pool)
                .await
                .ok()
                .flatten()
        })
    }

    fn current_account_id(&self) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>> {
        Box::pin(async {
            let app = self.app().ok_or_else(|| "AppHandle not available".to_string())?;
            use tauri::Manager;
            app.state::<crate::app_state::AppState>().current_account_id().map_err(|e| e.clone())
        })
    }
}

/// Compute a small content fingerprint for a `SyncSnapshot`.
///
/// Hashes the headline scalar fields plus a per-file (path, action, status,
/// bytes_transferred, bytes_encrypted) tuple so any user-visible change in
/// per-file progress flips the fingerprint. Pure ordering changes in the
/// `files` vec do flip the fingerprint by design — the FE renders rows in
/// the order Rust sent them, so a reorder IS a visible change. `0` is
/// reserved for the never-emitted sentinel and is remapped to `1` to keep
/// it distinct from the gate's baseline.
fn snapshot_fingerprint(s: &SyncSnapshot) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.is_active.hash(&mut h);
    s.progress_bytes.hash(&mut h);
    s.bytes_expected.hash(&mut h);
    s.total_files.hash(&mut h);
    s.completed_files.hash(&mut h);
    s.failed_files.hash(&mut h);
    s.retry_in_secs.hash(&mut h);
    s.last_error.hash(&mut h);
    s.expected_uploads.hash(&mut h);
    s.expected_downloads.hash(&mut h);
    s.expected_local_deletes.hash(&mut h);
    s.expected_remote_deletes.hash(&mut h);
    s.completed_at.hash(&mut h);
    s.widget_state.hash(&mut h);
    s.widget_visible.hash(&mut h);
    s.combined_progress_bytes.hash(&mut h);
    s.combined_bytes_expected.hash(&mut h);
    s.deleted_count.hash(&mut h);
    s.synced_count.hash(&mut h);
    s.actual_total.hash(&mut h);
    s.status_variant.hash(&mut h);
    s.sync_direction.hash(&mut h);
    s.effective_in_progress.hash(&mut h);
    s.effective_completed.hash(&mut h);
    for f in &s.files {
        f.path.as_ref().hash(&mut h);
        // FileAction and FileStatus derive Hash via #[derive(Hash)] in hcfs-client.
        format!("{:?}", f.action).hash(&mut h);
        format!("{:?}", f.status).hash(&mut h);
        f.bytes_transferred.hash(&mut h);
        f.bytes_encrypted.hash(&mut h);
        f.total_bytes.hash(&mut h);
        f.error.as_ref().map(AsRef::as_ref).hash(&mut h);
    }
    let h = h.finish();
    if h == 0 { 1 } else { h }
}

/// Atomically claim the right to emit a snapshot whose fingerprint is `fp`.
///
/// Returns `true` if `fp` differs from the previously stored fingerprint
/// (caller should emit). Returns `false` if `fp` matches what was last
/// emitted (caller should skip the IPC). Initial state of `0` always
/// allows the first emit through.
fn try_claim_snapshot_fingerprint(last: &AtomicU64, fp: u64) -> bool {
    let prev = last.swap(fp, Ordering::AcqRel);
    prev != fp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_fingerprint_always_emits() {
        let last = AtomicU64::new(0);
        assert!(try_claim_snapshot_fingerprint(&last, 42));
        assert_eq!(last.load(Ordering::Acquire), 42);
    }

    #[test]
    fn duplicate_fingerprint_skips_emit() {
        let last = AtomicU64::new(0);
        assert!(try_claim_snapshot_fingerprint(&last, 42));
        // Same fingerprint again — caller should skip the IPC.
        assert!(!try_claim_snapshot_fingerprint(&last, 42));
        assert_eq!(last.load(Ordering::Acquire), 42);
    }

    #[test]
    fn changed_fingerprint_emits() {
        let last = AtomicU64::new(0);
        assert!(try_claim_snapshot_fingerprint(&last, 42));
        assert!(try_claim_snapshot_fingerprint(&last, 99));
        assert_eq!(last.load(Ordering::Acquire), 99);
    }
}
