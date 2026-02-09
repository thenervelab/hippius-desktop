//! Shared sync state and cancellation primitives.
//!
//! This module provides two things:
//! 1. A global cancellation token (`GLOBAL_CANCEL_TOKEN`) to signal the sync loop to stop
//! 2. A shared sync state (`HCFS_SYNC_STATE`) tracking whether a sync is in progress,
//!    the last sync time, and a ring buffer of recent file activity
//!
//! Both are used by `hcfs_drive.rs` (the sync loop) and `commands/syncing.rs` (the
//! progress handlers that record uploads/downloads).

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Wry};

// === Cancellation ===

/// Global cancellation flag. Set to `true` to signal the sync loop to exit.
/// Checked each iteration of the sync loop in `hcfs_drive::start_sync_loop`.
pub static GLOBAL_CANCEL_TOKEN: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

/// Signal the sync loop to stop at its next check point.
pub fn request_cancel() {
    GLOBAL_CANCEL_TOKEN.store(true, Ordering::SeqCst);
}

/// Clear the cancellation flag (called before starting a new sync loop).
pub fn clear_cancel() {
    GLOBAL_CANCEL_TOKEN.store(false, Ordering::SeqCst);
}

/// Check if cancellation has been requested.
pub fn is_cancelled() -> bool {
    GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst)
}

// === Sync State ===

/// Shared sync state. Holds current sync status, last sync time, and a ring buffer
/// of recent activity items (max 100). Uses `std::sync::Mutex` (not tokio) because
/// it's accessed from both sync (blocking) progress callbacks and async code.
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

// === Pending Activity Buffer ===
//
// Progress callbacks fire when bytes are sent to the network, but before the
// server confirms success. To avoid recording "uploaded" activity for files
// that the server actually rejected (e.g. 502), we buffer pending items here
// and only commit them to `HCFS_SYNC_STATE` after `trigger_sync` confirms
// the sync outcome was successful.

pub static PENDING_ACTIVITY: Lazy<Arc<Mutex<Vec<SyncActivityItem>>>> =
    Lazy::new(|| Arc::new(Mutex::new(Vec::new())));

/// Add an item to the pending activity buffer (called from progress callbacks).
pub fn add_pending_activity(item: SyncActivityItem) {
    let mut pending = PENDING_ACTIVITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pending.push(item);
}

/// Commit all pending activity items to the real activity log.
/// Called after a successful sync cycle.
pub fn commit_pending_activity() {
    let items: Vec<SyncActivityItem> = {
        let mut pending = PENDING_ACTIVITY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.drain(..).collect()
    };
    if !items.is_empty() {
        let mut state = HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for item in items {
            state.add_activity(item);
        }
    }
}

/// Discard all pending activity items.
/// Called when a sync cycle fails or produces no uploads/downloads.
pub fn discard_pending_activity() {
    let mut pending = PENDING_ACTIVITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pending.clear();
}

// === Tauri Commands ===
#[tauri::command]
pub fn get_sync_status() -> HcfsSyncState {
    HCFS_SYNC_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[tauri::command]
pub fn get_sync_activity(limit: Option<usize>) -> Vec<SyncActivityItem> {
    let state = HCFS_SYNC_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
