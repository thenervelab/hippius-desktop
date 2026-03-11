//! Shared sync state and cancellation primitives.
//!
//! This module provides two things:
//! 1. A global cancellation token (`GLOBAL_CANCEL_TOKEN`) to signal the sync loop to stop
//! 2. A shared sync state (`HCFS_SYNC_STATES`) tracking per-drive sync status,
//!    last sync time, and a ring buffer of recent file activity
//!
//! Both are used by `hcfs_drive.rs` (the sync loop) and `commands/syncing.rs` (the
//! progress handlers that record uploads/downloads).

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Wry};

// === Connectivity Health ===

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityStatus {
    Connected,
    ServerUnreachable,
    NetworkOffline,
    AuthExpired,
    Degraded,
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncEngineHealth {
    pub status: ConnectivityStatus,
    pub last_check_time: Option<i64>,
    pub last_successful_check: Option<i64>,
    pub consecutive_failures: u32,
    pub server_version: Option<String>,
    pub error_message: Option<String>,
}

impl Default for SyncEngineHealth {
    fn default() -> Self {
        Self {
            status: ConnectivityStatus::Connected,
            last_check_time: None,
            last_successful_check: None,
            consecutive_failures: 0,
            server_version: None,
            error_message: None,
        }
    }
}

pub static SYNC_ENGINE_HEALTH: Lazy<Arc<Mutex<SyncEngineHealth>>> =
    Lazy::new(|| Arc::new(Mutex::new(SyncEngineHealth::default())));

pub fn get_health() -> SyncEngineHealth {
    SYNC_ENGINE_HEALTH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

pub fn update_health<F>(f: F)
where
    F: FnOnce(&mut SyncEngineHealth),
{
    let mut health = SYNC_ENGINE_HEALTH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut health);
}

pub fn reset_health() {
    let mut health = SYNC_ENGINE_HEALTH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *health = SyncEngineHealth::default();
}

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

// === Review Mode Timeout ===

/// Timestamp (epoch millis) when review mode was entered, or 0 if not in review mode.
/// Used to auto-exit review mode after a timeout so sync doesn't stall indefinitely.
pub static REVIEW_MODE_ENTERED_AT: AtomicI64 = AtomicI64::new(0);

/// Record that review mode was entered right now.
pub fn set_review_entered() {
    let now = chrono::Utc::now().timestamp_millis();
    REVIEW_MODE_ENTERED_AT.store(now, Ordering::Release);
}

/// Clear the review mode timestamp.
pub fn clear_review_entered() {
    REVIEW_MODE_ENTERED_AT.store(0, Ordering::Release);
}

/// Check if review mode has been active longer than `timeout_secs`.
pub fn is_review_timed_out(timeout_secs: i64) -> bool {
    let entered = REVIEW_MODE_ENTERED_AT.load(Ordering::Acquire);
    if entered == 0 {
        return false;
    }
    let now = chrono::Utc::now().timestamp_millis();
    (now - entered) > timeout_secs * 1000
}

// === Consecutive Sync Failures (for backoff) ===

/// Number of consecutive sync failures across all drives.
/// Reset to 0 on any successful sync. Used to compute backoff delay.
pub static CONSECUTIVE_SYNC_FAILURES: AtomicI64 = AtomicI64::new(0);

pub fn record_sync_failure() -> i64 {
    CONSECUTIVE_SYNC_FAILURES.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn reset_sync_failures() {
    CONSECUTIVE_SYNC_FAILURES.store(0, Ordering::SeqCst);
}

pub fn get_sync_failures() -> i64 {
    CONSECUTIVE_SYNC_FAILURES.load(Ordering::SeqCst)
}

// === Sync State ===

/// Per-drive sync states, keyed by label.
/// Uses `std::sync::Mutex` (not tokio) because it's accessed from both
/// sync (blocking) progress callbacks and async code.
pub static HCFS_SYNC_STATES: Lazy<Arc<Mutex<HashMap<String, HcfsSyncState>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

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
    pub label: String,
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

/// Get or create a sync state for a given label.
pub fn get_or_create_state(label: &str) -> HcfsSyncState {
    let states = HCFS_SYNC_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    states.get(label).cloned().unwrap_or_default()
}

/// Update the sync state for a given label.
pub fn update_state<F>(label: &str, f: F)
where
    F: FnOnce(&mut HcfsSyncState),
{
    let mut states = HCFS_SYNC_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = states.entry(label.to_string()).or_default();
    f(state);
}

/// Reset all sync states.
pub fn reset_all_states() {
    let mut states = HCFS_SYNC_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    states.clear();
}

/// Remove state for a specific label.
pub fn remove_state(label: &str) {
    let mut states = HCFS_SYNC_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    states.remove(label);
}

// === Pending Activity Buffer ===
//
// Progress callbacks fire when bytes are sent to the network, but before the
// server confirms success. To avoid recording "uploaded" activity for files
// that the server actually rejected (e.g. 502), we buffer pending items here
// and only commit them to `HCFS_SYNC_STATES` after `trigger_sync` confirms
// the sync outcome was successful.

pub static PENDING_ACTIVITY: Lazy<Arc<Mutex<Vec<SyncActivityItem>>>> =
    Lazy::new(|| Arc::new(Mutex::new(Vec::new())));

/// Add an item to the pending activity buffer (called from progress callbacks).
/// Deduplicates: if an item with the same file_name + action + label already
/// exists in the buffer, the duplicate is silently dropped. The hcfs-client
/// progress callback can fire the "completed" event more than once per file.
pub fn add_pending_activity(item: SyncActivityItem) {
    let mut pending = PENDING_ACTIVITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let already_exists = pending.iter().any(|existing| {
        existing.file_name == item.file_name
            && existing.action == item.action
            && existing.label == item.label
            && existing.size_bytes == item.size_bytes
    });
    if !already_exists {
        pending.push(item);
    }
}

/// Commit pending activity items for a specific label to the real activity log.
/// Called after a successful sync cycle.
pub fn commit_pending_activity_for_label(label: &str) {
    let items: Vec<SyncActivityItem> = {
        let mut pending = PENDING_ACTIVITY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (matching, remaining): (Vec<_>, Vec<_>) =
            pending.drain(..).partition(|item| item.label == label);
        *pending = remaining;
        matching
    };
    if !items.is_empty() {
        println!(
            "[Sync] Committing {} activity items for label '{}' to recent files",
            items.len(),
            label
        );
        update_state(label, |state| {
            for item in &items {
                println!("[Sync] -> {} ({})", item.file_name, item.action);
            }
            for item in items {
                state.add_activity(item);
            }
        });
    }
}

/// Discard pending activity items for a specific label.
/// Called when a sync cycle fails or produces no uploads/downloads.
pub fn discard_pending_activity_for_label(label: &str) {
    let mut pending = PENDING_ACTIVITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = pending.len();
    pending.retain(|item| item.label != label);
    let removed = before - pending.len();
    if removed > 0 {
        println!(
            "[Sync] Discarding {} pending activity items for label '{}' (sync failed or no real transfers)",
            removed, label
        );
    }
}

/// Discard all pending activity items (used on full stop).
pub fn discard_all_pending_activity() {
    let mut pending = PENDING_ACTIVITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !pending.is_empty() {
        println!(
            "[Sync] Discarding all {} pending activity items",
            pending.len()
        );
    }
    pending.clear();
}

// === Combined Sync State (for backward-compat Tauri commands) ===

#[derive(Default, Clone, Serialize)]
pub struct CombinedSyncState {
    pub is_syncing: bool,
    pub last_sync_time: Option<i64>,
    pub recent_activity: VecDeque<SyncActivityItem>,
}

// === Tauri Commands ===
#[tauri::command]
pub fn get_sync_status() -> CombinedSyncState {
    let states = HCFS_SYNC_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let is_syncing = states.values().any(|s| s.is_syncing);
    let last_sync_time = states.values().filter_map(|s| s.last_sync_time).max();

    let mut all_activity: Vec<SyncActivityItem> = states
        .values()
        .flat_map(|s| s.recent_activity.iter().cloned())
        .collect();
    all_activity.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    all_activity.truncate(MAX_ACTIVITY);

    CombinedSyncState {
        is_syncing,
        last_sync_time,
        recent_activity: all_activity.into(),
    }
}

#[tauri::command]
pub fn get_sync_activity(limit: Option<usize>, label: Option<String>) -> Vec<SyncActivityItem> {
    let states = HCFS_SYNC_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let max = limit.unwrap_or(50);

    if let Some(lbl) = label {
        states
            .get(&lbl)
            .map(|s| s.recent_activity.iter().take(max).cloned().collect())
            .unwrap_or_default()
    } else {
        let mut all: Vec<SyncActivityItem> = states
            .values()
            .flat_map(|s| s.recent_activity.iter().cloned())
            .collect();
        all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        all.truncate(max);
        all
    }
}

#[tauri::command]
pub fn get_sync_engine_health() -> SyncEngineHealth {
    get_health()
}

#[tauri::command]
pub fn app_close(app: AppHandle<Wry>) {
    app.exit(0);
}
