//! Per-label running counter for `InsufficientBalance` file failures.
//!
//! Bridges the gap between an individual `FileFailed { kind: InsufficientBalance }`
//! event and the "Out of credits" banner UX (Task 3.2 of
//! `docs/plans/2026-05-13-sync-402-data-integrity.md`): the banner needs to
//! report how many files in the *current* sync cycle have been blocked by
//! the 402, not just the most recent one. Without a counter, the FE would
//! either flicker (one event per file replacing the previous payload) or
//! under-count (showing only "1 file paused" while N files actually were).
//!
//! ## Why a separate module
//!
//! Mirrors the [`crate::sync::preparing::PreparingState`] composition
//! pattern exactly: an owned `Arc<Mutex<HashMap<String, u32>>>` field on
//! `AppState`, methods that take `&self`, no internal `.await` so the
//! sync-mutex-across-await axiom can never be tripped. Co-locating with
//! `PreparingState` would conflate two different lifecycles
//! ("scan-and-plan window" vs. "running 402 count") with no upside.
//!
//! ## Lifecycle invariants
//!
//! - [`CreditsExhaustedState::record_failure`] — called from the
//!   `TauriSyncBridge` `FileFailed { kind: InsufficientBalance, .. }` arm.
//!   Returns the post-increment count for that label so the bridge can
//!   attach it to the outgoing `hcfs_credits_exhausted` payload in a
//!   single lock acquisition (read-modify-read would otherwise need two).
//! - [`CreditsExhaustedState::clear`] — called from `SyncStarted`,
//!   `SyncStopped`, and the `SyncError` non-cancel branch for the label
//!   whose cycle is opening or closing. A fresh cycle MUST start at zero
//!   so the banner's "N files paused" count reflects only the current
//!   cycle's outstanding failures.
//! - [`CreditsExhaustedState::clear_all`] — called from `SyncReset`
//!   (logout / account switch / reset) where every per-label counter
//!   must be wiped before a different account's data could touch it.
//!
//! ## Concurrency
//!
//! The inner `std::sync::Mutex` is locked only for the duration of a
//! single map operation. The bridge handlers that invoke these methods
//! are synchronous (`SyncEventHandler::on_event` has no `.await`), so the
//! sync-mutex-across-await axiom holds by construction. A future refactor
//! that made `on_event` async would need to drop the guard before any
//! `.await` (the methods here already return owned values, so the guard
//! never escapes a method).

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

/// Map of drive label → number of `InsufficientBalance` failures observed
/// in the current sync cycle. Reset to zero on the next `SyncStarted` for
/// that label, cleared entirely on `SyncReset`.
///
/// Owned by [`crate::app_state::AppState`] behind an `Arc`, matching the
/// existing [`crate::sync::preparing::PreparingState`] /
/// [`crate::sync::upload_processing::UploadProcessingState`] pattern.
pub struct CreditsExhaustedState {
    /// `u32` is sized for the only operation the banner needs: "how many
    /// files have been 402'd in this cycle?". A drive with more than
    /// 4 billion 402'd files in one cycle is not a real scenario; if it
    /// were, the OOM from the file list itself would arrive first.
    inner: Mutex<HashMap<String, u32>>,
}

impl Default for CreditsExhaustedState {
    fn default() -> Self {
        Self::new()
    }
}

impl CreditsExhaustedState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the inner mutex with a single poison-message helper.
    ///
    /// Centralises the `expect` panic message so future additions to the
    /// API can't introduce a new wording variant. Poison is fatal for
    /// this state because the only writer is the (single-threaded)
    /// bridge handler — if it panicked while holding the guard, the
    /// invariant the counter encodes is already corrupt.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, u32>> {
        self.inner.lock().expect("credits-exhausted mutex poisoned")
    }

    /// Record one `InsufficientBalance` failure for `label`. Returns the
    /// post-increment count for the same label.
    ///
    /// Returning the post-increment value avoids a follow-up read on the
    /// same lock acquisition: the bridge needs the count anyway for the
    /// `file_count` field of the emitted payload, and a separate read
    /// would either re-lock (waste) or expose a non-atomic "increment
    /// then read" window where a concurrent `clear` could zero the
    /// counter between the two operations.
    pub fn record_failure(&self, label: &str) -> u32 {
        let mut g = self.lock();
        let entry = g.entry(label.to_string()).or_insert(0);
        *entry = entry.saturating_add(1);
        *entry
    }

    /// Remove `label` from the map. Returns `true` if the label was
    /// present (caller can use this to skip a redundant re-emit when
    /// nothing changed).
    ///
    /// Called on `SyncStarted` (fresh cycle), `SyncStopped` (drive paused
    /// / removed), and the non-cancel branch of `SyncError` (so a
    /// transport-level cycle failure doesn't leave a stale per-file 402
    /// count hanging around — a new cycle will re-count from zero).
    pub fn clear(&self, label: &str) -> bool {
        self.lock().remove(label).is_some()
    }

    /// Remove every label's counter. Called from `SyncReset` (logout /
    /// account switch / reset). Returns `true` if the map was non-empty
    /// before the clear, mirroring [`PreparingState::clear_all`]'s
    /// signature so the call sites can be symmetric.
    pub fn clear_all(&self) -> bool {
        let mut g = self.lock();
        let had_entries = !g.is_empty();
        g.clear();
        had_entries
    }

    /// Current count for `label`, or `0` if no failure has been recorded
    /// this cycle. Read-only diagnostic — tests and the bridge already
    /// use the value returned by [`record_failure`] so this method is
    /// not on the hot path.
    #[doc(hidden)]
    pub fn count_for(&self, label: &str) -> u32 {
        self.lock().get(label).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_failure_returns_running_count() {
        let state = CreditsExhaustedState::new();
        assert_eq!(state.record_failure("drive-a"), 1);
        assert_eq!(state.record_failure("drive-a"), 2);
        assert_eq!(state.record_failure("drive-a"), 3);
    }

    #[test]
    fn record_failure_is_per_label() {
        let state = CreditsExhaustedState::new();
        assert_eq!(state.record_failure("drive-a"), 1);
        assert_eq!(state.record_failure("drive-b"), 1);
        assert_eq!(state.record_failure("drive-a"), 2);
        assert_eq!(state.count_for("drive-a"), 2);
        assert_eq!(state.count_for("drive-b"), 1);
    }

    #[test]
    fn clear_resets_a_single_label() {
        let state = CreditsExhaustedState::new();
        state.record_failure("drive-a");
        state.record_failure("drive-a");
        state.record_failure("drive-b");
        assert!(state.clear("drive-a"));
        assert_eq!(state.count_for("drive-a"), 0);
        // The other label survives — invariant: per-label scoping.
        assert_eq!(state.count_for("drive-b"), 1);
    }

    #[test]
    fn clear_returns_false_when_absent() {
        let state = CreditsExhaustedState::new();
        assert!(!state.clear("nobody"));
    }

    #[test]
    fn clear_all_removes_every_label() {
        let state = CreditsExhaustedState::new();
        state.record_failure("drive-a");
        state.record_failure("drive-b");
        assert!(state.clear_all());
        assert_eq!(state.count_for("drive-a"), 0);
        assert_eq!(state.count_for("drive-b"), 0);
    }

    #[test]
    fn clear_all_returns_false_on_empty() {
        let state = CreditsExhaustedState::new();
        assert!(!state.clear_all());
    }

    #[test]
    fn count_for_returns_zero_for_unknown_label() {
        let state = CreditsExhaustedState::new();
        assert_eq!(state.count_for("never-failed"), 0);
    }

    /// Re-entrancy guardrail (parallels `PreparingState::mark_then_read_does_not_deadlock_in_sequence`).
    ///
    /// `record_failure` MUST release the inner mutex before returning so
    /// the bridge can call it and then call `count_for`/`clear` in
    /// sequence on the same thread. `std::sync::Mutex` is non-reentrant
    /// — a refactor that extended the guard's lifetime (e.g. returning
    /// the guard alongside the count) would deadlock at runtime.
    #[test]
    fn record_then_read_does_not_deadlock_in_sequence() {
        let state = CreditsExhaustedState::new();
        assert_eq!(state.record_failure("drive-a"), 1);
        assert_eq!(state.count_for("drive-a"), 1);
        assert!(state.clear("drive-a"));
        assert_eq!(state.count_for("drive-a"), 0);
    }

    /// `u32::saturating_add(1)` clamps at `u32::MAX` instead of wrapping
    /// to zero. The banner would otherwise report "0 files paused" after
    /// the 4-billion-and-first failure — wrong, but a textbook overflow.
    /// Saturating is the right semantic: hitting the cap means "very
    /// many files failed", and clamping preserves the "≥1" invariant the
    /// banner reads.
    #[test]
    fn record_failure_saturates_instead_of_wrapping() {
        let state = CreditsExhaustedState::new();
        // Seed the counter at u32::MAX via direct map access. Going
        // through `record_failure` u32::MAX times is not feasible in a
        // unit test, so we reach into the lock once and seed.
        state.lock().insert("drive-a".to_string(), u32::MAX);
        // Next `record_failure` MUST stay at u32::MAX, not wrap to 0.
        assert_eq!(state.record_failure("drive-a"), u32::MAX);
        assert_eq!(state.count_for("drive-a"), u32::MAX);
    }
}
