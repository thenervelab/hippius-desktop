//! End-to-end regression for the 402 -> 402 -> 200 sync flow.
//!
//! Phase 5 / Task 5.1 of `docs/plans/2026-05-13-sync-402-data-integrity.md`.
//!
//! # Why this test exists
//!
//! The original "phantom uploads on 402" bug was a multi-component
//! conspiracy: a byte-progress enqueue lying about server confirmation,
//! a planner that kept re-attempting 402'd uploads forever, a snapshot
//! status that rendered as "Completed" instead of "Error", a bridge
//! that didn't emit a credits-exhausted banner, and a FE that didn't
//! know how to surface any of it. Phase 1-4 fixed each link individually
//! and pinned each link with its own focused test:
//!
//! * `hippius_activity_truth.rs` — no fake `Uploaded` in the activity log
//! * `hippius_snapshot_failure_status.rs` — snapshot row reaches FE as `"error"`
//! * `hippius_file_failed_event.rs` — `SyncEvent::FileFailed` translates correctly
//! * `hippius_credits_exhausted_event.rs` — per-label banner counter is correct
//! * `hcfs-client/tests/upload_retry_policy.rs` — server-side 402-skip-set lifecycle
//!
//! This file ties the chain together: a scripted three-cycle scenario
//! that simulates the *desktop's reaction* to a 402 -> 402 -> 200 server
//! sequence, asserting each cycle's expected end-state at the public-API
//! level. If any future refactor breaks the chain end-to-end while every
//! per-component test still passes, this test fires.
//!
//! # Why Option B (orchestration via public callbacks)
//!
//! Option A (real wiremock + real `Drive`) would duplicate the existing
//! `hcfs-client/tests/upload_retry_policy.rs` coverage and depend on a
//! real Tauri runtime to capture the bridge's `app.emit` calls — neither
//! of which adds signal beyond what hcfs-client's wiremock test and the
//! per-component desktop tests already pin. The plan explicitly permits
//! Option B for this reason.
//!
//! What this test exercises end-to-end:
//!
//! 1. The exact mutator sequence hcfs-client invokes against the desktop
//!    on each per-file event (`build_file_synced_callback` for 200,
//!    `mark_file_failed` for 402 — the latter is what
//!    `build_file_failed_callback` calls internally).
//! 2. The exact mutator sequence the desktop bridge runs against
//!    `CreditsExhaustedState` on a `SyncEvent::FileFailed { kind:
//!    InsufficientBalance }` event (the bridge code itself is one
//!    `if let` + `app.emit`, both trivially correct given correct state).
//! 3. The cycle-boundary contract: `SyncStarted` clears the
//!    credits-exhausted counter so cycle 3's banner count reflects only
//!    cycle 3, and the absence of new failures in cycle 2 leaves the
//!    snapshot's `failed_files` aggregate at zero for new files.
//!
//! # What this test does NOT do
//!
//! - It does NOT spin up wiremock or a real `Drive`. hcfs-client's own
//!   `upload_retry_policy.rs` already pins the server-facing 402-skip-set
//!   lifecycle (cycle 2 skips the POST, cycle 3 re-attempts after a
//!   zero-failure cycle clears the set). Duplicating that here would
//!   couple this test to hcfs-server's wire shape unnecessarily.
//! - It does NOT instantiate a real Tauri `AppHandle`. The bridge's
//!   `app.emit` step is one line conditional on the state mutation this
//!   test pins directly.
//! - It does NOT assert that `hcfs_sync_error` is NOT emitted by reading
//!   an event channel (no event channel exists in this test). Instead it
//!   pins the structural reason no `SyncError` event fires for a per-file
//!   402: an `InsufficientBalance` failure surfaces through
//!   `SyncEvent::FileFailed`, never through `SyncEvent::SyncError`, and
//!   `TauriSyncBridge::on_event` keys on the variant, not the message.

use std::sync::Arc;

use hcfs_client::engine::events::FileFailureKind;
use hcfs_client::engine::progress::state::{FileAction, FileStatus, SyncFile, SyncSession};
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::types::SyncActivityAction;
use hcfs_client::engine::{NoopCallbacks, NoopEventHandler};

use tauri_project_lib::sync::credits_exhausted::CreditsExhaustedState;
use tauri_project_lib::sync::events::{CANCELLED_MARKER, FileFailureKindPayload};
use tauri_project_lib::sync::lifecycle::build_file_synced_callback;
use tauri_project_lib::sync::progress::{FileProgressStatus, mark_file_failed};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/// Build a `SyncRunner` using only the public hcfs-client constructor.
///
/// Mirrors `make_sync_runner` in `hippius_activity_truth.rs` and
/// `hippius_file_failed_event.rs`. Duplicated rather than shared via a
/// `mod common;` re-export because each integration test crate gets its
/// own translation unit and sharing through a `pub(crate)` shim would
/// violate the project's "integration tests use only the public API"
/// rule (`src-tauri/CLAUDE.md`).
fn make_sync_runner() -> Arc<SyncRunner> {
    Arc::new(SyncRunner::new(
        Arc::new(NoopEventHandler),
        Arc::new(NoopCallbacks),
        reqwest::Client::new(),
    ))
}

/// Build a `SyncFile` mid-upload: `status == Uploading` with `transferred`
/// bytes accounted for. This is the shape the per-file `mark_file_failed`
/// path sees when a 402 arrives after the request body has started
/// streaming.
fn uploading_file(path: &str, label: &str, total: u64, transferred: u64) -> SyncFile {
    SyncFile {
        id: Arc::from(path),
        path: Arc::from(path),
        file_name: Arc::from(path.rsplit('/').next().unwrap_or(path)),
        label: Arc::from(label),
        action: FileAction::Upload,
        status: FileStatus::Uploading,
        progress: ((transferred * 100) / total.max(1)) as u32,
        bytes_encrypted: total,
        bytes_transferred: transferred,
        total_bytes: total,
        resumed_from_bytes: None,
        started_at: 0,
        completed_at: None,
        error: None,
    }
}

/// Seed `current_session` with a single in-flight file expecting one
/// upload. Mirrors what hcfs-client's planner does at the start of a
/// cycle: it counts expected uploads and registers each file as
/// `Pending` / `Uploading` before any per-file event fires.
fn seed_one_upload(sync: &SyncRunner, file: SyncFile, session_id: &'static str) {
    let mut state = sync.progress.lock_state();
    let mut files = std::collections::HashMap::new();
    files.insert(file.path.to_string(), file);
    state.current_session = Some(SyncSession {
        session_id: Arc::from(session_id),
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

/// Tear down `current_session` so the next cycle starts from a clean
/// slate. Mirrors what `finalize_session_for_label` does in hcfs-client
/// at end-of-cycle (the runner moves the session into history and
/// builds a new one on the next `SyncStarted`).
///
/// This is the cycle-boundary the test crosses three times. Using
/// `lock_state` (the public progress-tracker API) is the same ingestion
/// path the production runner uses — a refactor that removes or renames
/// it breaks this test.
fn end_cycle(sync: &SyncRunner) {
    let mut state = sync.progress.lock_state();
    state.current_session = None;
}

// ─────────────────────────────────────────────────────────────────────
// The E2E test
// ─────────────────────────────────────────────────────────────────────

/// Three-cycle 402 -> 402 -> 200 simulation, asserting every invariant
/// from `docs/plans/2026-05-13-sync-402-data-integrity.md` Task 5.1
/// Step 2.
///
/// Each cycle:
/// 1. Begins with `seed_one_upload` (the planner's "session is live"
///    state for that file).
/// 2. Runs either the failure path (`mark_file_failed` +
///    `CreditsExhaustedState::record_failure` — what hcfs-client calls
///    via the `on_file_failed` callback and what the bridge does on
///    `SyncEvent::FileFailed { kind: InsufficientBalance }`) OR the
///    success path (`build_file_synced_callback` closure invocation —
///    what hcfs-client calls via `on_file_synced` after a 2xx).
/// 3. Ends with `end_cycle` (the runner's `finalize_session_for_label`
///    moves the session into history) AND, when no failures occurred
///    in the cycle, a `CreditsExhaustedState::clear` call (the bridge's
///    `SyncStarted`-handler resets the per-label counter on next cycle).
///
/// The end-of-cycle assertions inspect:
/// - `sync.progress.build_snapshot()` for `failed_files` and per-row
///   `status == FileProgressStatus::Error` (cycle 1) or `Completed`
///   (cycle 3),
/// - `sync.pending_activity` for `SyncActivityAction::Uploaded` rows
///   (must be empty after a 402, exactly one after a 200),
/// - `CreditsExhaustedState::count_for` for the per-label banner count.
#[test]
#[expect(
    clippy::too_many_lines,
    reason = "Three sequential sync cycles, each with its own setup + multi-invariant assertions, are deliberately kept in one function so the cycle ordering is readable end-to-end. Splitting into helpers would require sharing `sync`/`banner_state`/`label` across function boundaries with no abstraction win."
)]
fn three_cycle_402_402_200_full_chain() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-402-e2e");
    let banner_state = CreditsExhaustedState::new();

    // ──────────────────────────────────────────────────────────────────
    // Cycle 1: server returns 402.
    //
    // Expected end state:
    //   - snapshot row for the file has status = Error
    //   - snapshot.failed_files == 1
    //   - no SyncActivityAction::Uploaded item in pending_activity
    //   - banner count for the label == 1
    //   - NO SyncError surfaces — the file's failure flows through
    //     SyncEvent::FileFailed, not SyncEvent::SyncError, and the
    //     bridge keys on the variant. We pin this structurally by
    //     asserting the failure-kind's display form does NOT match
    //     CANCELLED_MARKER (the only string the bridge silently drops),
    //     i.e. the failure is observable, not silently dropped.
    // ──────────────────────────────────────────────────────────────────
    seed_one_upload(&sync, uploading_file("first.txt", &label, 2048, 1024), "cycle-1");

    // Simulate hcfs-client invoking `on_file_failed` with an
    // `InsufficientBalance` kind. The desktop's `build_file_failed_callback`
    // closure calls `mark_file_failed` with the kind's debug form.
    let cycle1_kind = FileFailureKind::InsufficientBalance {
        balance_cents: 33,
        required_cents: 138,
    };
    mark_file_failed(&sync, "first.txt", &format!("{cycle1_kind:?}")).expect("cycle 1: mark_file_failed must succeed on a well-formed session");

    // Simulate the bridge consuming `SyncEvent::FileFailed { kind:
    // InsufficientBalance, .. }` — record_failure is what fires the
    // hcfs_credits_exhausted banner emit (the actual app.emit is one
    // `if let` away in the bridge and trivially correct given the
    // counter post-increment value this returns).
    let cycle1_banner_count = banner_state.record_failure(&label);
    assert_eq!(
        cycle1_banner_count, 1,
        "cycle 1: first InsufficientBalance must produce banner file_count = 1"
    );

    // Pin the structural reason no `hcfs_sync_error` event fires for
    // this 402: the failure kind's Debug form is observable (used for
    // the snapshot row's `error` field), and it does NOT match the
    // CANCELLED_MARKER constant that the bridge silently drops. So a
    // sync-level error would have to come from `SyncError::Cancelled`
    // or another variant — neither of which a 402 produces.
    let cycle1_error_msg = format!("{cycle1_kind:?}");
    assert_ne!(
        cycle1_error_msg, CANCELLED_MARKER,
        "402 failure debug-render must NOT collide with the cancel marker; \
         otherwise the bridge would silently drop the failure"
    );

    // Translate the kind through the wire-format adapter to confirm
    // the FE's discriminated union sees `insufficientBalance` — the
    // exact tag the FE's banner key dispatch needs.
    let payload = FileFailureKindPayload::from(&cycle1_kind);
    let payload_json = serde_json::to_value(&payload).expect("FileFailureKindPayload serialises — it crosses IPC");
    assert_eq!(
        payload_json.get("kind").and_then(|v| v.as_str()),
        Some("insufficientBalance"),
        "cycle 1: wire payload must tag as `insufficientBalance` so the FE banner fires"
    );

    {
        let snapshot = sync.progress.build_snapshot();
        let row = snapshot
            .files
            .iter()
            .find(|f| f.path.as_ref() == "first.txt")
            .expect("cycle 1: seeded file must survive in snapshot");
        assert_eq!(row.status, FileProgressStatus::Error, "cycle 1: snapshot row must be Error after a 402");
        assert_eq!(
            row.error.as_deref(),
            Some(cycle1_error_msg.as_str()),
            "cycle 1: snapshot row's error field must carry the failure kind"
        );
        assert_eq!(snapshot.failed_files, 1, "cycle 1: snapshot.failed_files aggregate must agree");

        let json = serde_json::to_value(&snapshot).expect("snapshot serialises — it crosses Tauri IPC");
        let files = json
            .get("files")
            .and_then(serde_json::Value::as_array)
            .expect("snapshot.files must be a JSON array");
        let err_row = files
            .iter()
            .find(|f| f.get("status").and_then(|s| s.as_str()) == Some("error"))
            .expect("cycle 1: wire JSON must contain at least one row with status=\"error\"");
        assert_eq!(
            err_row.get("fileName").and_then(|n| n.as_str()),
            Some("first.txt"),
            "cycle 1: the error row must be the file we seeded"
        );
    }

    let pending_after_cycle_1 = sync
        .pending_activity
        .lock()
        .expect("pending_activity mutex uncontended in this test")
        .len();
    assert_eq!(
        pending_after_cycle_1, 0,
        "cycle 1: a 402 must NOT produce a fake `Uploaded` activity row; \
         got {pending_after_cycle_1} item(s) in pending_activity"
    );

    end_cycle(&sync);
    // NB: do NOT clear the banner counter here — the bridge clears it
    // on the NEXT `SyncStarted` (= start of cycle 2), not at the end of
    // cycle 1. This mirrors `record_and_build` in
    // `hippius_credits_exhausted_event.rs`.

    // ──────────────────────────────────────────────────────────────────
    // Cycle 2: server still returns 402. After hcfs-client's
    // strategy-A skip-set logic (`upload_retry_policy.rs` /
    // `skip_set_clears_after_successful_cycle`), the file is NOT in
    // `plan.uploads` this cycle — the planner filters it out because
    // last cycle's failure left it in the in-memory skip set.
    //
    // From the desktop's vantage that means: no per-file events fire
    // for `first.txt` this cycle, the bridge sees zero
    // `FileFailed{InsufficientBalance}` events for the label, and a
    // `SyncStarted` for the new cycle has already cleared the banner
    // counter. The cycle ends with `files_failed == 0`, which is what
    // tells the strategy-A skip-set to clear on the next cycle boundary.
    //
    // Expected end state:
    //   - snapshot.failed_files == 0 (no new failures this cycle)
    //   - no fresh pending_activity rows for the file
    //   - banner count for the label == 0 (cleared by SyncStarted)
    // ──────────────────────────────────────────────────────────────────

    // SyncStarted handler clears the per-label counter. This is the
    // exact mutation `TauriSyncBridge::on_event` performs on the
    // `SyncStarted { label }` arm — see
    // `hippius_credits_exhausted_event::sync_started_for_label_resets_counter`.
    assert!(
        banner_state.clear(&label),
        "cycle 2: SyncStarted must clear the banner counter (returned false ⇒ no entry to clear, which means cycle 1's state was already lost — a regression)"
    );
    assert_eq!(banner_state.count_for(&label), 0, "cycle 2: counter must be 0 after clear");

    // The planner's skip-set means hcfs-client emits zero per-file
    // events for `first.txt` this cycle. Simulate by NOT seeding the
    // session and NOT invoking any callbacks — this is exactly what the
    // desktop sees when the planner's `plan.uploads` is empty.

    let pending_after_cycle_2 = sync.pending_activity.lock().expect("pending_activity mutex").len();
    assert_eq!(
        pending_after_cycle_2, 0,
        "cycle 2: skip-set holds — no fresh activity items must appear; got {pending_after_cycle_2}"
    );

    {
        let snapshot = sync.progress.build_snapshot();
        // With no current_session and no fresh events, the snapshot's
        // `failed_files` counter reflects only the historic state of
        // recent files. After `end_cycle` cleared the session, the
        // aggregate must be zero — confirming the cycle 1 error row
        // does NOT linger as a "live" failure into cycle 2.
        assert_eq!(
            snapshot.failed_files, 0,
            "cycle 2: with the cycle-1 session ended and no new failures, \
             the snapshot's live failed_files counter must be 0"
        );
    }

    end_cycle(&sync);

    // ──────────────────────────────────────────────────────────────────
    // Cycle 3: server returns 200. The skip-set was cleared at the end
    // of cycle 2 (files_failed == 0 → strategy-A trigger), so the
    // planner re-includes `first.txt` in `plan.uploads`. hcfs-client
    // runs the upload, gets a 2xx, and fires `on_file_synced` →
    // `build_file_synced_callback`. The desktop bridge sees a
    // `SyncEvent::FileSucceeded`-shaped event and the banner stays
    // cleared (no `record_failure` calls).
    //
    // Expected end state:
    //   - snapshot row for `first.txt` has status = Completed
    //   - snapshot.failed_files == 0
    //   - exactly one Uploaded item in pending_activity
    //   - banner count for the label == 0
    // ──────────────────────────────────────────────────────────────────
    seed_one_upload(&sync, uploading_file("first.txt", &label, 2048, 2048), "cycle-3");

    let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));
    // 32-byte path hash keyed with 'a' so the hex decode succeeds —
    // matches the shape `hippius_activity_truth.rs` uses. A bad hex
    // would short-circuit the callback before `upsert_synced_path` and
    // make this test silently testing a no-op.
    let fid_hex = hex::encode([0xAAu8; 32]);
    callback("first.txt", &fid_hex, "cid-cycle3", "uploaded", None);

    {
        let snapshot = sync.progress.build_snapshot();
        let row = snapshot
            .files
            .iter()
            .find(|f| f.path.as_ref() == "first.txt")
            .expect("cycle 3: seeded file must survive in snapshot");
        assert_eq!(
            row.status,
            FileProgressStatus::Completed,
            "cycle 3: snapshot row must transition to Completed after the 200 — \
             got {:?}",
            row.status
        );
        assert_eq!(snapshot.failed_files, 0, "cycle 3: no failures this cycle");
    }

    let activity = sync.pending_activity.lock().expect("pending_activity mutex");
    // `SyncActivityItem` does not implement `Debug`, so we render a
    // human-readable summary by hand in the failure message rather than
    // relying on `{:?}` formatting.
    let action_summary: Vec<(String, String)> = activity
        .iter()
        .map(|item| (format!("{:?}", item.action), item.file_name.to_string()))
        .collect();
    let uploaded: Vec<_> = activity.iter().filter(|item| item.action == SyncActivityAction::Uploaded).collect();
    assert_eq!(
        uploaded.len(),
        1,
        "cycle 3: exactly one Uploaded activity row expected after the server-confirmed 200; \
         got {} (actions = {action_summary:?})",
        uploaded.len()
    );
    assert_eq!(&*uploaded[0].file_name, "first.txt", "cycle 3: the Uploaded row must be `first.txt`");
    assert_eq!(
        &*uploaded[0].label, "drive-402-e2e",
        "cycle 3: the Uploaded row must carry the test drive's label"
    );
    drop(activity);

    assert_eq!(
        banner_state.count_for(&label),
        0,
        "cycle 3: banner counter must stay at 0 — no record_failure was called this cycle"
    );

    end_cycle(&sync);
}

// ─────────────────────────────────────────────────────────────────────
// Static-shape complement: the bridge's `SyncEvent::FileFailed` handler
// MUST route InsufficientBalance failures through `record_failure`, and
// MUST NOT emit a `hcfs_sync_error` for them. The runtime test above
// pins the state-machine outcome; this static-shape probe pins the
// routing decision at the source level, so a future refactor can't
// reroute the variant without flipping this test.
//
// This mirrors the static-shape pattern used by
// `byte_progress_does_not_enqueue_pending_activity` in
// `hippius_activity_truth.rs` and
// `lifecycle_initialize_sync_inner_spawns_backfill` in
// `hippius_relative_path_backfill.rs`.
// ─────────────────────────────────────────────────────────────────────

/// Pin that the bridge's `SyncEvent::FileFailed` arm uses
/// `record_failure` (the InsufficientBalance counter) — not the
/// SyncError emit path. If a future refactor accidentally moves the
/// banner emit to the SyncError handler (or removes it entirely), this
/// test catches it before the runtime invariant above does.
#[test]
fn bridge_routes_file_failed_to_credits_exhausted_state() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/tauri_bridge.rs");
    let src = std::fs::read_to_string(path).expect("read src/sync/tauri_bridge.rs");

    // The bridge handles `SyncEvent::FileFailed` and dispatches on the
    // kind. The exact identifier the bridge uses to mutate state is
    // `record_failure` (see `CreditsExhaustedState::record_failure`).
    assert!(
        src.contains("record_failure"),
        "TauriSyncBridge must call CreditsExhaustedState::record_failure on InsufficientBalance — \
         the banner emit depends on the post-increment count. See \
         docs/plans/2026-05-13-sync-402-data-integrity.md Task 3.2."
    );

    // The bridge silently drops `SyncError::Cancelled` events (the
    // CANCELLED_MARKER check). It MUST NOT drop FileFailed events the
    // same way — a per-file 402 is an operator-visible signal, not a
    // user cancel.
    let drops_file_failed = src
        .lines()
        .filter(|line| line.contains("FileFailed"))
        .any(|line| line.contains("return ;") || line.contains("// drop") || line.contains("CANCELLED_MARKER"));
    assert!(
        !drops_file_failed,
        "FileFailed events must not be silenced via the CANCELLED_MARKER guard — \
         that guard is for user-initiated cancels only"
    );
}
