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

    /// Set the AppHandle once it's available (replaces the old `set_app_handle`).
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
    fn on_event(&self, event: SyncEvent) {
        let Some(app) = self.app() else { return };

        match event {
            SyncEvent::SyncStarted {
                label, uploads, downloads, local_deletes, remote_deletes,
                upload_files, download_files, local_delete_files, remote_delete_files,
            } => {
                let _ = app.emit("hcfs_sync_started", serde_json::json!({
                    "label": label,
                    "uploads": uploads, "downloads": downloads,
                    "localDeletes": local_deletes, "remoteDeletes": remote_deletes,
                    "uploadFiles": upload_files, "downloadFiles": download_files,
                    "localDeleteFiles": local_delete_files, "remoteDeleteFiles": remote_delete_files,
                }));
            }
            SyncEvent::SyncCompleted {
                label, files_uploaded, files_downloaded,
                files_deleted_locally, files_deleted_remotely,
                conflicts_resolved, conflicts_skipped,
            } => {
                let _ = app.emit("hcfs_sync_completed", serde_json::json!({
                    "label": label,
                    "files_uploaded": files_uploaded, "files_downloaded": files_downloaded,
                    "files_deleted_locally": files_deleted_locally,
                    "files_deleted_remotely": files_deleted_remotely,
                    "conflicts_resolved": conflicts_resolved, "conflicts_skipped": conflicts_skipped,
                }));
            }
            SyncEvent::SyncError { label, error, retry_in_secs, consecutive_failures } => {
                let _ = app.emit("hcfs_sync_error", serde_json::json!({
                    "label": label, "error": error,
                    "retry_in_secs": retry_in_secs, "consecutive_failures": consecutive_failures,
                }));
            }
            SyncEvent::SyncStopped { label } => {
                let _ = app.emit("hcfs_sync_stopped", serde_json::json!({ "label": label }));
            }
            SyncEvent::SyncReset { account_id, message } => {
                let _ = app.emit("hcfs_sync_reset", serde_json::json!({
                    "account_id": account_id, "message": message,
                }));
            }
            SyncEvent::PlanReady {
                label, uploads, downloads, local_deletes, remote_deletes,
                upload_files, download_files, local_delete_files, remote_delete_files,
            } => {
                let _ = app.emit("hcfs_sync_plan_ready", serde_json::json!({
                    "label": label,
                    "uploads": uploads, "downloads": downloads,
                    "localDeletes": local_deletes, "remoteDeletes": remote_deletes,
                    "uploadFiles": upload_files, "downloadFiles": download_files,
                    "localDeleteFiles": local_delete_files, "remoteDeleteFiles": remote_delete_files,
                }));
            }
            SyncEvent::ConflictsPending { label, staged } => {
                let _ = app.emit("hcfs_conflicts_pending", serde_json::json!({
                    "label": label, "staged": staged,
                }));
            }
            SyncEvent::UploadProgress { label, bytes, total, path } => {
                let _ = app.emit("hcfs_upload_progress", serde_json::json!({
                    "label": label, "bytes": bytes, "total": total, "path": path,
                }));
            }
            SyncEvent::DownloadProgress { label, bytes, total, path } => {
                let _ = app.emit("hcfs_download_progress", serde_json::json!({
                    "label": label, "bytes": bytes, "total": total, "path": path,
                }));
            }
            SyncEvent::ScanProgress { label, scanned, path } => {
                let _ = app.emit("hcfs_scan_progress", serde_json::json!({
                    "label": label, "scanned": scanned, "path": path,
                }));
            }
            SyncEvent::FetchProgress { label, fetched, total } => {
                let _ = app.emit("hcfs_fetch_progress", serde_json::json!({
                    "label": label, "fetched": fetched, "total": total,
                }));
            }
            SyncEvent::FileTransferComplete { label } => {
                let _ = app.emit("hcfs_file_transfer_complete", serde_json::json!({
                    "label": label,
                }));
            }
            SyncEvent::HealthChanged { health } => {
                let _ = app.emit("hcfs_connectivity_changed", &health);
            }
            SyncEvent::FolderRecovered { label } => {
                let _ = app.emit("hcfs_folder_recovered", serde_json::json!({ "label": label }));
            }
            SyncEvent::ReviewModeTimeout { label } => {
                let _ = app.emit("hcfs_review_mode_timeout", serde_json::json!({ "label": label }));
            }
            SyncEvent::ActivityUpdated => {
                let _ = app.emit("hcfs_activity_updated", ());
            }
            SyncEvent::AuthRequired { error } => {
                let _ = app.emit("hcfs_auth_relogin_required", serde_json::json!({ "error": error }));
            }
            SyncEvent::ProgressSnapshot { snapshot } => {
                let _ = app.emit("sync_progress_snapshot", &snapshot);
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
            let acct = app_state.current_account_id().map_err(|e| e.to_string())?;

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
            app.state::<crate::app_state::AppState>()
                .current_account_id()
                .map_err(|e| e.to_string())
        })
    }
}
