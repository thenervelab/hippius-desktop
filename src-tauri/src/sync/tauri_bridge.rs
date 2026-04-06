//! Tauri adapter for hcfs-client sync runner.
//!
//! Implements `SyncEventHandler` and `SyncCallbacks` to bridge the library's
//! generic sync engine to Tauri's IPC event system and desktop-specific
//! operations (auth tokens, database queries).

use hcfs_client::engine::events::{SyncCallbacks, SyncEvent, SyncEventHandler};
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter};

use super::events;

/// Tauri adapter that implements both sync traits.
///
/// Stores the `AppHandle` behind a mutex so it can be created before the
/// handle is available (at `AppState::new()` time) and wired up later
/// (in the Tauri setup callback).
pub struct TauriSyncBridge {
    app: StdMutex<Option<AppHandle>>,
}

impl Default for TauriSyncBridge {
    fn default() -> Self {
        Self { app: StdMutex::new(None) }
    }
}

impl TauriSyncBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register the Tauri `AppHandle` for use by sync callbacks and event emission.
    /// Called exactly once from `main.rs` setup after the Tauri app is built.
    pub fn set_app_handle(&self, handle: AppHandle) {
        if let Ok(mut guard) = self.app.lock() {
            *guard = Some(handle);
        }
    }

    fn app(&self) -> Option<AppHandle> {
        self.app.lock().ok().and_then(|g| g.clone())
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
                upload_files,
                download_files,
                local_delete_files,
                remote_delete_files,
            } => {
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
                upload_files,
                download_files,
                local_delete_files,
                remote_delete_files,
            } => {
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
            SyncEvent::ProgressSnapshot { snapshot } => {
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
