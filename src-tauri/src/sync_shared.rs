//! Shared sync types.
//!
//! All mutable state has been moved to `crate::sync_engine::SyncEngine`.
//! This module retains only the type definitions and Tauri commands.

use serde::Serialize;
use std::collections::VecDeque;

pub use crate::sync_logic::ConnectivityStatus;

/// Health snapshot of the sync engine's connection to the HCFS server.
///
/// Emitted to the frontend via `hcfs_connectivity_changed` events so the
/// UI can show connection status indicators and retry countdowns.
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

/// Maximum recent activity items retained per drive.
const MAX_ACTIVITY: usize = 100;

/// Per-drive sync state including review mode and recent activity log.
///
/// Stored in `SyncEngine::drives_state` keyed by drive label. The
/// `in_review` flag blocks auto-sync for this drive only, allowing
/// the user to review conflicts without affecting other drives.
#[derive(Default, Clone, Serialize)]
pub struct HcfsSyncState {
    pub is_syncing: bool,
    pub last_sync_time: Option<i64>,
    pub recent_activity: VecDeque<SyncActivityItem>,
    /// Per-drive review mode: true when conflicts are pending user review.
    /// Only blocks THIS drive's auto-sync, not other drives.
    #[serde(skip)]
    pub in_review: bool,
    /// Epoch-millis when review mode was entered (0 = not in review).
    #[serde(skip)]
    pub review_entered_at: i64,
    /// Epoch-millis until which review mode should not be re-entered.
    /// Set after user resolves or dismisses conflicts to prevent the
    /// same conflict from immediately re-triggering the banner.
    #[serde(skip)]
    pub review_cooldown_until: i64,
}

/// A single entry in the drive's recent activity log, shown in the UI's
/// activity feed. Includes the human-readable filename and action verb.
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

/// Aggregated sync state across all drives, returned by `get_sync_status`.
///
/// Merges per-drive states into a single view for the frontend status bar.
#[derive(Default, Clone, Serialize)]
pub struct CombinedSyncState {
    pub is_syncing: bool,
    pub last_sync_time: Option<i64>,
    pub recent_activity: VecDeque<SyncActivityItem>,
}

// Tauri commands for sync status are in commands/sync_status.rs (binary-only).
