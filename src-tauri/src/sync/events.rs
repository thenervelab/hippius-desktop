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
/// Emitted the moment hcfs-client classifies a per-file upload or download
/// as failed (e.g. server returned 402 InsufficientBalance, 5xx, network
/// error). Carries a typed [`FileFailureKindPayload`] so the FE can switch
/// on the failure category without parsing display strings.
///
/// Per-file failures are NOT cycle failures — the existing
/// `hcfs_sync_error` channel is reserved for cycle-level errors (cancel,
/// auth, etc.). A single 402'd file inside an otherwise-healthy cycle
/// surfaces here and through the snapshot's `FileProgressStatus::Error`
/// row; cycle-level `SyncCompleted` still fires with the survivors.
pub const FILE_FAILED: &str = "hcfs_file_failed";
/// Emitted when a user-initiated upload (`add_file` / `add_files` /
/// `add_folder`) is in its disk-copy + encryption window before any
/// byte of network transfer fires. The frontend renders a top-of-page
/// banner while `active = true`. State is owned by
/// `crate::sync::upload_processing::UploadProcessingState`.
pub const UPLOAD_PROCESSING: &str = "hcfs_upload_processing";
/// Emitted when an `InsufficientBalance` (HTTP 402) per-file failure
/// arrives at the bridge. Carries the latest `balance_cents` /
/// `required_cents` from the server response plus a running
/// `file_count` of 402'd files in the current cycle. The FE renders a
/// dedicated "Out of credits" banner — distinct from the generic
/// `hcfs_file_failed` per-file detail event so the banner can show a
/// "Top up" CTA and survive across multiple 402'd files without
/// flickering. State is owned by
/// `crate::sync::credits_exhausted::CreditsExhaustedState`.
pub const CREDITS_EXHAUSTED: &str = "hcfs_credits_exhausted";
/// Emitted when the per-drive first-reconcile retry budget is
/// exhausted (every attempt failed with either retryable or
/// terminal errors). Tells the frontend to surface a per-drive
/// "couldn't refresh upload dates" banner so the user knows the
/// "DATE UPLOADED" column may be sparse for this drive. Cleared
/// when the same drive next emits `ACTIVITY_UPDATED` (e.g. after a
/// successful sync cycle backfills the missing timestamps).
///
/// Payload is [`MetadataStalePayload`]: `{ label, reason }` where
/// `reason` is a short human-readable string. Distinct from the
/// per-cycle `SYNC_ERROR` channel because reconcile failure is a
/// metadata-only condition — the drive itself is still usable.
pub const METADATA_STALE: &str = "hcfs_metadata_stale";

/// Wire payload for [`METADATA_STALE`]. `label` is the drive's
/// stable label string; `reason` is for display only (the FE
/// renders it under the banner heading).
#[derive(Clone, Debug, serde::Serialize)]
pub struct MetadataStalePayload {
    pub label: String,
    pub reason: String,
}

/// Exact stringification of [`hcfs_client::sync::SyncError::Cancelled`].
///
/// The upstream library stringifies cancel results (both user-initiated — pause,
/// remove, logout teardown — and internal stall-watchdog self-cancels) through
/// the same `SyncError::Cancelled` variant before routing them into
/// `SyncEvent::SyncError`. The desktop bridge treats every error matching this
/// marker as non-user-actionable and silences it: cancels never produce
/// persisted notifications.
///
/// A regression test (`cancelled_marker_matches_upstream` in this module)
/// asserts the marker still matches after an `hcfs-client` bump — if the
/// upstream reword ever diverges, silencing breaks and cancels start creating
/// "Sync Failed" rows again.
pub const CANCELLED_MARKER: &str = "Operation cancelled by user";

#[cfg(test)]
mod tests {
    use super::*;

    /// Catches upstream string drift when bumping the `hcfs-client` git rev.
    #[test]
    fn cancelled_marker_matches_upstream() {
        assert_eq!(hcfs_client::sync::SyncError::Cancelled.to_string(), CANCELLED_MARKER);
    }
}

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

/// One file from a completed sync cycle, carried in
/// [`SyncCompletedPayload::files`] so the notification layer never has to
/// scrape the snapshot atom (which is truncated to
/// [`crate::sync::progress::MAX_EVENT_FILES`] entries and causes
/// count-vs-list mismatches for cycles with more than that many files).
///
/// `action` is the upstream [`hcfs_client::engine::progress::state::FileAction`]
/// which serde-renames to `snake_case` ("upload", "download",
/// "local_delete", "remote_delete") — matching the FE
/// `FileAction` union in `app/lib/types/syncSnapshot.ts`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFileDetail {
    pub file_name: String,
    pub total_bytes: u64,
    pub action: hcfs_client::engine::progress::state::FileAction,
}

/// Emitted when a sync cycle finishes successfully.
///
/// `files` carries the list of files this cycle completed (up to
/// [`crate::sync::progress::MAX_NOTIFICATION_FILES`] entries, sorted by
/// `completed_at` descending). The FE notification hook reads this
/// field directly instead of scraping the snapshot atom, so the
/// description header ("84 files uploaded") and the detail badge
/// ("48 uploaded") can't diverge.
#[derive(Serialize, Clone)]
pub struct SyncCompletedPayload {
    pub label: String,
    pub files_uploaded: usize,
    pub files_downloaded: usize,
    pub files_deleted_locally: usize,
    pub files_deleted_remotely: usize,
    pub conflicts_resolved: usize,
    pub conflicts_skipped: usize,
    /// Files completed in this cycle. Populated by
    /// `collect_cycle_files_for_label` at emit time. Callers that don't
    /// have session-state access (e.g. `zeros`) leave this empty.
    pub files: Vec<SyncedFileDetail>,
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
            files: Vec::new(),
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
            files: Vec::new(),
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

/// Desktop-side serializable mirror of [`hcfs_client::engine::events::FileFailureKind`].
///
/// The upstream enum does NOT derive `Serialize` (verified at
/// `hcfs-client/src/engine/events.rs:33`), so we cannot forward it as-is
/// through Tauri's JSON IPC. Translating to a local enum is the right
/// boundary: it (a) gives us a `Serialize` impl without forking
/// hcfs-client, (b) pins the wire format the FE consumes independently of
/// upstream variant additions (the upstream type is `#[non_exhaustive]`),
/// and (c) keeps the FE's `kind` discriminant stable in `camelCase` per
/// existing convention. The `#[non_exhaustive]` annotation matches the
/// upstream's stability contract — future upstream variants will be
/// surfaced as `Other` until we extend the translation map.
///
/// Wire shape (tagged union, internally discriminated by `kind`):
/// ```json
/// {"kind":"insufficientBalance","balanceCents":12,"requiredCents":100}
/// {"kind":"serverError","status":500}
/// {"kind":"network"}
/// {"kind":"other","message":"unrecognised upload failure"}
/// ```
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[non_exhaustive]
pub enum FileFailureKindPayload {
    /// Server returned HTTP 402 — account credit balance is below the
    /// storage cost. Mirrors `FileFailureKind::InsufficientBalance`.
    #[serde(rename_all = "camelCase")]
    InsufficientBalance { balance_cents: u64, required_cents: u64 },
    /// Server returned a non-402 HTTP error code (5xx, 416, 429, …).
    /// `status` is the wire status the FE may dispatch on.
    ServerError { status: u16 },
    /// Transport-layer failure — connection refused, DNS, TLS, timeout.
    /// No HTTP status because no response was received.
    Network,
    /// Fallback for failures we have not categorised. `message` is for
    /// display only — the FE MUST NOT parse it as a stable contract.
    Other { message: String },
}

impl From<&hcfs_client::engine::events::FileFailureKind> for FileFailureKindPayload {
    fn from(kind: &hcfs_client::engine::events::FileFailureKind) -> Self {
        use hcfs_client::engine::events::FileFailureKind as K;
        match kind {
            K::InsufficientBalance {
                balance_cents,
                required_cents,
            } => Self::InsufficientBalance {
                balance_cents: *balance_cents,
                required_cents: *required_cents,
            },
            K::ServerError { status } => Self::ServerError { status: *status },
            K::Network => Self::Network,
            // Upstream `Other(String)` carries display text. Clone-on-translate is
            // unavoidable (we own the wire payload); the alternative would be borrowing
            // and the bridge needs an owned struct for `app.emit`.
            K::Other(msg) => Self::Other { message: msg.clone() },
            // `#[non_exhaustive]` upstream: future variants render as `Other` with
            // their debug form. The translation map should be extended when a new
            // upstream variant ships — until then, the FE's `other` branch
            // keeps the wire contract intact.
            other => Self::Other {
                message: format!("{other:?}"),
            },
        }
    }
}

/// Payload for [`FILE_FAILED`] — emitted once per per-file failure inside
/// a sync cycle (in addition to, not in place of, the per-cycle
/// `SyncCompleted.files_failed` counter and the per-file snapshot row).
///
/// `path` is the **plan-time** snapshot from
/// `hcfs_client::engine::events::SyncEvent::FileFailed::path`, not the
/// live filesystem path. If the local file was renamed between plan and
/// failure, this is the pre-rename path — the FE may need to reconcile
/// against the live filesystem (see upstream doc comment on
/// `SyncEvent::FileFailed::path`).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileFailedPayload {
    pub label: String,
    pub path: String,
    pub file_id: String,
    pub kind: FileFailureKindPayload,
    pub http_status: Option<u16>,
}

/// Payload for [`CREDITS_EXHAUSTED`] — emitted alongside (not in place of)
/// `FILE_FAILED` whenever a per-file failure carries the
/// `InsufficientBalance` kind.
///
/// `balance_cents` / `required_cents` reflect the **latest** server
/// response — concurrent failures inside the same cycle may report
/// different values if the user partially tops up mid-cycle; the FE
/// banner shows the most recent values, matching server truth at the
/// last observed failure. `file_count` is the running total of 402'd
/// files for `label` in the current sync cycle, sourced from
/// [`crate::sync::credits_exhausted::CreditsExhaustedState::record_failure`].
/// It resets to zero on the next `SyncStarted` for that label.
///
/// Note: this event is NOT a substitute for `FILE_FAILED`. The bridge
/// emits both — the FE row icon listens to `FILE_FAILED`, the banner
/// listens to this. Routing them through one event would force the
/// banner to filter by kind and would make Task 2.7's per-file-row
/// invariant fragile.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreditsExhaustedPayload {
    pub label: String,
    pub balance_cents: u64,
    pub required_cents: u64,
    pub file_count: u32,
}
