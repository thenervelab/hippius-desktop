//! Tauri event name constants for sync events.
//!
//! Event payload types have moved to hcfs-client's `SyncEvent` enum.
//! These constants remain because they are Tauri-specific channel names
//! used by `tauri_bridge.rs` and some desktop modules.

/// Emitted when a sync cycle begins for a drive.
pub const SYNC_STARTED: &str = "hcfs_sync_started";
/// Emitted when a single file upload or download completes.
pub const FILE_TRANSFER_COMPLETE: &str = "hcfs_file_transfer_complete";
/// Emitted when a sync cycle finishes successfully.
pub const SYNC_COMPLETED: &str = "hcfs_sync_completed";
/// Emitted when a sync cycle fails, with retry timing.
pub const SYNC_ERROR: &str = "hcfs_sync_error";
/// Emitted when a drive's sync loop is stopped.
pub const SYNC_STOPPED: &str = "hcfs_sync_stopped";
/// Emitted after staging when the file manifest is finalized.
pub const SYNC_PLAN_READY: &str = "hcfs_sync_plan_ready";
/// Emitted when the sync engine is fully reset.
pub const SYNC_RESET: &str = "hcfs_sync_reset";
/// Local filesystem scan progress.
pub const SCAN_PROGRESS: &str = "hcfs_scan_progress";
/// Remote file-list fetch progress.
pub const FETCH_PROGRESS: &str = "hcfs_fetch_progress";
/// Emitted when server connectivity status changes.
pub const CONNECTIVITY_CHANGED: &str = "hcfs_connectivity_changed";
/// Emitted after a remote folder is auto-recovered.
pub const FOLDER_RECOVERED: &str = "hcfs_folder_recovered";
/// Emitted when review mode times out.
pub const REVIEW_MODE_TIMEOUT: &str = "hcfs_review_mode_timeout";
/// Emitted when conflicts are detected that need user review.
pub const CONFLICTS_PENDING: &str = "hcfs_conflicts_pending";
/// Emitted when the recent activity list changes.
pub const ACTIVITY_UPDATED: &str = "hcfs_activity_updated";
/// Emitted when the backend detects credentials are invalid and re-login is needed.
pub const AUTH_RELOGIN_REQUIRED: &str = "hcfs_auth_relogin_required";
/// Emitted when `AuthInfo` has been fully populated post-login (mnemonic
/// login or keychain-backed session restore). The frontend uses this as
/// a retry trigger for `auto_init_sync` on slow systems where the FE
/// invokes auto-init before Rust has finished writing `AuthInfo.mnemonic`.
/// Payload is empty — it's a pure signal.
pub const AUTH_READY: &str = "hippius_auth_ready";
/// Emitted with a full progress snapshot for the sync status widget.
pub const PROGRESS_SNAPSHOT: &str = "sync_progress_snapshot";
/// Emitted whenever a single drive's status changes (Active → Paused,
/// Paused → Active, init success/failure, etc.). Payload is a
/// `DriveStatusChangedPayload`. See `sync/drive_status.rs`.
///
/// Replaces the old global `SYNC_ENGINE_STATUS_CHANGED` event which
/// collapsed multi-drive state into a single global enum.
pub const DRIVE_STATUS_CHANGED: &str = "hcfs_drive_status_changed";
/// Emitted when `remove_drive` deletes a drive's `sync_paths` row.
/// Payload is a `LabelPayload`. The frontend uses this to drop the
/// entry from its per-drive status map.
pub const DRIVE_REMOVED: &str = "hcfs_drive_removed";
/// Emitted when files have repeatedly failed to sync (threshold reached).
pub const FILES_FAILED_REPEATEDLY: &str = "hcfs_files_failed_repeatedly";

// ── Payload structs for direct Tauri emission ──────────────────────────
// Used by lifecycle.rs (progress callbacks) and control.rs (manual sync).
// The library's SyncEvent enum handles most events, but these are needed
// for desktop-specific code paths that emit directly.

use hcfs_client::engine::manager::StagedChanges;
use serde::Serialize;

/// Minimal payload carrying only a drive label.
#[derive(Serialize, Clone)]
pub struct LabelPayload {
    pub label: String,
}

/// Payload for `DRIVE_STATUS_CHANGED`. Carries the full drive entry
/// (label, basename, on-disk path, new status) so the frontend can
/// update its per-drive status map without re-fetching
/// `get_all_drive_statuses` AND without holding a stale `path` mirror
/// for newly-configured drives.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatusChangedPayload {
    pub label: String,
    pub folder_name: String,
    pub path: String,
    pub status: crate::sync::drive_status::DriveStatus,
}

/// Emitted when a sync cycle finishes successfully.
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

/// Emitted when a sync cycle fails.
#[derive(Serialize, Clone)]
pub struct SyncErrorPayload {
    pub label: String,
    pub error: String,
    pub retry_in_secs: u64,
    pub consecutive_failures: i64,
}

/// Emitted when conflicts need user review.
#[derive(Serialize, Clone)]
pub struct ConflictsPendingPayload {
    pub label: String,
    pub staged: StagedChanges,
}

/// Local scan progress.
#[derive(Serialize, Clone)]
pub struct ScanProgressPayload {
    pub label: String,
    pub scanned: u64,
    pub path: Option<String>,
}

/// Remote fetch progress.
#[derive(Serialize, Clone)]
pub struct FetchProgressPayload {
    pub label: String,
    pub fetched: u64,
    pub total: u64,
}

/// Emitted when the sync engine is fully reset.
#[derive(Serialize, Clone)]
pub struct SyncResetPayload {
    pub account_id: String,
    pub message: String,
}

/// Emitted after staging when the sync plan is finalized.
#[derive(Serialize, Clone)]
pub struct SyncPlanReadyPayload {
    pub label: String,
    pub uploads: usize,
    pub downloads: usize,
    #[serde(rename = "localDeletes")]
    pub local_deletes: usize,
    #[serde(rename = "remoteDeletes")]
    pub remote_deletes: usize,
    #[serde(rename = "uploadFiles")]
    pub upload_files: Vec<String>,
    #[serde(rename = "downloadFiles")]
    pub download_files: Vec<String>,
    #[serde(rename = "localDeleteFiles")]
    pub local_delete_files: Vec<String>,
    #[serde(rename = "remoteDeleteFiles")]
    pub remote_delete_files: Vec<String>,
}

/// Emitted at the start of a sync cycle.
#[derive(Serialize, Clone)]
pub struct SyncStartedPayload {
    pub label: String,
    pub uploads: usize,
    pub downloads: usize,
    #[serde(rename = "localDeletes")]
    pub local_deletes: usize,
    #[serde(rename = "remoteDeletes")]
    pub remote_deletes: usize,
    #[serde(rename = "uploadFiles")]
    pub upload_files: Vec<String>,
    #[serde(rename = "downloadFiles")]
    pub download_files: Vec<String>,
    #[serde(rename = "localDeleteFiles")]
    pub local_delete_files: Vec<String>,
    #[serde(rename = "remoteDeleteFiles")]
    pub remote_delete_files: Vec<String>,
}

impl SyncStartedPayload {
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

/// Emitted when the backend detects credentials are invalid and re-login is needed.
#[derive(Serialize, Clone)]
pub struct AuthRequiredPayload {
    pub error: String,
}

/// Emitted when files have failed to sync repeatedly.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilesFailedRepeatedlyPayload {
    pub files: Vec<crate::sync::failure_tracking::FailedFileInfo>,
}
