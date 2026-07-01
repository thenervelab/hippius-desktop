//! Per-label consecutive-failure counter for "Sync Failed" notifications.
//!
//! ## Problem this solves
//!
//! hcfs-client retries a failing sync cycle with growing backoff and emits one
//! `SyncEvent::SyncError` per failed cycle. A genuinely flaky endpoint
//! therefore fires a `SyncError` every cycle, and the desktop used to turn
//! each one into a fresh persisted "Sync Failed" notification — the spam the
//! user reported.
//!
//! ## Why we count per-label here instead of trusting the payload
//!
//! `SyncEvent::SyncError` carries a `consecutive_failures` count, but that
//! counter is a single **runner-global** `AtomicI64` on hcfs-client's
//! `SyncRunner` (verified `hcfs-client/src/engine/runner.rs:363`,
//! incremented at `:2134`, reset to 0 by `clear_failure_state` at `:2012` /
//! `:2055`). `trigger_sync` (`:1626`) fans out every drive concurrently
//! (`:1651`), so any one healthy drive's success resets the shared counter
//! every cycle. Gating a per-label notification on that global value means a
//! genuinely-down drive in a multi-drive account never accumulates to the
//! threshold — it would never notify. So the desktop keeps its OWN per-label
//! consecutive-failure count and ignores the payload's global value for
//! gating purposes.
//!
//! ## What this state encodes
//!
//! `label -> number of consecutive failed sync cycles`. The count itself is
//! the edge latch: we notify exactly when the incremented count first equals
//! the threshold, and stay silent for every higher count, so a sustained
//! outage produces one notification, not one per cycle. A `HashMap` (not a
//! `HashSet` + separate counter) is the right collection because the access
//! pattern is keyed lookup-and-increment (axiom `rust_quality_162`).
//!
//! ## Why a separate module
//!
//! Mirrors the [`crate::sync::credits_exhausted::CreditsExhaustedState`] /
//! [`crate::sync::preparing::PreparingState`] composition: an owned state
//! object held behind an `Arc` on [`crate::app_state::AppState`], `&self`
//! methods, and no `.await` under the lock so the sync-mutex-across-await
//! axiom (`rust_quality_74`) can never be tripped.
//!
//! ## Lifecycle invariants
//!
//! - [`ErrorNotifyState::record_failure`] — called from the non-cancel,
//!   `FailureNotify::Gated` branch of the `TauriSyncBridge` `SyncError`
//!   handler (the auto-retry loop). Returns `true` once per outage, on the
//!   cycle whose count first reaches the threshold.
//! - [`ErrorNotifyState::clear`] — called on a label's recovery edge
//!   (`handle_sync_completed`) and `SyncStopped`. Resets the count so the
//!   next outage starts fresh and re-notifies.
//! - [`ErrorNotifyState::clear_all`] — called from `SyncReset` (logout /
//!   account switch / reset) so a previous account's count can never suppress
//!   the first notification for a different account.
//!
//! KNOWN GAP (under-notification, never spam): hcfs-client's `NoChanges`
//! outcome (`runner.rs:2011`) — a healthy cycle with nothing to transfer —
//! resets its global counter but emits NO `SyncCompleted`, so a drive that
//! recovers while idle never reaches `clear` here. Its count stays at/above
//! the threshold, and a later genuine outage is suppressed until a cycle that
//! actually transfers files emits `SyncCompleted`. The safe direction (we
//! miss a later notification rather than spam). Closing it fully needs a
//! per-label "cycle ok" signal from hcfs-client on `NoChanges` (or clearing
//! on the global `HealthChanged → Connected` transition) — tracked follow-up.
//!
//! ## Concurrency
//!
//! The inner `std::sync::Mutex` is locked only for the duration of a single
//! map operation and every method returns an owned value, so the guard never
//! escapes a method or crosses an `.await`. The bridge handlers that call
//! these methods are synchronous (`SyncEventHandler::on_event` has no
//! `.await`), so the guard-across-await hazard (axiom `rust_quality_74`)
//! holds by construction.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

/// Per-label count of consecutive failed sync cycles. A label is absent until
/// its first failure and is removed again on recovery, so "present with count
/// ≥ threshold" means "currently in a notified outage".
///
/// Owned by [`crate::app_state::AppState`] behind an `Arc`, matching the
/// existing [`crate::sync::credits_exhausted::CreditsExhaustedState`] /
/// [`crate::sync::preparing::PreparingState`] pattern.
pub struct ErrorNotifyState {
    inner: Mutex<HashMap<String, u32>>,
}

impl Default for ErrorNotifyState {
    fn default() -> Self {
        Self::new()
    }
}

impl ErrorNotifyState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the inner mutex with a single poison-message helper.
    ///
    /// Poison is fatal for this state because the only writer is the
    /// single-threaded bridge handler — a panic while holding the guard means
    /// the count's invariant is already corrupt, so propagating (axiom
    /// `rust_quality_173`) is the correct policy.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, u32>> {
        self.inner.lock().expect("error-notify mutex poisoned")
    }

    /// Record one failed sync cycle for `label` and decide whether THIS cycle
    /// should surface a user-facing "Sync Failed" notification.
    ///
    /// Returns `true` exactly once per outage: on the cycle whose
    /// post-increment count first equals `threshold`. Counts below the
    /// threshold (a transient blip not yet proven a sustained outage) and
    /// counts above it (the outage continues — already notified) both return
    /// `false`, which is the edge-only behaviour that stops the per-cycle
    /// spam. The episode is reset by [`Self::clear`] / [`Self::clear_all`].
    ///
    /// `threshold` must be ≥ 1; with `0` the count (which starts at 1) never
    /// equals it and nothing ever notifies.
    pub fn record_failure(&self, label: &str, threshold: u32) -> bool {
        let mut g = self.lock();
        let count = g.entry(label.to_string()).or_insert(0);
        *count = count.saturating_add(1);
        *count == threshold
    }

    /// Reset `label`'s consecutive-failure count (recovery / teardown edge).
    /// Returns `true` if the label was being tracked (mirrors
    /// [`crate::sync::credits_exhausted::CreditsExhaustedState::clear`] so a
    /// caller can skip redundant follow-up work; both current call sites
    /// ignore it).
    ///
    /// Called on the recovery edge (`handle_sync_completed`) and on
    /// `SyncStopped`.
    pub fn clear(&self, label: &str) -> bool {
        self.lock().remove(label).is_some()
    }

    /// Reset every label's count. Called from `SyncReset` (logout / account
    /// switch / reset). Returns `true` if any label was tracked, mirroring
    /// [`crate::sync::credits_exhausted::CreditsExhaustedState::clear_all`]'s
    /// signature so the call sites stay symmetric.
    pub fn clear_all(&self) -> bool {
        let mut g = self.lock();
        let had_entries = !g.is_empty();
        g.clear();
        had_entries
    }

    /// Current consecutive-failure count for `label`, or `0` if untracked.
    /// Read-only diagnostic used by the tests; not on the bridge hot path.
    #[doc(hidden)]
    pub fn count_for(&self, label: &str) -> u32 {
        self.lock().get(label).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THRESHOLD: u32 = 3;

    #[test]
    fn notifies_once_exactly_on_threshold_cycle() {
        let state = ErrorNotifyState::new();
        // Cycles 1 and 2 are below the threshold — no notification.
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert!(!state.record_failure("drive-a", THRESHOLD));
        // Cycle 3 reaches the threshold — fires exactly once.
        assert!(state.record_failure("drive-a", THRESHOLD));
        // The outage continues — cycles 4, 5, ... must NOT re-notify.
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert_eq!(state.count_for("drive-a"), 5);
    }

    #[test]
    fn count_is_per_label_so_a_healthy_drive_cannot_mask_a_down_one() {
        // Regression for the runner-global-counter bug: drive-b stays down
        // while drive-a is healthy. drive-a never failing must not stop
        // drive-b from reaching its own threshold.
        let state = ErrorNotifyState::new();
        assert!(!state.record_failure("drive-b", THRESHOLD));
        assert!(!state.record_failure("drive-b", THRESHOLD));
        assert!(state.record_failure("drive-b", THRESHOLD));
        // drive-a's first-ever failure is independent and still below its own
        // threshold.
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert_eq!(state.count_for("drive-b"), 3);
        assert_eq!(state.count_for("drive-a"), 1);
    }

    #[test]
    fn clear_resets_so_a_second_outage_notifies_again() {
        let state = ErrorNotifyState::new();
        state.record_failure("drive-a", THRESHOLD);
        state.record_failure("drive-a", THRESHOLD);
        assert!(state.record_failure("drive-a", THRESHOLD));
        // Recovery edge clears the count and reports it was tracked.
        assert!(state.clear("drive-a"));
        assert_eq!(state.count_for("drive-a"), 0);
        // A fresh outage re-accumulates from 1 and fires again at the threshold.
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert!(state.record_failure("drive-a", THRESHOLD));
    }

    #[test]
    fn clear_returns_false_when_absent() {
        let state = ErrorNotifyState::new();
        assert!(!state.clear("never-failed"));
    }

    #[test]
    fn clear_all_resets_every_label() {
        let state = ErrorNotifyState::new();
        state.record_failure("drive-a", THRESHOLD);
        state.record_failure("drive-b", THRESHOLD);
        assert!(state.clear_all());
        assert_eq!(state.count_for("drive-a"), 0);
        assert_eq!(state.count_for("drive-b"), 0);
    }

    #[test]
    fn clear_all_returns_false_on_empty() {
        let state = ErrorNotifyState::new();
        assert!(!state.clear_all());
    }

    /// `u32::saturating_add` clamps at `u32::MAX` instead of wrapping to 0 —
    /// a drive failing for 4-billion-plus cycles must stay "well past the
    /// threshold" (no notification), not wrap back to 1 and re-fire.
    #[test]
    fn count_saturates_instead_of_wrapping() {
        let state = ErrorNotifyState::new();
        state.lock().insert("drive-a".to_string(), u32::MAX);
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert_eq!(state.count_for("drive-a"), u32::MAX);
    }

    /// Re-entrancy guardrail (parallels the `credits_exhausted` sibling test):
    /// `record_failure` MUST release the inner mutex before returning so the
    /// bridge can call it and then `clear`/`count_for` in sequence on the same
    /// thread. `std::sync::Mutex` is non-reentrant (axiom `rust_quality_118`).
    #[test]
    fn record_then_clear_does_not_deadlock_in_sequence() {
        let state = ErrorNotifyState::new();
        assert!(!state.record_failure("drive-a", THRESHOLD));
        assert_eq!(state.count_for("drive-a"), 1);
        assert!(state.clear("drive-a"));
        assert_eq!(state.count_for("drive-a"), 0);
    }
}
