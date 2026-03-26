//! Typed event payloads and constants for Tauri sync events.
//!
//! All frontend-facing events use these structs instead of ad-hoc
//! `serde_json::json!` to get compile-time field checking.

use crate::hcfs_drive::StagedChanges;
use serde::Serialize;

// ── Event Name Constants ─────────────────────────────────────────────

pub const SYNC_STARTED: &str = "hcfs_sync_started";
pub const SYNC_COMPLETED: &str = "hcfs_sync_completed";
pub const SYNC_ERROR: &str = "hcfs_sync_error";
pub const SYNC_STOPPED: &str = "hcfs_sync_stopped";
pub const SYNC_PLAN_READY: &str = "hcfs_sync_plan_ready";
pub const SYNC_RESET: &str = "hcfs_sync_reset";
pub const UPLOAD_PROGRESS: &str = "hcfs_upload_progress";
pub const DOWNLOAD_PROGRESS: &str = "hcfs_download_progress";
pub const SCAN_PROGRESS: &str = "hcfs_scan_progress";
pub const FETCH_PROGRESS: &str = "hcfs_fetch_progress";
pub const CONNECTIVITY_CHANGED: &str = "hcfs_connectivity_changed";
pub const FOLDER_RECOVERED: &str = "hcfs_folder_recovered";
pub const REVIEW_MODE_TIMEOUT: &str = "hcfs_review_mode_timeout";
pub const CONFLICTS_PENDING: &str = "hcfs_conflicts_pending";
pub const AUTH_TOKEN_EXPIRED: &str = "hcfs_auth_token_expired";
pub const ACTIVITY_UPDATED: &str = "hcfs_activity_updated";

// ── Event Payloads ───────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct LabelPayload {
    pub label: String,
}

#[derive(Serialize, Clone)]
pub struct SyncStartedPayload {
    pub label: String,
    pub uploads: usize,
    pub downloads: usize,
    pub local_deletes: usize,
    pub remote_deletes: usize,
    pub upload_files: Vec<String>,
    pub download_files: Vec<String>,
    pub local_delete_files: Vec<String>,
    pub remote_delete_files: Vec<String>,
}

impl SyncStartedPayload {
    /// Empty payload emitted before the plan is ready.
    pub fn empty(label: &str) -> Self {
        Self {
            label: label.to_string(),
            uploads: 0,
            downloads: 0,
            local_deletes: 0,
            remote_deletes: 0,
            upload_files: Vec::new(),
            download_files: Vec::new(),
            local_delete_files: Vec::new(),
            remote_delete_files: Vec::new(),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct SyncCompletedPayload {
    pub label: String,
    pub files_uploaded: usize,
    pub files_downloaded: usize,
    pub files_deleted_locally: usize,
    pub files_deleted_remotely: usize,
    pub conflicts_resolved: usize,
    pub conflicts_skipped: usize,
}

impl SyncCompletedPayload {
    pub fn from_outcome(label: &str, o: &hcfs_client::sync::SyncOutcome) -> Self {
        Self {
            label: label.to_string(),
            files_uploaded: o.files_uploaded,
            files_downloaded: o.files_downloaded,
            files_deleted_locally: o.files_deleted_locally,
            files_deleted_remotely: o.files_deleted_remotely,
            conflicts_resolved: o.conflicts_resolved,
            conflicts_skipped: o.conflicts_skipped,
        }
    }

    pub fn zeros(label: &str) -> Self {
        Self {
            label: label.to_string(),
            files_uploaded: 0,
            files_downloaded: 0,
            files_deleted_locally: 0,
            files_deleted_remotely: 0,
            conflicts_resolved: 0,
            conflicts_skipped: 0,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct SyncErrorPayload {
    pub label: String,
    pub error: String,
    pub retry_in_secs: u64,
    pub consecutive_failures: i64,
}

#[derive(Serialize, Clone)]
pub struct ConflictsPendingPayload {
    pub label: String,
    pub staged: StagedChanges,
}

#[derive(Serialize, Clone)]
pub struct TransferProgressPayload {
    pub label: String,
    pub bytes: u64,
    pub total: u64,
    pub path: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ScanProgressPayload {
    pub label: String,
    pub scanned: u64,
    pub path: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FetchProgressPayload {
    pub label: String,
    pub fetched: u64,
    pub total: u64,
}

#[derive(Serialize, Clone)]
pub struct SyncResetPayload {
    pub account_id: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
pub struct SyncPlanReadyPayload {
    pub label: String,
    pub uploads: usize,
    pub downloads: usize,
    pub local_deletes: usize,
    pub remote_deletes: usize,
    pub upload_files: Vec<String>,
    pub download_files: Vec<String>,
    pub local_delete_files: Vec<String>,
    pub remote_delete_files: Vec<String>,
}
