//! Regression pins for the upload-processing **banner watchdog** —
//! Task 4.2 of `docs/plans/2026-05-13-sync-402-data-integrity.md`.
//!
//! # What this suite covers
//!
//! Four scenarios from the acceptance criteria, exercising the pure
//! [`UploadProcessingState::drain_expired`] method directly. Each
//! scenario constructs entries with a controlled `last_activity_at` and
//! a controlled `now`, so the assertion is timestamp-precise and
//! does NOT depend on wall-clock drift or `tokio::time::pause` (which
//! does not affect `std::time::Instant`).
//!
//! The watchdog spawned by `spawn_watchdog` is a thin loop around
//! `drain_expired`: `sleep(SCAN_INTERVAL)` → `drain_expired(Instant::now())`
//! → emit one event per cleared label. Testing `drain_expired` with
//! injected `Instant`s pins the load-bearing invariants
//! (`elapsed >= TIMEOUT` triggers, `< TIMEOUT` does not, `last_activity_at`
//! is refreshed on progress) without spawning a tokio task.
//!
//! # Why injected `Instant` instead of paused tokio time
//!
//! `tokio::time::pause` freezes `tokio::time::Instant::now`, but
//! `UploadProcessingInner::last_activity_at` is `std::time::Instant`. Mixing
//! the two clocks in a test that asserts "elapsed >= 60s" would be
//! exquisitely fragile. The watchdog already pulls `Instant::now()`
//! once per scan and passes it to `drain_expired` — making the
//! timestamp an explicit parameter on the pure method is the
//! cleanest way to drive deterministic tests.

use std::time::{Duration, Instant};
use tauri_project_lib::sync::upload_processing::{BANNER_WATCHDOG_IDLE_TIMEOUT, UploadProcessingState};

/// Construct an `Instant` `secs_ago` seconds before `now`.
///
/// Uses `checked_sub` because `Instant - Duration` can panic on
/// underflow if a test ever runs in the first 65s of process uptime.
/// The panic path is unreachable in practice (tests start well after
/// process init), but the assertion documents the invariant.
fn instant_secs_before(now: Instant, secs_ago: u64) -> Instant {
    now.checked_sub(Duration::from_secs(secs_ago))
        .expect("test fixture: Instant underflow — process uptime < secs_ago")
}

/// Scenario 1: banner raised, no progress events, `now` past timeout
/// → cleared.
///
/// Pins the basic timeout semantics. An entry stamped 65s ago with no
/// intervening progress must be drained at `now`.
#[test]
fn entry_older_than_timeout_is_cleared() {
    let state = UploadProcessingState::new();
    let now = Instant::now();
    let stamped = instant_secs_before(now, BANNER_WATCHDOG_IDLE_TIMEOUT.as_secs() + 5);
    state.begin_for_test_at(stamped, "drive-a", 1, 1);

    let cleared = state.drain_expired_for_test(now);
    assert_eq!(cleared, vec!["drive-a".to_string()]);
    assert!(!state.is_active_for("drive-a"));
}

/// Scenario 2: banner raised, a progress event landed at `t = 30s`,
/// `now = 90s` → cleared (since refreshed `last_activity_at = 30s` is now
/// 60s old, hits the >= TIMEOUT boundary).
///
/// This is the "watchdog respects refreshes" case: the entry started
/// at t=0 but a same-cycle event (clear_if_session_advanced no-op)
/// pushed `last_activity_at` to t=30s. At t=90s the entry must be drained.
#[test]
fn refreshed_entry_clears_after_timeout_from_refresh() {
    let state = UploadProcessingState::new();
    let now = Instant::now();

    // Original begin at t=0 (90s before "now"); refresh at t=30s
    // (60s before "now"). The refresh sets last_activity_at = 60s ago,
    // which equals the boundary BANNER_WATCHDOG_IDLE_TIMEOUT.
    let begin_at = instant_secs_before(now, 90);
    let refresh_at = instant_secs_before(now, BANNER_WATCHDOG_IDLE_TIMEOUT.as_secs());
    state.begin_for_test_at(begin_at, "drive-a", 1, 5);
    // Same-epoch event — clears nothing but refreshes last_activity_at.
    state.clear_if_session_advanced_for_test_at(refresh_at, "drive-a", 5);

    let cleared = state.drain_expired_for_test(now);
    assert_eq!(cleared, vec!["drive-a".to_string()]);
}

/// Scenario 3: banner raised, progress event at `t = 50s`,
/// `now = 90s` → NOT cleared (only 40s elapsed since refresh, under
/// the 60s threshold).
///
/// Pins that a recent progress signal protects the entry from the
/// watchdog. This is the user-visible "active sync should not have
/// its banner cleared" invariant.
#[test]
fn recent_refresh_protects_entry() {
    let state = UploadProcessingState::new();
    let now = Instant::now();

    // Begin at t=0 (90s ago); refresh at t=50s (40s ago).
    let begin_at = instant_secs_before(now, 90);
    let refresh_at = instant_secs_before(now, 40);
    state.begin_for_test_at(begin_at, "drive-a", 1, 5);
    state.clear_if_session_advanced_for_test_at(refresh_at, "drive-a", 5);

    let cleared = state.drain_expired_for_test(now);
    assert!(cleared.is_empty(), "fresh refresh must protect entry from watchdog");
    assert!(state.is_active_for("drive-a"));
}

/// Scenario 4: a banner cleared normally via `clear_if_session_advanced`
/// → watchdog does not try to clear it again.
///
/// Idempotence with the epoch-gated clear path: once the entry is
/// removed, a subsequent `drain_expired` is a no-op for that label.
#[test]
fn normally_cleared_entry_is_not_double_cleared() {
    let state = UploadProcessingState::new();
    let now = Instant::now();
    let stamped = instant_secs_before(now, BANNER_WATCHDOG_IDLE_TIMEOUT.as_secs() + 5);
    state.begin_for_test_at(stamped, "drive-a", 1, 1);
    // Epoch advance — normal clear path removes the entry.
    state.clear_if_session_advanced_for_test_at(now, "drive-a", 2);
    assert!(!state.is_active_for("drive-a"));

    let cleared = state.drain_expired_for_test(now);
    assert!(cleared.is_empty(), "watchdog must not re-clear an already-removed entry");
}

/// Idle semantics: an engine progress tick (`touch` — scan / fetch /
/// encrypt / transfer callbacks) refreshes the idle window, so a banner
/// over a multi-minute scan/encrypt phase survives sweeps far beyond
/// the timeout as measured from `begin`. Silence still clears: one idle
/// window after the last tick, the entry is drained.
#[test]
fn engine_activity_keeps_banner_alive_past_wall_clock_timeout() {
    let state = UploadProcessingState::new();
    let now = Instant::now();

    // Begin 5 minutes ago; the last engine tick landed 30s ago.
    let begin_at = instant_secs_before(now, 300);
    let tick_at = instant_secs_before(now, 30);
    state.begin_for_test_at(begin_at, "drive-a", 1, 5);
    state.touch_for_test_at(tick_at, "drive-a");

    assert!(
        state.drain_expired_for_test(now).is_empty(),
        "activity 30s ago must protect the banner despite 5min since begin"
    );
    assert!(state.is_active_for("drive-a"));

    // One full idle window after that last tick → drained.
    let idle_now = now + BANNER_WATCHDOG_IDLE_TIMEOUT;
    assert_eq!(state.drain_expired_for_test(idle_now), vec!["drive-a".to_string()]);
}

/// Watchdog only clears labels whose entries are individually stale —
/// it must NOT touch labels whose `last_activity_at` is fresh. This is the
/// per-label isolation invariant that the rest of `upload_processing`
/// is built on.
#[test]
fn watchdog_only_clears_stale_labels() {
    let state = UploadProcessingState::new();
    let now = Instant::now();
    let stale_at = instant_secs_before(now, BANNER_WATCHDOG_IDLE_TIMEOUT.as_secs() + 1);
    let fresh_at = instant_secs_before(now, 5);

    state.begin_for_test_at(stale_at, "drive-stale", 1, 1);
    state.begin_for_test_at(fresh_at, "drive-fresh", 1, 1);

    let cleared = state.drain_expired_for_test(now);
    assert_eq!(cleared, vec!["drive-stale".to_string()]);
    assert!(!state.is_active_for("drive-stale"));
    assert!(state.is_active_for("drive-fresh"), "fresh entry must survive the scan");
}

/// Below-threshold elapsed time is a no-op even at the exact boundary
/// minus one second. The watchdog uses `>= TIMEOUT`, so this exercises
/// the closed-interval edge.
#[test]
fn just_under_timeout_is_noop() {
    let state = UploadProcessingState::new();
    let now = Instant::now();
    let stamped = instant_secs_before(now, BANNER_WATCHDOG_IDLE_TIMEOUT.as_secs() - 1);
    state.begin_for_test_at(stamped, "drive-a", 1, 1);

    let cleared = state.drain_expired_for_test(now);
    assert!(cleared.is_empty());
    assert!(state.is_active_for("drive-a"));
}

/// At the exact boundary (`elapsed == TIMEOUT`), the entry MUST be
/// cleared. The watchdog comparison is `>=`, so the boundary case
/// counts as "expired". This pin protects against a silent flip to
/// `>` (strict inequality), which would extend the effective timeout
/// by one scan tick.
#[test]
fn exactly_at_timeout_is_cleared() {
    let state = UploadProcessingState::new();
    let now = Instant::now();
    let stamped = instant_secs_before(now, BANNER_WATCHDOG_IDLE_TIMEOUT.as_secs());
    state.begin_for_test_at(stamped, "drive-a", 1, 1);

    let cleared = state.drain_expired_for_test(now);
    assert_eq!(cleared, vec!["drive-a".to_string()]);
}

/// Multiple stale entries are reported in sorted order. The
/// downstream emit loop in `spawn_watchdog` walks the returned `Vec`
/// in order; deterministic ordering keeps the emitted-event log
/// reproducible for log-driven debugging.
#[test]
fn drain_expired_returns_sorted_labels() {
    let state = UploadProcessingState::new();
    let now = Instant::now();
    let stamped = instant_secs_before(now, BANNER_WATCHDOG_IDLE_TIMEOUT.as_secs() + 1);
    // Insert in non-sorted order; HashMap iteration is unspecified.
    state.begin_for_test_at(stamped, "zebra", 1, 1);
    state.begin_for_test_at(stamped, "alpha", 1, 1);
    state.begin_for_test_at(stamped, "mango", 1, 1);

    let cleared = state.drain_expired_for_test(now);
    assert_eq!(cleared, vec!["alpha".to_string(), "mango".to_string(), "zebra".to_string()]);
}
