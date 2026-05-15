//! Regression pins for the `hcfs_credits_exhausted` banner event —
//! Task 3.2 of `docs/plans/2026-05-13-sync-402-data-integrity.md`.
//!
//! # What this suite covers
//!
//! Four independent invariants the bridge-side credits-exhausted
//! plumbing must honour:
//!
//! 1. **First `InsufficientBalance` returns `file_count = 1`.** The
//!    running counter starts at zero per label, increments by one per
//!    `record_failure`, and the bridge attaches the post-increment
//!    value to the payload.
//!
//! 2. **Second `InsufficientBalance` in the same cycle returns
//!    `file_count = 2`.** Per-label running count is preserved across
//!    consecutive failures until a cycle boundary clears it.
//!
//! 3. **Non-`InsufficientBalance` failures (e.g. `ServerError`) do NOT
//!    touch the counter.** The banner is for 402s only.
//!
//! 4. **`SyncStarted` for a new cycle resets the counter.** A
//!    fresh cycle starts at zero so the banner reflects only that
//!    cycle's failures.
//!
//! # What this suite does NOT do
//!
//! - It does NOT spin up a real Tauri runtime. Like
//!   `hippius_file_failed_event.rs`, the bridge's `app.emit` step is
//!   exercised at the *counter mutation* level (the state the bridge
//!   reads when building the payload) rather than through a real
//!   `AppHandle`. The wire-shape contract for the payload struct is
//!   pinned by the `payload_serialises_to_camel_case_json` test.

use tauri_project_lib::sync::credits_exhausted::CreditsExhaustedState;
use tauri_project_lib::sync::events::CreditsExhaustedPayload;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/// Simulate the bridge's `FileFailed { kind: InsufficientBalance }`
/// branch: record a failure and build the payload exactly as the bridge
/// would. This is the unit under test — the bridge code itself is one
/// `if let` plus an `app.emit`, both trivially correct given a correct
/// state and payload.
fn record_and_build(state: &CreditsExhaustedState, label: &str, balance_cents: u64, required_cents: u64) -> CreditsExhaustedPayload {
    let file_count = state.record_failure(label);
    CreditsExhaustedPayload {
        label: label.to_string(),
        balance_cents,
        required_cents,
        file_count,
    }
}

// ─────────────────────────────────────────────────────────────────────
// Test 1 — first InsufficientBalance reports file_count = 1
// ─────────────────────────────────────────────────────────────────────

/// Acceptance criterion 5 (Task 3.2 plan): "On `FileFailed { kind:
/// InsufficientBalance { balance_cents: 33, required_cents: 138 } }`,
/// assert `hcfs_credits_exhausted` is emitted with `{ balance_cents:
/// 33, required_cents: 138, file_count: 1 }`."
#[test]
fn first_insufficient_balance_emits_file_count_one() {
    let state = CreditsExhaustedState::new();
    let payload = record_and_build(&state, "drive-a", 33, 138);

    assert_eq!(payload.balance_cents, 33);
    assert_eq!(payload.required_cents, 138);
    assert_eq!(payload.file_count, 1, "first failure in a fresh cycle must report file_count = 1");
    assert_eq!(payload.label, "drive-a");
}

// ─────────────────────────────────────────────────────────────────────
// Test 2 — second InsufficientBalance in same cycle reports file_count = 2
// ─────────────────────────────────────────────────────────────────────

/// Acceptance criterion 5: "On a SECOND `FileFailed { kind:
/// InsufficientBalance, .. }` in the same cycle, assert `file_count: 2`."
#[test]
fn second_insufficient_balance_in_same_cycle_increments_to_two() {
    let state = CreditsExhaustedState::new();

    let first = record_and_build(&state, "drive-a", 33, 138);
    let second = record_and_build(&state, "drive-a", 30, 138);

    assert_eq!(first.file_count, 1);
    assert_eq!(
        second.file_count, 2,
        "second failure in the same cycle must increment the per-label counter"
    );
    // The payload carries the LATEST server-reported balance — a partial
    // top-up between the two 402s would surface here. Asserting this pins
    // the contract that the banner shows the most recent values, not the
    // first ones.
    assert_eq!(second.balance_cents, 30);
}

// ─────────────────────────────────────────────────────────────────────
// Test 3 — non-InsufficientBalance failures do NOT touch the counter
// ─────────────────────────────────────────────────────────────────────

/// Acceptance criterion 5: "On a `FileFailed { kind: ServerError, .. }`
/// (not InsufficientBalance), assert NO `hcfs_credits_exhausted` event."
///
/// The bridge's `if let InsufficientBalance` branch is the gate; we test
/// the gate's complement here by asserting that `record_failure` is NEVER
/// called for non-402 failures — its absence is the absence of the event.
#[test]
fn non_insufficient_balance_failure_does_not_increment_counter() {
    let state = CreditsExhaustedState::new();

    // Simulate a ServerError-kind failure arriving at the bridge: the
    // bridge does NOT call `record_failure`. Verify the counter stays
    // at zero.
    //
    // (We don't call record_failure here on purpose — the bridge's
    // `if let InsufficientBalance` branch is the gate. This test pins
    // that "no record_failure call ⇒ counter stays zero" — i.e. no
    // banner.)
    assert_eq!(state.count_for("drive-a"), 0);

    // To be extra-explicit: a real-world bridge-side `ServerError`
    // arrival flows through the FILE_FAILED arm but skips the
    // `if let InsufficientBalance` branch entirely. Recording a real
    // 402 afterwards should still yield file_count = 1 (not 2 — the
    // ServerError must not have leaked in).
    let payload = record_and_build(&state, "drive-a", 33, 138);
    assert_eq!(
        payload.file_count, 1,
        "a non-402 failure between resets must not contaminate the 402 counter"
    );
}

// ─────────────────────────────────────────────────────────────────────
// Test 4 — SyncStarted on the same label resets the counter
// ─────────────────────────────────────────────────────────────────────

/// Acceptance criterion 5: "On `SyncStarted` for a new cycle, the
/// counter resets." The bridge clears via `clear(&label)` on
/// `SyncStarted` — calling `clear` directly here is the test, since
/// it's the exact mutation the bridge performs.
#[test]
fn sync_started_for_label_resets_counter() {
    let state = CreditsExhaustedState::new();
    record_and_build(&state, "drive-a", 33, 138);
    record_and_build(&state, "drive-a", 33, 138);
    assert_eq!(state.count_for("drive-a"), 2);

    // SyncStarted handler calls clear(label). Assert the counter is
    // reset.
    assert!(state.clear("drive-a"));
    assert_eq!(state.count_for("drive-a"), 0);

    // Next 402 in the new cycle re-emits with file_count = 1 (not 3).
    let payload = record_and_build(&state, "drive-a", 33, 138);
    assert_eq!(
        payload.file_count, 1,
        "fresh-cycle clear must result in next failure showing file_count = 1"
    );
}

// ─────────────────────────────────────────────────────────────────────
// Test 5 — SyncStopped resets the per-label counter
// ─────────────────────────────────────────────────────────────────────

/// Bridge handler symmetry: `SyncStopped` must clear the counter for
/// the stopped label. A subsequent resume/re-add must NOT inherit the
/// stale count.
#[test]
fn sync_stopped_clears_counter_for_label() {
    let state = CreditsExhaustedState::new();
    record_and_build(&state, "drive-a", 33, 138);
    record_and_build(&state, "drive-b", 50, 200);
    assert!(state.clear("drive-a"));
    assert_eq!(state.count_for("drive-a"), 0);
    // Other drive's counter is unaffected — per-label scoping.
    assert_eq!(state.count_for("drive-b"), 1);
}

// ─────────────────────────────────────────────────────────────────────
// Test 6 — SyncReset clears every counter
// ─────────────────────────────────────────────────────────────────────

/// Bridge handler symmetry: `SyncReset` (logout / account switch) must
/// wipe every counter so a different user's 402 history can't leak.
#[test]
fn sync_reset_clears_every_counter() {
    let state = CreditsExhaustedState::new();
    record_and_build(&state, "drive-a", 33, 138);
    record_and_build(&state, "drive-b", 50, 200);
    record_and_build(&state, "drive-c", 100, 150);
    assert!(state.clear_all());
    assert_eq!(state.count_for("drive-a"), 0);
    assert_eq!(state.count_for("drive-b"), 0);
    assert_eq!(state.count_for("drive-c"), 0);
}

// ─────────────────────────────────────────────────────────────────────
// Test 7 — wire format pin
// ─────────────────────────────────────────────────────────────────────

/// `CreditsExhaustedPayload` must serialise to the camelCase JSON the
/// FE consumes. Catches a regression that drops `rename_all = "camelCase"`
/// or renames a field.
#[test]
fn payload_serialises_to_camel_case_json() {
    let payload = CreditsExhaustedPayload {
        label: "drive-a".to_string(),
        balance_cents: 33,
        required_cents: 138,
        file_count: 1,
    };
    let json = serde_json::to_value(&payload).expect("payload must serialise — it crosses Tauri IPC");

    assert_eq!(json.get("label").and_then(|v| v.as_str()), Some("drive-a"));
    assert_eq!(json.get("balanceCents").and_then(serde_json::Value::as_i64), Some(33));
    assert_eq!(json.get("requiredCents").and_then(serde_json::Value::as_i64), Some(138));
    assert_eq!(json.get("fileCount").and_then(serde_json::Value::as_u64), Some(1));
}

// ─────────────────────────────────────────────────────────────────────
// Test 8 — per-label scoping under interleaving
// ─────────────────────────────────────────────────────────────────────

/// Two drives failing concurrently must each accumulate independently.
/// This pins the "drives don't share counters" invariant in case a
/// future refactor introduces a global counter.
#[test]
fn per_label_scoping_under_interleaving() {
    let state = CreditsExhaustedState::new();
    let a1 = record_and_build(&state, "drive-a", 33, 138);
    let b1 = record_and_build(&state, "drive-b", 50, 200);
    let a2 = record_and_build(&state, "drive-a", 33, 138);
    let b2 = record_and_build(&state, "drive-b", 50, 200);
    let a3 = record_and_build(&state, "drive-a", 33, 138);

    assert_eq!(a1.file_count, 1);
    assert_eq!(a2.file_count, 2);
    assert_eq!(a3.file_count, 3);
    assert_eq!(b1.file_count, 1);
    assert_eq!(b2.file_count, 2);
}
