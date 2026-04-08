//! Tauri adapter for hcfs-client sync runner.
//!
//! Implements `SyncEventHandler` and `SyncCallbacks` to bridge the library's
//! generic sync engine to Tauri's IPC event system and desktop-specific
//! operations (auth tokens, database queries).

use hcfs_client::engine::events::{SyncCallbacks, SyncEvent, SyncEventHandler};
use std::future::Future;
use std::pin::Pin;
use tauri::{AppHandle, Emitter};

use super::events;
use crate::sync::progress::{cap_file_list, cap_snapshot_files};

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

}

/// Inspect the progress tracker after a sync cycle completes to update
/// per-file failure counters. If any file reaches the threshold, emit
/// the `FILES_FAILED_REPEATEDLY` event to trigger the frontend modal.
fn update_failure_counts(app: &AppHandle, label: &str) {
    use hcfs_client::engine::progress::state::FileStatus;
    use tauri::Manager;

    let app_state = app.state::<crate::app_state::AppState>();
    let failure_state = &app_state.file_failures;

    // Single lock acquisition: extract failed and succeeded paths together
    // so progress state can't change between reads.
    let (failed_files, succeeded_paths): (Vec<(String, Option<String>)>, Vec<String>) = {
        let state = app_state.sync.progress.lock_state();
        let Some(session) = &state.current_session else {
            return;
        };
        let failed: Vec<_> = session
            .files
            .values()
            .filter(|f| f.label.as_ref() == label && matches!(f.status, FileStatus::Error))
            .map(|f| (f.path.to_string(), f.error.as_deref().map(str::to_owned)))
            .collect();
        let succeeded: Vec<_> = session
            .files
            .values()
            .filter(|f| f.label.as_ref() == label && matches!(f.status, FileStatus::Completed))
            .map(|f| f.path.to_string())
            .collect();
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
                // Emit a fresh snapshot so the frontend sees the finalized
                // session state (is_active=false, effective_completed=true).
                // `finalize_session_for_label` in hcfs-client updates progress
                // state but does not emit a snapshot itself, so without this
                // the UI would stay on the last pre-finalization snapshot.
                {
                    use tauri::Manager;
                    let app_state = app.state::<crate::app_state::AppState>();
                    app_state.sync.emit_snapshot(true);
                }

                // Update per-file failure counters from the finalized session.
                update_failure_counts(&app, &label);

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
                    },
                );
            }
            SyncEvent::SyncError {
                label,
                error,
                retry_in_secs,
                consecutive_failures,
            } => {
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
                cap_snapshot_files(&mut snapshot);
                let _ = app.emit(events::PROGRESS_SNAPSHOT, &snapshot);
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
