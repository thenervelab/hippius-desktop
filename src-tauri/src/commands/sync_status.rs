//! Tauri commands for sync status queries.
//!
//! These are thin wrappers that delegate to `SyncEngine` methods.

use crate::sync_shared::{CombinedSyncState, SyncActivityItem, SyncEngineHealth};
use tauri::{AppHandle, Wry};

/// Return the combined sync state across all drives.
#[tauri::command]
pub fn get_sync_status(state: tauri::State<'_, crate::app_state::AppState>) -> CombinedSyncState {
    state.sync.get_sync_status()
}

/// Return recent sync activity, optionally filtered by drive label.
#[tauri::command]
pub fn get_sync_activity(state: tauri::State<'_, crate::app_state::AppState>, limit: Option<usize>, label: Option<String>) -> Vec<SyncActivityItem> {
    state.sync.get_sync_activity(limit, label)
}

/// Return the current server connectivity health status.
#[tauri::command]
pub fn get_sync_engine_health(state: tauri::State<'_, crate::app_state::AppState>) -> SyncEngineHealth {
    state.sync.get_health()
}

/// Gracefully exit the application.
#[tauri::command]
pub fn app_close(app: AppHandle<Wry>) {
    app.exit(0);
}
