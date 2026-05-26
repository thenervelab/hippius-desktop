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
use std::sync::Mutex;
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
    /// Lockout deadline. `Some(t)` means "any attempt before `t` is
    /// rejected"; `None` means "no active lockout".
    locked_until: Option<Instant>,
}

impl Default for State {
    fn default() -> Self {
        State {
            window_started_at: None,
            failures_in_window: 0,
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
}

impl RateLimitState {
    pub fn new() -> Self {
        RateLimitState::default()
    }

    /// Check whether a password attempt is currently allowed for
    /// `wallet_id`. Returns `Ok(())` if the call should proceed,
    /// [`RateLimitError`] if the wallet is locked out.
    pub fn check(&self, wallet_id: i64) -> Result<(), RateLimitError> {
        let mut map = self.inner.lock().expect("rate-limit mutex poisoned");
        let entry = map.entry(wallet_id).or_default();
        if let Some(until) = entry.locked_until {
            let now = Instant::now();
            if now < until {
                return Err(RateLimitError::Locked {
                    retry_after: until - now,
                });
            }
            // Lockout has elapsed — reset the counter so the user gets
            // a fresh window starting now.
            entry.locked_until = None;
            entry.window_started_at = None;
            entry.failures_in_window = 0;
        }
        Ok(())
    }

    /// Record a failed password attempt. May trigger a lockout — the
    /// caller doesn't need to do anything special on lockout; the next
    /// [`check`] call will surface it.
    pub fn record_failure(&self, wallet_id: i64) {
        let mut map = self.inner.lock().expect("rate-limit mutex poisoned");
        let entry = map.entry(wallet_id).or_default();
        let now = Instant::now();

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
}
