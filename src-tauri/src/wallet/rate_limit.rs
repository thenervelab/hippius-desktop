//! In-memory rate limiter for local-wallet password operations.
//!
//! # Threat model
//!
//! Argon2id alone caps offline brute force at roughly one guess every
//! 50–100 ms of CPU per attacker thread. That's slow at billions/sec
//! scale but still meaningful if the attacker has IPC access to the
//! renderer — they could fire `local_wallet_verify_password` /
//! `local_wallet_get_decrypted_mnemonic` / `local_wallet_sign` in a
//! tight loop and try ~10 passwords/sec/core unbounded.
//!
//! This module clamps that. Each wallet `id` gets its own counter:
//! after [`FAIL_THRESHOLD_SOFT`] failed attempts inside
//! [`WINDOW`], every subsequent attempt is rejected with a
//! [`RateLimitError::Locked`] for [`LOCKOUT_SOFT`]. After
//! [`FAIL_THRESHOLD_HARD`] failures, the lockout extends to
//! [`LOCKOUT_HARD`]. A successful unlock resets the counter.
//!
//! All state is process-local — restarting the app clears the lockout.
//! That's intentional: an attacker who has filesystem access to the DB
//! is already in the Argon2id offline-brute-force regime, where this
//! limiter buys nothing. The job here is purely "stop online IPC
//! abuse from inside a misbehaving renderer or test harness".

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Sliding-window size for counting failures.
pub const WINDOW: Duration = Duration::from_secs(60);
/// Soft threshold: first lockout tier.
pub const FAIL_THRESHOLD_SOFT: u32 = 5;
/// Hard threshold: longer lockout.
pub const FAIL_THRESHOLD_HARD: u32 = 10;
/// First-tier lockout duration.
pub const LOCKOUT_SOFT: Duration = Duration::from_secs(30);
/// Second-tier lockout duration. Long enough that an attacker
/// scripting attempts isn't burning meaningful guesses per minute.
pub const LOCKOUT_HARD: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy)]
pub enum RateLimitError {
    /// `retry_after` is the wall-clock remaining lockout.
    Locked { retry_after: Duration },
}

impl RateLimitError {
    /// Human-readable error string for the FE. Avoids exposing exact
    /// counter internals — just tells the user how long to wait.
    pub fn message(&self) -> String {
        match self {
            RateLimitError::Locked { retry_after } => {
                let secs = retry_after.as_secs().max(1);
                if secs >= 60 {
                    let mins = (secs + 59) / 60;
                    format!("Too many failed attempts. Try again in {mins} minute(s).")
                } else {
                    format!("Too many failed attempts. Try again in {secs} second(s).")
                }
            }
        }
    }
}

#[derive(Debug)]
struct State {
    /// First failure timestamp in the current window. `None` between
    /// windows / immediately after a successful unlock.
    window_started_at: Option<Instant>,
    /// Failure count in the current window.
    failures_in_window: u32,
    /// Attempts admitted by [`RateLimitState::check`] that have not yet
    /// recorded a result. Closes the check/verify/record TOCTOU: the
    /// password verify (Argon2id, ~50–100 ms) runs *outside* the lock, so on
    /// a multi-threaded runtime N attempts could each pass `check` before any
    /// recorded a failure and bypass the cap. Counting in-flight attempts
    /// toward the threshold (`failures_in_window + in_flight`) makes
    /// concurrent callers see one another, so at most the threshold number of
    /// verifies run before `check` starts rejecting. Decremented by
    /// `record_failure` / `record_success`; self-heals to 0 on lockout expiry
    /// so a caller that returns without recording cannot leak a reservation
    /// past one lockout cycle.
    in_flight: u32,
    /// Lockout deadline. `Some(t)` means "any attempt before `t` is
    /// rejected"; `None` means "no active lockout".
    locked_until: Option<Instant>,
}

impl Default for State {
    fn default() -> Self {
        State {
            window_started_at: None,
            failures_in_window: 0,
            in_flight: 0,
            locked_until: None,
        }
    }
}

/// Process-wide per-wallet rate-limit state. Lives behind a `Mutex` —
/// contention is negligible: each call holds the lock for a few
/// microseconds.
#[derive(Default)]
pub struct RateLimitState {
    inner: Mutex<HashMap<i64, State>>,
    /// Per-wallet serialization gates. A password attempt acquires its
    /// wallet's gate for the WHOLE `check` → verify → `record_*` sequence
    /// (see [`attempt_gate`]). Without it, a burst of concurrent IPC calls
    /// on one wallet all clear [`check`] before any [`record_failure`] runs,
    /// so they slip past the lockout threshold together and Argon2id's
    /// per-attempt cost becomes the only throttle (audit 2026-06-05, finding
    /// B1). The registry `Mutex` is held only briefly to clone out the `Arc`;
    /// the actual serialization is the per-wallet `tokio::sync::Mutex`, which
    /// is an async lock so attempts queue without blocking a runtime thread.
    attempt_gates: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
}

impl RateLimitState {
    pub fn new() -> Self {
        RateLimitState::default()
    }

    /// Acquire `wallet_id`'s serialization gate, returning a guard that the
    /// caller MUST hold for the entire `check` → verify → `record_*`
    /// sequence. Concurrent attempts on the same wallet queue behind the
    /// guard, so the lockout threshold can no longer be outrun by a burst
    /// (audit 2026-06-05, finding B1). Attempts on *different* wallets never
    /// contend — each id has its own gate.
    pub async fn attempt_gate(&self, wallet_id: i64) -> tokio::sync::OwnedMutexGuard<()> {
        let gate = {
            let mut gates = self.attempt_gates.lock().expect("rate-limit gate mutex poisoned");
            Arc::clone(gates.entry(wallet_id).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))))
        };
        gate.lock_owned().await
    }

    /// Check whether a password attempt is allowed for `wallet_id`, and
    /// reserve it.
    ///
    /// Returns `Ok(())` if the call should proceed (and counts it as in-flight)
    /// or [`RateLimitError`] if the wallet is locked out or too many attempts
    /// are already outstanding. The caller MUST follow an `Ok(())` with exactly
    /// one of [`record_success`](Self::record_success) /
    /// [`record_failure`](Self::record_failure) to release the reservation; all
    /// three current call sites in `wallet::commands` do.
    ///
    /// The `in_flight` reservation is belt-and-suspenders under the per-wallet
    /// [`attempt_gate`](Self::attempt_gate), which already serializes the
    /// check→verify→record sequence: the threshold is evaluated against
    /// `failures_in_window + in_flight`, so even a caller that forgot the gate
    /// cannot outrun the lockout (audit 2026-06-05, finding B1).
    pub fn check(&self, wallet_id: i64) -> Result<(), RateLimitError> {
        let mut map = self.inner.lock().expect("rate-limit mutex poisoned");
        let entry = map.entry(wallet_id).or_default();
        let now = Instant::now();
        if let Some(until) = entry.locked_until {
            if now < until {
                return Err(RateLimitError::Locked {
                    retry_after: until - now,
                });
            }
            // Lockout has elapsed — reset the counter so the user gets a fresh
            // window starting now. Also clear any in_flight that a non-pairing
            // caller may have leaked: after a full lockout no attempt is
            // genuinely still running, so this bounds a leak to one cycle.
            entry.locked_until = None;
            entry.window_started_at = None;
            entry.failures_in_window = 0;
            entry.in_flight = 0;
        }

        // Outstanding = already-recorded failures this window + attempts admitted
        // but not yet resolved. Reject (and latch a lockout) once it reaches a
        // threshold so a burst of parallel attempts cannot exceed the cap.
        let outstanding = entry.failures_in_window.saturating_add(entry.in_flight);
        if outstanding >= FAIL_THRESHOLD_HARD {
            entry.locked_until = Some(now + LOCKOUT_HARD);
            return Err(RateLimitError::Locked { retry_after: LOCKOUT_HARD });
        }
        if outstanding >= FAIL_THRESHOLD_SOFT {
            entry.locked_until = Some(now + LOCKOUT_SOFT);
            return Err(RateLimitError::Locked { retry_after: LOCKOUT_SOFT });
        }

        entry.in_flight = entry.in_flight.saturating_add(1);
        Ok(())
    }

    /// Record a failed password attempt. May trigger a lockout — the
    /// caller doesn't need to do anything special on lockout; the next
    /// [`check`] call will surface it.
    pub fn record_failure(&self, wallet_id: i64) {
        let mut map = self.inner.lock().expect("rate-limit mutex poisoned");
        let entry = map.entry(wallet_id).or_default();
        let now = Instant::now();

        // Release the reservation taken by `check`; the failure now counts
        // toward `failures_in_window` instead.
        entry.in_flight = entry.in_flight.saturating_sub(1);

        match entry.window_started_at {
            Some(started) if now.duration_since(started) <= WINDOW => {
                entry.failures_in_window += 1;
            }
            _ => {
                entry.window_started_at = Some(now);
                entry.failures_in_window = 1;
            }
        }

        if entry.failures_in_window >= FAIL_THRESHOLD_HARD {
            entry.locked_until = Some(now + LOCKOUT_HARD);
        } else if entry.failures_in_window >= FAIL_THRESHOLD_SOFT {
            entry.locked_until = Some(now + LOCKOUT_SOFT);
        }
    }

    /// Wipe a wallet's counter on successful unlock. Without this a
    /// user who fat-fingered their password 4 times and then got it
    /// right on the 5th would still be one mistake away from
    /// triggering the lockout.
    pub fn record_success(&self, wallet_id: i64) {
        let mut map = self.inner.lock().expect("rate-limit mutex poisoned");
        if let Some(entry) = map.get_mut(&wallet_id) {
            entry.window_started_at = None;
            entry.failures_in_window = 0;
            // Release this attempt's reservation. Decrement (not zero) so a
            // concurrent in-flight attempt on the same wallet keeps its slot.
            entry.in_flight = entry.in_flight.saturating_sub(1);
            entry.locked_until = None;
        }
    }

    /// Test-only: forcibly reset all state. Real callers should never
    /// need this — the public API resets per-wallet on success.
    #[cfg(test)]
    pub fn reset_all(&self) {
        self.inner.lock().expect("rate-limit mutex poisoned").clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_passes_when_no_failures_recorded() {
        let rl = RateLimitState::new();
        assert!(rl.check(1).is_ok());
    }

    #[test]
    fn soft_lockout_after_threshold() {
        let rl = RateLimitState::new();
        for _ in 0..FAIL_THRESHOLD_SOFT {
            rl.record_failure(42);
        }
        match rl.check(42) {
            Err(RateLimitError::Locked { retry_after }) => {
                // Should be ~30s, allow a generous slack on slow CI.
                assert!(retry_after <= LOCKOUT_SOFT);
                assert!(retry_after > Duration::from_secs(0));
            }
            Ok(()) => panic!("expected lockout after {} failures", FAIL_THRESHOLD_SOFT),
        }
    }

    #[test]
    fn hard_lockout_after_more_failures() {
        let rl = RateLimitState::new();
        for _ in 0..FAIL_THRESHOLD_HARD {
            rl.record_failure(42);
        }
        match rl.check(42) {
            Err(RateLimitError::Locked { retry_after }) => {
                assert!(retry_after <= LOCKOUT_HARD);
                // Hard lockout MUST be > soft so the message says
                // "minutes" not "seconds".
                assert!(retry_after > LOCKOUT_SOFT);
            }
            Ok(()) => panic!("expected hard lockout"),
        }
    }

    #[test]
    fn success_clears_failure_counter() {
        let rl = RateLimitState::new();
        for _ in 0..(FAIL_THRESHOLD_SOFT - 1) {
            rl.record_failure(42);
        }
        rl.record_success(42);
        // Next single failure must NOT trip the lockout — the counter
        // has been wiped.
        rl.record_failure(42);
        assert!(rl.check(42).is_ok());
    }

    #[test]
    fn parallel_in_flight_attempts_capped_at_threshold() {
        // The TOCTOU fix: each `check` that returns Ok reserves an in-flight
        // slot, so a burst of attempts that pass `check` before any records a
        // result (the race window on a multi-threaded runtime) cannot exceed
        // the cap. Simulate 50 concurrent admits with no record in between.
        let rl = RateLimitState::new();
        let admitted = (0..50).filter(|_| rl.check(7).is_ok()).count();
        assert_eq!(
            admitted as u32, FAIL_THRESHOLD_SOFT,
            "at most the soft threshold of concurrent in-flight attempts may be admitted"
        );
        // Further attempts stay locked out.
        assert!(rl.check(7).is_err());
    }

    #[test]
    fn in_flight_reservation_released_on_record() {
        // A normal serial failure (check reserves, record_failure releases)
        // nets exactly one counted failure, so the cap is reached after
        // exactly FAIL_THRESHOLD_SOFT real attempts — not sooner.
        let rl = RateLimitState::new();
        for _ in 0..(FAIL_THRESHOLD_SOFT - 1) {
            assert!(rl.check(9).is_ok(), "attempt under the cap must be admitted");
            rl.record_failure(9);
        }
        // One slot left.
        assert!(rl.check(9).is_ok());
        rl.record_failure(9);
        // Now at the cap: next attempt rejected.
        assert!(rl.check(9).is_err());
    }

    #[test]
    fn lockout_scoped_per_wallet() {
        let rl = RateLimitState::new();
        for _ in 0..FAIL_THRESHOLD_SOFT {
            rl.record_failure(1);
        }
        // Wallet 1 is locked; wallet 2 should be unaffected.
        assert!(rl.check(1).is_err());
        assert!(rl.check(2).is_ok());
    }

    #[test]
    fn rate_limit_error_message_uses_seconds_under_minute() {
        let err = RateLimitError::Locked {
            retry_after: Duration::from_secs(20),
        };
        assert!(err.message().contains("second"));
        assert!(!err.message().contains("minute"));
    }

    #[test]
    fn rate_limit_error_message_uses_minutes_over_minute() {
        let err = RateLimitError::Locked {
            retry_after: Duration::from_secs(180),
        };
        assert!(err.message().contains("minute"));
    }

    /// A burst of concurrent attempts on one wallet must NOT all slip past
    /// the lockout. With the per-wallet `attempt_gate` serializing
    /// check → record, exactly `FAIL_THRESHOLD_SOFT` attempts clear `check`
    /// before the threshold-th `record_failure` arms the lockout; every
    /// later attempt sees `Locked`. Without the gate (the audit B1 bug) all
    /// N would clear `check` before any failure recorded. The `yield_now`
    /// between check and record widens the window so a missing gate would
    /// reliably let the burst through (axiom rust_quality_123 — the bug is
    /// interleaving-dependent and invisible to a serial test).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_burst_cannot_outrun_the_lockout_threshold() {
        let rl = Arc::new(RateLimitState::new());
        let wallet_id = 99;
        let attempts = (FAIL_THRESHOLD_SOFT + 5) as usize;

        let mut handles = Vec::with_capacity(attempts);
        for _ in 0..attempts {
            let rl = Arc::clone(&rl);
            handles.push(tokio::spawn(async move {
                let _gate = rl.attempt_gate(wallet_id).await;
                if rl.check(wallet_id).is_ok() {
                    // Simulate the slow Argon2id verify window between the
                    // gate-protected check and the failure record.
                    tokio::task::yield_now().await;
                    rl.record_failure(wallet_id);
                    true
                } else {
                    false
                }
            }));
        }

        let mut passed = 0usize;
        for h in handles {
            if h.await.expect("attempt task panicked") {
                passed += 1;
            }
        }

        assert_eq!(
            passed, FAIL_THRESHOLD_SOFT as usize,
            "exactly FAIL_THRESHOLD_SOFT attempts may clear `check` before the lockout arms; \
             {passed} cleared, which means the burst outran the threshold (gate not serializing)"
        );
        assert!(rl.check(wallet_id).is_err(), "wallet must be locked out after the burst");
    }
}
