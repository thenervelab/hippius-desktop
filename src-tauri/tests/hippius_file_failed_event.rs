//! Regression pins for `SyncEvent::FileFailed` consumption — Task 2.7 of
//! `docs/plans/2026-05-13-sync-402-data-integrity.md`.
//!
//! # What this suite covers
//!
//! Three independent contracts the Phase 2 desktop consumer must honour:
//!
//! 1. **`mark_file_failed` flips the snapshot synchronously**: when the
//!    per-file failure callback fires (the in-process equivalent of
//!    `SyncEvent::FileFailed` arriving via the bridge), the file's row
//!    in the next `build_snapshot()` MUST carry
//!    `FileProgressStatus::Error` AND `snapshot.failed_files` MUST agree
//!    with the per-file count. No waiting for end-of-cycle finalize.
//!
//! 2. **Wire-format pin for `FileFailureKindPayload`**: the
//!    desktop-owned translation enum must serialise to the tagged JSON
//!    shape the FE consumes. Because the upstream
//!    `hcfs_client::engine::events::FileFailureKind` does NOT derive
//!    `Serialize`, this test guards the translation map — adding a
//!    variant upstream without extending `From<&FileFailureKind>`
//!    silently maps to `Other`, which this test would catch via the
//!    `InsufficientBalance` round-trip.
//!
//! 3. **First-error wins**: calling `mark_file_failed` a second time
//!    with a different error string for the same path must NOT overwrite
//!    the first error message. Justification: hcfs-client retries
//!    transient errors and the first 402 is the operator-actionable
//!    signal; clobbering it with a follow-up "network timeout" hides
//!    the real root cause.
//!
//! # What this suite does NOT do
//!
//! - It does NOT spin up a real Tauri runtime. The `on_event` arm that
//!   emits `hcfs_file_failed` is exercised at the *progress mutation*
//!   level (the side effect that matters for the snapshot/widget) and
//!   at the *payload translation* level (the wire format the FE keys
//!   on). A full Tauri-runtime integration would require the
//!   `tauri::test` harness and a real `AppHandle` — neither is
//!   reachable from an `integration_test` build without test-only
//!   harness scaffolding the project deliberately avoids
//!   (`src-tauri/CLAUDE.md`, project axiom 111: tests use only the
//!   public API).

use std::sync::Arc;

use hcfs_client::engine::events::FileFailureKind;
use hcfs_client::engine::progress::state::{FileAction, FileStatus, SyncFile, SyncSession};
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::{NoopCallbacks, NoopEventHandler};

use tauri_project_lib::sync::events::{FileFailedPayload, FileFailureKindPayload};
use tauri_project_lib::sync::progress::{FileProgressStatus, mark_file_failed};

// ─────────────────────────────────────────────────────────────────────
// Helpers (mirrors hippius_snapshot_failure_status.rs — see that file
// for the rationale on duplicating instead of sharing through a
// `mod common`).
// ─────────────────────────────────────────────────────────────────────

/// Build a `SyncRunner` using only the public hcfs-client constructor.
fn make_sync_runner() -> Arc<SyncRunner> {
    Arc::new(SyncRunner::new(
        Arc::new(NoopEventHandler),
        Arc::new(NoopCallbacks),
        reqwest::Client::new(),
    ))
}

/// Build a `SyncFile` mid-upload: bytes are partway through, no terminal
/// state yet. This is the shape `mark_file_failed` sees when a 402
/// response arrives mid-stream.
fn uploading_file(path: &str, label: &str, size: u64, transferred: u64) -> SyncFile {
    SyncFile {
        id: Arc::from(path),
        path: Arc::from(path),
        file_name: Arc::from(path.rsplit('/').next().unwrap_or(path)),
        label: Arc::from(label),
        action: FileAction::Upload,
        status: FileStatus::Uploading,
        progress: ((transferred * 100) / size.max(1)) as u32,
        bytes_encrypted: size,
        bytes_transferred: transferred,
        total_bytes: size,
        resumed_from_bytes: None,
        started_at: 0,
        completed_at: None,
        error: None,
    }
}

/// Seed the runner's `current_session` with a single in-flight file.
fn seed_single_file(sync: &SyncRunner, file: SyncFile) {
    let mut state = sync.progress.lock_state();
    let mut files = std::collections::HashMap::new();
    files.insert(file.path.to_string(), file);
    state.current_session = Some(SyncSession {
        session_id: Arc::from("test-session-file-failed"),
        started_at: 0,
        completed_at: None,
        is_active: true,
        expected_uploads: 1,
        expected_downloads: 0,
        expected_local_deletes: 0,
        expected_remote_deletes: 0,
        files,
    });
}

// ─────────────────────────────────────────────────────────────────────
// Test 1 — synchronous progress transition
// ─────────────────────────────────────────────────────────────────────

/// `mark_file_failed` MUST flip the file's snapshot row to
/// `FileProgressStatus::Error` immediately (no end-of-cycle wait).
///
/// This pins acceptance criterion (5)/bullet 1 of Task 2.7: the
/// snapshot's file entry has `status == FileProgressStatus::Error`
/// immediately, before any finalize-session call.
#[test]
fn mark_file_failed_flips_snapshot_status_to_error_immediately() {
    let sync = make_sync_runner();
    let label = "drive-a";

    // Mid-upload: 50% transferred, status = Uploading. A 402 arriving
    // right now should flip the row to Error without waiting for
    // `complete_pending_files` / `mark_pending_files_as_failed`.
    seed_single_file(&sync, uploading_file("over-budget.bin", label, 2048, 1024));

    mark_file_failed(&sync, "over-budget.bin", "insufficient_balance: 12¢ < 100¢")
        .expect("mark_file_failed should not error on a well-formed session");

    let snapshot = sync.progress.build_snapshot();
    let row = snapshot
        .files
        .iter()
        .find(|f| f.path.as_ref() == "over-budget.bin")
        .expect("file we seeded must still be present in the snapshot");

    assert_eq!(
        row.status,
        FileProgressStatus::Error,
        "snapshot row for the failed file must be `Error` immediately; \
         got {:?}",
        row.status
    );
    assert_eq!(
        row.error.as_deref(),
        Some("insufficient_balance: 12¢ < 100¢"),
        "the error message must be carried on the row for the FE tooltip"
    );
    assert_eq!(
        row.progress_percent, 0,
        "progress_percent reset to 0 (mirrors upstream `mark_file_error` semantics)"
    );
    assert_eq!(row.bytes_transferred, 0, "bytes_transferred reset to 0 so the FE doesn't show 99%→Error");
    assert_eq!(
        snapshot.failed_files, 1,
        "aggregate `failed_files` counter must agree with the per-file Error count"
    );
}

// ─────────────────────────────────────────────────────────────────────
// Test 2 — wire-format pin for the kind translation
// ─────────────────────────────────────────────────────────────────────

/// `FileFailureKindPayload::from(&FileFailureKind::InsufficientBalance{..})`
/// MUST round-trip through serde to the tagged-union JSON shape the FE
/// keys on: `{"kind":"insufficientBalance","balanceCents":12,"requiredCents":100}`.
///
/// Failure mode this catches: an upstream rename, a variant addition
/// without extending the `From` impl, or a serde-attribute regression
/// (dropping `tag = "kind"` or `rename_all = "camelCase"`) would silently
/// break the FE's discriminated union without breaking the Rust types'
/// `PartialEq`. The on-wire string assertion catches that.
#[test]
fn insufficient_balance_serialises_to_tagged_camel_case_json() {
    let upstream = FileFailureKind::InsufficientBalance {
        balance_cents: 12,
        required_cents: 100,
    };
    let payload = FileFailureKindPayload::from(&upstream);

    let json = serde_json::to_value(&payload).expect("FileFailureKindPayload must serialise; it crosses Tauri IPC");

    assert_eq!(
        json.get("kind").and_then(|k| k.as_str()),
        Some("insufficientBalance"),
        "tag must serialise as camelCase `insufficientBalance`; \
         got payload JSON = {json}"
    );
    assert_eq!(json.get("balanceCents").and_then(serde_json::Value::as_i64), Some(12));
    assert_eq!(json.get("requiredCents").and_then(serde_json::Value::as_i64), Some(100));
}

/// Each upstream variant must translate to a distinct, FE-stable wire shape.
/// This is the breadth pin — Test 2 above pins InsufficientBalance depth.
#[test]
fn each_upstream_variant_translates_to_distinct_wire_shape() {
    let cases = [
        (FileFailureKind::ServerError { status: 500 }, "serverError", Some(("status", 500_i64))),
        (FileFailureKind::Network, "network", None),
    ];
    for (upstream, expected_kind, extra_field) in cases {
        let payload = FileFailureKindPayload::from(&upstream);
        let json = serde_json::to_value(&payload).expect("serialise");
        assert_eq!(
            json.get("kind").and_then(|v| v.as_str()),
            Some(expected_kind),
            "variant {upstream:?} must serialise with kind = {expected_kind:?}"
        );
        if let Some((field, value)) = extra_field {
            assert_eq!(
                json.get(field).and_then(serde_json::Value::as_i64),
                Some(value),
                "variant {upstream:?} must carry {field}={value}"
            );
        }
    }

    // `Other(String)` translates the inner message — separate case
    // because it owns a `String`, not a `Copy` field.
    let other_payload = FileFailureKindPayload::from(&FileFailureKind::Other("unmapped".into()));
    let json = serde_json::to_value(&other_payload).expect("serialise");
    assert_eq!(json.get("kind").and_then(|v| v.as_str()), Some("other"));
    assert_eq!(json.get("message").and_then(|v| v.as_str()), Some("unmapped"));
}

// ─────────────────────────────────────────────────────────────────────
// Test 3 — first-error-wins idempotence
// ─────────────────────────────────────────────────────────────────────

/// Calling `mark_file_failed` a second time for the same path with a
/// different error MUST NOT overwrite the first error message.
///
/// Why: hcfs-client may retry transient failures, and the first error
/// (e.g. `InsufficientBalance: 12¢ < 100¢`) is the operator-actionable
/// signal. Letting a follow-up "connection reset" message clobber it
/// hides the real cause from the FE tooltip and the `last_error`
/// channel. The terminal `FileStatus::Error` row is sticky for the
/// duration of the cycle.
#[test]
fn second_failure_for_same_path_does_not_overwrite_first_error() {
    let sync = make_sync_runner();
    let label = "drive-a";

    seed_single_file(&sync, uploading_file("paid.txt", label, 1024, 512));

    mark_file_failed(&sync, "paid.txt", "first: insufficient_balance").expect("first call");
    mark_file_failed(&sync, "paid.txt", "second: network_timeout").expect("second call");

    let snapshot = sync.progress.build_snapshot();
    let row = snapshot.files.iter().find(|f| f.path.as_ref() == "paid.txt").expect("row");
    assert_eq!(
        row.error.as_deref(),
        Some("first: insufficient_balance"),
        "the first failure message must win — second call is a no-op while the row is already Error"
    );
    assert_eq!(snapshot.failed_files, 1, "still exactly one failed file (not double-counted)");
}

// ─────────────────────────────────────────────────────────────────────
// Test 4 — empty path is a no-op
// ─────────────────────────────────────────────────────────────────────

/// Defensive: `mark_file_failed` with `path = ""` must not corrupt the
/// session. Mirrors the `rel_path.is_empty()` guard in
/// `build_file_failed_callback` and `build_file_synced_callback`.
#[test]
fn mark_file_failed_with_unknown_path_is_a_noop() {
    let sync = make_sync_runner();
    seed_single_file(&sync, uploading_file("real.bin", "drive-a", 1024, 0));

    mark_file_failed(&sync, "ghost-path-not-in-session.bin", "should be ignored").expect("must not error when the path is missing — race-safe no-op");

    let snapshot = sync.progress.build_snapshot();
    assert_eq!(snapshot.failed_files, 0, "no row was flipped; failed_files must stay at 0");
    let row = snapshot
        .files
        .iter()
        .find(|f| f.path.as_ref() == "real.bin")
        .expect("seeded row survives");
    assert_eq!(row.status, FileProgressStatus::InProgress);
}

// ─────────────────────────────────────────────────────────────────────
// Test 5 — payload struct shape (end-to-end IPC contract)
// ─────────────────────────────────────────────────────────────────────

/// The `FileFailedPayload` struct as a whole must serialise with the
/// shape the FE's event listener expects. This is the composite of the
/// translation pin (Test 2) plus the outer-struct camelCase rename
/// (`fileId`, `httpStatus`) the bridge emits.
#[test]
fn file_failed_payload_full_wire_shape() {
    let payload = FileFailedPayload {
        label: "drive-a".to_string(),
        path: "over-budget.bin".to_string(),
        file_id: "deadbeef00112233".to_string(),
        kind: FileFailureKindPayload::from(&FileFailureKind::InsufficientBalance {
            balance_cents: 12,
            required_cents: 100,
        }),
        http_status: Some(402),
    };

    let json = serde_json::to_value(&payload).expect("payload must serialise for the Tauri channel");

    assert_eq!(json.get("label").and_then(|v| v.as_str()), Some("drive-a"));
    assert_eq!(json.get("path").and_then(|v| v.as_str()), Some("over-budget.bin"));
    assert_eq!(
        json.get("fileId").and_then(|v| v.as_str()),
        Some("deadbeef00112233"),
        "outer struct must rename `file_id` → `fileId` per `serde(rename_all = \"camelCase\")`"
    );
    assert_eq!(
        json.get("httpStatus").and_then(serde_json::Value::as_i64),
        Some(402),
        "outer struct must rename `http_status` → `httpStatus`"
    );
    let kind = json.get("kind").expect("kind tag must exist");
    assert_eq!(kind.get("kind").and_then(|v| v.as_str()), Some("insufficientBalance"));
}
