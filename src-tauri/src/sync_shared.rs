//! Shared sync types.
//!
//! All mutable state has been moved to `crate::sync_engine::SyncEngine`.
//! This module retains only the type definitions and Tauri commands.

use serde::Serialize;
use std::collections::VecDeque;

// === Connectivity Health ===

pub use crate::sync_logic::ConnectivityStatus;

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

// === Sync State Types ===

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
}

// === Combined Sync State ===

#[derive(Default, Clone, Serialize)]
pub struct CombinedSyncState {
    pub is_syncing: bool,
    pub last_sync_time: Option<i64>,
    pub recent_activity: VecDeque<SyncActivityItem>,
}

// Tauri commands for sync status are in commands/sync_status.rs (binary-only).
