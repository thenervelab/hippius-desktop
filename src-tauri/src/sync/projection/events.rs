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
/// Emitted when a folder-entity sync actually changed a drive's registered
/// directory set (registered / unregistered / materialized / removed a folder).
///
/// The FE listings read folder entities through `list_sync_folder_grouped`'s
/// `folder_entries_local` overlay, and that cache is only updated after the
/// server round-trip lands — long after the IPC that triggered the change
/// returned. Without this event a folder the user just deleted keeps rendering
/// as a `pending` row until some unrelated refresh. Payload: [`LabelPayload`].
pub const FOLDER_ENTITIES_CHANGED: &str = "hcfs_folder_entities_changed";
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

/// Gated sibling of [`SYNC_ERROR`] that drives the persisted "Sync Failed"
/// notification.
///
/// [`SYNC_ERROR`] fires on every real (non-cancel) failed cycle, so a flaky
/// endpoint emits it once per retry — too noisy to turn each into a
/// notification. This event is emitted only when a drive is *genuinely down*:
/// the bridge gates it on a per-label consecutive-failure count reaching a
/// threshold (see `crate::sync::error_notify`), so the frontend gets exactly
/// one notification per outage instead of one per cycle. A user-initiated
/// reviewed-conflict sync bypasses the gate and always emits on failure.
/// Carries the same [`SyncErrorPayload`] as [`SYNC_ERROR`].
pub const SYNC_FAILED_NOTIFY: &str = "hcfs_sync_failed_notify";
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

/// Marker hcfs-client puts on a `SyncError` when a MEMBER drive's folder is
/// missing from a successfully-fetched remote listing — the drive was removed
/// or the member's access was revoked. A listing FETCH failure keeps its
/// original error, so a server outage can never read as a revocation.
///
/// Re-exported (never re-typed) beside [`CANCELLED_MARKER`] because the
/// desktop will match it in `handle_sync_error` to route revocation into a
/// dedicated teardown/notification path (shared-drives Task 5); this task
/// lands only the import so the pin bump and the drift guard travel together.
/// `shared_drive_revoked_marker_is_pinned` freezes the exact wording an
/// upstream reword would silently break matching on.
pub use hcfs_client::engine::SHARED_DRIVE_REVOKED_MARKER;

#[cfg(test)]
mod tests {
    use super::*;

    /// Catches upstream string drift when bumping the `hcfs-client` git rev.
    #[test]
    fn cancelled_marker_matches_upstream() {
        assert_eq!(hcfs_client::sync::SyncError::Cancelled.to_string(), CANCELLED_MARKER);
    }

    /// The revoked marker is a re-export, so it can't drift from upstream —
    /// but the DESKTOP's matching logic is written against this exact
    /// wording. Freeze it so an upstream reword fails this build loudly
    /// instead of silently un-matching the revocation path.
    #[test]
    fn shared_drive_revoked_marker_is_pinned() {
        assert_eq!(
            SHARED_DRIVE_REVOKED_MARKER, "Shared drive is no longer accessible (removed or access revoked)",
            "upstream reworded SHARED_DRIVE_REVOKED_MARKER — update every desktop match site"
        );
    }

    /// Same drift guard as the cancel marker: we recognise this failure by the
    /// string upstream produces, so an upstream reword must fail here rather
    /// than silently demote the row back to a scary red "Error".
    #[test]
    fn changed_while_uploading_marker_matches_upstream() {
        let upstream = hcfs_client::sync::SyncError::Encryption("File was modified during encryption".into()).to_string();
        assert_eq!(upstream, CHANGED_WHILE_UPLOADING_MARKER);
    }

    #[test]
    fn mid_upload_modification_is_carved_out_of_other() {
        use hcfs_client::engine::events::FileFailureKind as K;
        let kind = K::Other(CHANGED_WHILE_UPLOADING_MARKER.to_string());
        assert!(
            matches!(FileFailureKindPayload::from(&kind), FileFailureKindPayload::ChangedWhileUploading),
            "a file that changed mid-upload must classify as its own retryable kind"
        );
    }

    #[test]
    fn unrelated_other_failures_stay_other() {
        use hcfs_client::engine::events::FileFailureKind as K;
        let kind = K::Other("Encryption error: key derivation failed".to_string());
        assert!(
            matches!(FileFailureKindPayload::from(&kind), FileFailureKindPayload::Other { .. }),
            "only the mid-upload-modification message may be carved out",
        );
    }

    #[test]
    fn changed_while_uploading_reads_as_transient_not_as_a_crypto_fault() {
        let reason = FileFailureKindPayload::ChangedWhileUploading.display_reason();
        assert!(
            !reason.to_lowercase().contains("encryption"),
            "the user-facing copy must not blame encryption — nothing is wrong with the crypto: {reason}"
        );
        assert!(
            reason.to_lowercase().contains("retry"),
            "the copy must tell the user it resolves itself: {reason}"
        );
    }

    #[test]
    fn transient_reason_round_trips_through_the_authored_string() {
        // The snapshot carries only the authored reason string, so the emit
        // path recognises a transient row by that string. Rust writes it and
        // Rust reads it — but if the two ever drift the widget silently loses
        // the amber "Retrying" tone, so pin the round trip.
        let authored = FileFailureKindPayload::ChangedWhileUploading.display_reason();
        assert!(is_transient_reason(&authored), "authored reason must be recognised: {authored}");
    }

    #[test]
    fn other_failure_reasons_are_not_treated_as_transient() {
        for kind in [
            FileFailureKindPayload::Network,
            FileFailureKindPayload::ServerError { status: 500 },
            FileFailureKindPayload::Other {
                message: "disk full".to_string(),
            },
        ] {
            let reason = kind.display_reason();
            assert!(!is_transient_reason(&reason), "{reason} must not read as transient");
        }
    }

    #[test]
    fn only_the_mid_upload_change_is_treated_as_self_resolving() {
        // `is_transient` drives an amber "Retrying" badge instead of a red
        // "Error". Marking a real failure transient would tell the user to wait
        // for a retry that never succeeds.
        assert!(FileFailureKindPayload::ChangedWhileUploading.is_transient());
        for kind in [
            FileFailureKindPayload::Network,
            FileFailureKindPayload::ServerError { status: 500 },
            FileFailureKindPayload::InsufficientBalance {
                balance_cents: 0,
                required_cents: 100,
            },
            FileFailureKindPayload::Other {
                message: "disk full".to_string(),
            },
        ] {
            assert!(!kind.is_transient(), "{kind:?} must not be presented as self-resolving");
        }
    }

    #[test]
    fn display_reason_insufficient_balance_formats_cents_as_dollars() {
        // 12¢ / 100¢ → "$0.12" / "$1.00"; integer math, no float rounding.
        let kind = FileFailureKindPayload::InsufficientBalance {
            balance_cents: 12,
            required_cents: 100,
        };
        assert_eq!(kind.display_reason(), "Insufficient credits — needs $1.00, you have $0.12.");
    }

    #[test]
    fn display_reason_server_error_includes_status() {
        let kind = FileFailureKindPayload::ServerError { status: 500 };
        assert_eq!(kind.display_reason(), "Server error (500). Please try again.");
    }

    #[test]
    fn display_reason_network_is_generic_connectivity_copy() {
        assert_eq!(
            FileFailureKindPayload::Network.display_reason(),
            "Network error — couldn't reach the server. Check your connection."
        );
    }

    #[test]
    fn display_reason_other_uses_message_or_falls_back_when_blank() {
        let with_msg = FileFailureKindPayload::Other {
            message: "  disk full  ".to_string(),
        };
        assert_eq!(with_msg.display_reason(), "disk full", "trims and uses the message");

        let blank = FileFailureKindPayload::Other { message: "   ".to_string() };
        assert_eq!(
            blank.display_reason(),
            "Sync failed. Please try again.",
            "blank message falls back to a generic line, never an empty reason"
        );
    }

    /// IPC wire-contract guard (Layer 0): pin the foreign `FileAction` wire
    /// strings the `hcfs_sync_completed` payload carries.
    ///
    /// `SyncedFileDetail.action` forwards hcfs-client's `FileAction` verbatim;
    /// its upstream `#[serde(rename_all = "snake_case")]` (verified at
    /// `hcfs-client/src/engine/progress/state.rs`) is the contract the FE
    /// `FileAction` union (`app/lib/types/syncSnapshot.ts`) switches on. A
    /// foreign rename — e.g. hcfs flipping to `camelCase` — would still compile
    /// here but silently break the FE's action dispatch; pinning the strings
    /// turns that into a failing test. (The enum also has `Encrypt`/`Decrypt`,
    /// but only these four reach a completed-cycle detail row.)
    #[test]
    fn synced_file_detail_pins_file_action_wire_strings() {
        use hcfs_client::engine::progress::state::FileAction;

        let cases = [
            (FileAction::Upload, "upload"),
            (FileAction::Download, "download"),
            (FileAction::LocalDelete, "local_delete"),
            (FileAction::RemoteDelete, "remote_delete"),
        ];
        for (action, wire) in cases {
            let detail = SyncedFileDetail {
                file_name: "f.txt".to_string(),
                total_bytes: 1,
                action,
            };
            let json = serde_json::to_value(&detail).expect("serialize SyncedFileDetail");
            assert_eq!(json["action"], wire, "FileAction wire string drifted (expected {wire})");

            // The desktop-owned envelope keys must stay camelCase.
            let mut keys: Vec<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["action", "fileName", "totalBytes"], "SyncedFileDetail key set drifted");
        }
    }

    /// IPC wire-contract guard (Layer 0): pin the foreign `StagedChanges` keys
    /// the `hcfs_conflicts_pending` payload nests under `staged`.
    ///
    /// `ConflictsPendingPayload.staged` forwards hcfs-client's `StagedChanges`
    /// verbatim (no upstream `rename_all` → snake_case keys, verified at
    /// `hcfs-client/src/engine/manager.rs`). The explicit struct literal below
    /// ALSO fails to compile if hcfs adds or removes a `StagedChanges` field,
    /// so this guards the field set at compile time and the wire keys at run
    /// time — both of which the FE conflict-review UI depends on.
    #[test]
    fn conflicts_pending_pins_staged_changes_wire_keys() {
        use hcfs_client::engine::manager::StagedChanges;

        let payload = ConflictsPendingPayload {
            label: "drive".to_string(),
            staged: StagedChanges {
                uploads: Vec::new(),
                downloads: Vec::new(),
                local_deletes: Vec::new(),
                remote_deletes: Vec::new(),
                conflicts: Vec::new(),
                unchanged_count: 0,
            },
        };
        let json = serde_json::to_value(&payload).expect("serialize ConflictsPendingPayload");

        let mut top: Vec<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        top.sort_unstable();
        assert_eq!(top, ["label", "staged"], "ConflictsPendingPayload top-level keys drifted");

        let mut staged: Vec<&str> = json["staged"].as_object().expect("staged object").keys().map(String::as_str).collect();
        staged.sort_unstable();
        assert_eq!(
            staged,
            ["conflicts", "downloads", "local_deletes", "remote_deletes", "unchanged_count", "uploads"],
            "StagedChanges wire keys drifted — an hcfs-client bump changed the conflict manifest shape"
        );
    }

    /// Serialize `payload` and return its top-level JSON keys as an
    /// order-independent set, so a wire-contract assertion can't be defeated
    /// by transcribing the expected list in the wrong order.
    fn keyset<T: serde::Serialize>(payload: T) -> std::collections::BTreeSet<String> {
        let value = serde_json::to_value(&payload).expect("payload serializes to JSON");
        value.as_object().expect("payload is a JSON object").keys().cloned().collect()
    }

    fn expect_keys(keys: &[&str]) -> std::collections::BTreeSet<String> {
        keys.iter().map(|key| (*key).to_string()).collect()
    }

    /// IPC wire-contract guard (Layer 0): pin the top-level JSON key set of
    /// every desktop-owned Tauri event payload in this module. Together with
    /// the foreign-type guards (snapshot / FileAction / StagedChanges) this
    /// covers the full IPC event surface — a field add/remove/rename here
    /// changes the JSON the matching FE listener reads, and pinning the key
    /// sets turns that into a failing `cargo test`. Each `#[serde(rename)]` /
    /// `rename_all = "camelCase"` choice is part of the contract and is
    /// asserted in its post-rename wire form. Change a shape ON PURPOSE → update
    /// the FE listener type in the same change, then this list.
    // One cohesive list of wire-shape assertions: every desktop event payload
    // pinned in one place, so a reader sees the whole contract at once.
    // Splitting it by payload would scatter the contract across functions for
    // no benefit, and reflowing during the rustfmt pass is what pushed it past
    // the limit.
    #[allow(clippy::too_many_lines, reason = "one contract, deliberately asserted in one place")]
    #[test]
    fn desktop_event_payload_key_sets_are_pinned() {
        use crate::sync::drive_status::DriveStatus;

        // `localDeletes`/`uploadFiles`/... are explicit per-field renames; the
        // PlanReady and Started payloads deliberately share this exact shape.
        let plan_keys = [
            "label",
            "uploads",
            "downloads",
            "localDeletes",
            "remoteDeletes",
            "uploadFiles",
            "downloadFiles",
            "localDeleteFiles",
            "remoteDeleteFiles",
        ];
        let plan_ready = SyncPlanReadyPayload {
            label: "d".to_string(),
            uploads: 0,
            downloads: 0,
            local_deletes: 0,
            remote_deletes: 0,
            upload_files: Vec::new(),
            download_files: Vec::new(),
            local_delete_files: Vec::new(),
            remote_delete_files: Vec::new(),
        };
        let started = SyncStartedPayload {
            label: "d".to_string(),
            uploads: 0,
            downloads: 0,
            local_deletes: 0,
            remote_deletes: 0,
            upload_files: Vec::new(),
            download_files: Vec::new(),
            local_delete_files: Vec::new(),
            remote_delete_files: Vec::new(),
        };

        assert_eq!(
            keyset(MetadataStalePayload {
                label: "d".to_string(),
                reason: "r".to_string()
            }),
            expect_keys(&["label", "reason"]),
            "MetadataStalePayload"
        );
        assert_eq!(keyset(LabelPayload { label: "d".to_string() }), expect_keys(&["label"]), "LabelPayload");
        assert_eq!(
            keyset(AuthRequiredPayload { error: "e".to_string() }),
            expect_keys(&["error"]),
            "AuthRequiredPayload"
        );
        assert_eq!(
            keyset(SyncResetPayload {
                account_id: "a".to_string(),
                message: "m".to_string()
            }),
            expect_keys(&["account_id", "message"]),
            "SyncResetPayload"
        );
        assert_eq!(
            keyset(SyncErrorPayload {
                label: "d".to_string(),
                error: "e".to_string(),
                retry_in_secs: 0,
                consecutive_failures: 0
            }),
            expect_keys(&["label", "error", "retry_in_secs", "consecutive_failures"]),
            "SyncErrorPayload"
        );
        assert_eq!(
            keyset(SyncCompletedPayload {
                label: "d".to_string(),
                files_uploaded: 0,
                files_downloaded: 0,
                files_deleted_locally: 0,
                files_deleted_remotely: 0,
                conflicts_resolved: 0,
                conflicts_skipped: 0,
                files: Vec::new(),
            }),
            expect_keys(&[
                "label",
                "files_uploaded",
                "files_downloaded",
                "files_deleted_locally",
                "files_deleted_remotely",
                "conflicts_resolved",
                "conflicts_skipped",
                "files",
            ]),
            "SyncCompletedPayload"
        );
        assert_eq!(keyset(plan_ready), expect_keys(&plan_keys), "SyncPlanReadyPayload");
        assert_eq!(keyset(started), expect_keys(&plan_keys), "SyncStartedPayload (must match PlanReady)");
        assert_eq!(
            keyset(FilesFailedRepeatedlyPayload { files: Vec::new() }),
            expect_keys(&["files"]),
            "FilesFailedRepeatedlyPayload"
        );
        assert_eq!(
            keyset(FileFailedPayload {
                label: "d".to_string(),
                path: "p".to_string(),
                file_id: "id".to_string(),
                kind: FileFailureKindPayload::Network,
                http_status: None,
            }),
            expect_keys(&["label", "path", "fileId", "kind", "httpStatus"]),
            "FileFailedPayload"
        );
        assert_eq!(
            keyset(CreditsExhaustedPayload {
                label: "d".to_string(),
                balance_cents: 0,
                required_cents: 0,
                file_count: 0
            }),
            expect_keys(&["label", "balanceCents", "requiredCents", "fileCount"]),
            "CreditsExhaustedPayload"
        );
        assert_eq!(
            keyset(DriveStatusChangedPayload {
                label: "d".to_string(),
                folder_name: "Hippius".to_string(),
                path: "/p".to_string(),
                status: DriveStatus::Active,
            }),
            expect_keys(&["label", "folderName", "path", "status"]),
            "DriveStatusChangedPayload"
        );
    }

    /// IPC wire-contract guard (Layer 0): pin the tagged-union wire shape of
    /// `FileFailureKindPayload` — `{"kind": "...", ...}` internally tagged by
    /// `kind`. The FE switches on `kind` and reads the camelCase per-variant
    /// fields, so both the discriminant strings AND the field names are the
    /// contract (the module doc comment specifies this exact shape).
    #[test]
    fn file_failure_kind_payload_pins_tagged_wire_shape() {
        let insufficient = serde_json::to_value(FileFailureKindPayload::InsufficientBalance {
            balance_cents: 12,
            required_cents: 100,
        })
        .expect("serialize");
        assert_eq!(insufficient["kind"], "insufficientBalance");
        assert_eq!(insufficient["balanceCents"], 12);
        assert_eq!(insufficient["requiredCents"], 100);

        let server = serde_json::to_value(FileFailureKindPayload::ServerError { status: 500 }).expect("serialize");
        assert_eq!(server["kind"], "serverError");
        assert_eq!(server["status"], 500);

        let network = serde_json::to_value(FileFailureKindPayload::Network).expect("serialize");
        assert_eq!(network["kind"], "network");
        assert_eq!(network.as_object().expect("object").len(), 1, "Network carries only the discriminant");

        let other = serde_json::to_value(FileFailureKindPayload::Other { message: "x".to_string() }).expect("serialize");
        assert_eq!(other["kind"], "other");
        assert_eq!(other["message"], "x");
    }

    /// IPC wire-contract guard (Layer 0): pin `DriveStatus`'s tagged wire shape
    /// (`{"kind": "active" | "paused" | "error", ...}`), nested under
    /// `DriveStatusChangedPayload.status` and also returned by
    /// `get_all_drive_statuses`. The FE's per-drive status map keys off `kind`.
    #[test]
    fn drive_status_pins_tagged_wire_shape() {
        use crate::sync::drive_status::DriveStatus;

        assert_eq!(serde_json::to_value(DriveStatus::Active).expect("serialize")["kind"], "active");
        assert_eq!(serde_json::to_value(DriveStatus::Paused).expect("serialize")["kind"], "paused");

        let error = serde_json::to_value(DriveStatus::Error { message: "boom".to_string() }).expect("serialize");
        assert_eq!(error["kind"], "error");
        assert_eq!(error["message"], "boom");
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
    /// The file's bytes changed between the scan hash and the encrypt hash, so
    /// the engine discarded the upload rather than ship a half-old blob.
    ///
    /// Carved out of [`Self::Other`] because it is the one failure that is
    /// definitionally self-resolving: the next cycle rescans, re-hashes and
    /// re-uploads, and succeeds as soon as the writer stops touching the file.
    /// Presenting it like a real error sent users hunting for an encryption
    /// fault that does not exist.
    ChangedWhileUploading,
    /// Fallback for failures we have not categorised. `message` is for
    /// display only — the FE MUST NOT parse it as a stable contract.
    Other { message: String },
}

/// The exact string `hcfs-client` produces when a file's content changes
/// between the scan-phase hash and the encryption-phase hash
/// (`drive/upload.rs`'s salted_hash mismatch, surfaced as
/// `SyncError::Encryption`). Matched to carve
/// [`FileFailureKindPayload::ChangedWhileUploading`] out of the upstream
/// `Other(String)` catch-all — upstream's own docs invite exactly this
/// ("Future kinds may carve specific failures out of here").
///
/// Pinned against upstream by `changed_while_uploading_marker_matches_upstream`
/// so an `hcfs-client` bump that rewords it fails CI instead of silently
/// reverting the row to a red "Error".
pub const CHANGED_WHILE_UPLOADING_MARKER: &str = "Encryption error: File was modified during encryption";

/// Whether a snapshot row's authored `error` reason describes a self-resolving
/// failure (see [`FileFailureKindPayload::is_transient`]).
///
/// The live snapshot carries only the reason STRING — the typed kind reaches
/// the frontend on the separate `hcfs_file_failed` event, which the sync widget
/// does not consume. So the emit path recognises a transient row by the string
/// Rust itself authored in `display_reason`. That is an internal round trip
/// within this module (pinned by `transient_reason_round_trips_through_the_authored_string`),
/// NOT the frontend parsing a message — the FE receives the decision already made.
///
pub fn is_transient_reason(reason: &str) -> bool {
    reason == FileFailureKindPayload::ChangedWhileUploading.display_reason()
}

impl FileFailureKindPayload {
    /// User-facing reason for this failure, written into the live snapshot
    /// row's `FileProgress.error` field (the sidebar sync widget and the
    /// provider-free tray popover render it directly — they read only the
    /// snapshot, so the phrasing has to be produced here in Rust, not the FE).
    ///
    /// The wording is kept word-aligned with the frontend
    /// `failureMessage()` (`app/lib/utils/failureMessage.ts`), which phrases
    /// the *persisted* `FileFailureRecord` for the Drive-table badge. The two
    /// cover different data sources (live in-memory string vs. typed DB row)
    /// but must read identically to the user — update both together.
    /// Whether this failure resolves itself on the next sync cycle without any
    /// user action — the signal the widget uses to show an amber "Retrying"
    /// row instead of a red "Error".
    ///
    /// Only [`Self::ChangedWhileUploading`] qualifies. A network blip or a 5xx
    /// is also *often* transient, but "often" is not the bar: this drives copy
    /// telling the user to do nothing, so it must be reserved for the case
    /// where the next cycle genuinely does re-derive everything and succeed.
    pub fn is_transient(&self) -> bool {
        matches!(self, Self::ChangedWhileUploading)
    }

    pub fn display_reason(&self) -> String {
        match self {
            Self::ChangedWhileUploading => "File changed while uploading — will retry.".to_string(),
            Self::InsufficientBalance {
                balance_cents,
                required_cents,
            } => format!(
                "Insufficient credits — needs {}, you have {}.",
                dollars(*required_cents),
                dollars(*balance_cents),
            ),
            Self::ServerError { status } => format!("Server error ({status}). Please try again."),
            Self::Network => "Network error — couldn't reach the server. Check your connection.".to_string(),
            // `Other` already carries upstream display text; fall back to a
            // generic line when it's empty/whitespace so the row never shows a
            // blank reason.
            Self::Other { message } => {
                let trimmed = message.trim();
                if trimmed.is_empty() {
                    "Sync failed. Please try again.".to_string()
                } else {
                    trimmed.to_string()
                }
            }
        }
    }
}

/// Format a cents amount as `$x.xx` using integer math — no `f64` cast, so the
/// value is exact and the `clippy::cast_precision_loss` lint never fires.
/// Mirrors the frontend's `dollars()` in `failureMessage.ts`.
fn dollars(cents: u64) -> String {
    format!("${}.{:02}", cents / 100, cents % 100)
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
            // Carve the mid-upload-modification case out of the upstream
            // catch-all before it reaches `Other` — it is self-resolving and
            // must not be presented as a crypto fault. See
            // `CHANGED_WHILE_UPLOADING_MARKER` for the drift guard.
            K::Other(msg) if msg == CHANGED_WHILE_UPLOADING_MARKER => Self::ChangedWhileUploading,
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
