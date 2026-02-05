use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Wry};

// === Cancellation ===
pub static GLOBAL_CANCEL_TOKEN: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

pub fn request_cancel() {
    GLOBAL_CANCEL_TOKEN.store(true, Ordering::SeqCst);
}
pub fn clear_cancel() {
    GLOBAL_CANCEL_TOKEN.store(false, Ordering::SeqCst);
}
pub fn is_cancelled() -> bool {
    GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst)
}

// === Sync State ===
pub static HCFS_SYNC_STATE: Lazy<Arc<Mutex<HcfsSyncState>>> =
    Lazy::new(|| Arc::new(Mutex::new(HcfsSyncState::default())));

const MAX_ACTIVITY: usize = 100;

#[derive(Default, Clone, Serialize)]
pub struct HcfsSyncState {
    pub is_syncing: bool,
    pub last_sync_time: Option<i64>,
    pub recent_activity: VecDeque<SyncActivityItem>,
}

#[derive(Clone, Serialize)]
pub struct SyncActivityItem {
    pub file_name: String,
    pub action: String, // "uploaded", "downloaded", "deleted", "conflict"
    pub timestamp: i64,
    pub size_bytes: u64,
}

impl HcfsSyncState {
    pub fn add_activity(&mut self, item: SyncActivityItem) {
        self.recent_activity.push_front(item);
        self.recent_activity.truncate(MAX_ACTIVITY);
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

// === Tauri Commands ===
#[tauri::command]
pub fn get_sync_status() -> HcfsSyncState {
    HCFS_SYNC_STATE.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_sync_activity(limit: Option<usize>) -> Vec<SyncActivityItem> {
    let state = HCFS_SYNC_STATE.lock().unwrap();
    state
        .recent_activity
        .iter()
        .take(limit.unwrap_or(50))
        .cloned()
        .collect()
}

#[tauri::command]
pub fn app_close(app: AppHandle<Wry>) {
    app.exit(0);
}
