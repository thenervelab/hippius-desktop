//! Pure, I/O-free logic helpers for the sync engine.
//!
//! Functions in this module are deterministic and side-effect-free (except for
//! explicitly passed atomics), so they can be unit-tested exhaustively without
//! mocking `SyncRunner`, Tauri, or the filesystem.
//!
//! # Snapshot emit throttling
//!
//! Every per-chunk progress tick from `hcfs-client` flows through
//! [`crate::sync::progress::update_file_progress`], which previously called
//! `SyncRunner::emit_snapshot(false)` unconditionally. On macOS that routes
//! into `wkwebview.eval("...")` on the main thread, where WebKit blocks
//! converting the JSON payload to an `NSString`. Under a large session, the
//! main thread cannot drain its eval queue and the app hangs for tens of
//! seconds (see bug report dated 2026-04-05).
//!
//! [`should_emit_snapshot`] and [`try_claim_snapshot_emit`] implement the
//! leading edge of the throttle: only the first call in any `min_interval_ms`
//! window triggers an emit. File-completion ticks use a shorter 100 ms window
//! ([`COMPLETION_THROTTLE_MS`]) to batch burst completions while remaining
//! visually responsive at 10 Hz. [`should_schedule_flush`] supplies the
//! trailing edge: a suppressed call schedules one deferred emit at window end
//! (see `crate::sync::progress`), so the final tick of a burst is never lost.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Sentinel stored in the snapshot-emit cursor to mean "no prior emit has
/// been recorded". Chosen as [`u64::MAX`] so the first call to
/// [`try_claim_snapshot_emit`] is treated as having infinite elapsed time and
/// therefore always claims. This keeps the first per-chunk progress tick in
/// the UI responsive at process startup, when the real monotonic millisecond
/// counter is close to zero.
///
/// Real monotonic timestamps (derived from [`std::time::Instant`]) will not
/// reach this value within any realistic process lifetime, so there is no
/// risk of an honest timestamp being misinterpreted as the sentinel.
pub const NEVER_EMITTED: u64 = u64::MAX;

/// Shorter throttle window for file-completion ticks.
/// Batches burst completions (many files finishing within milliseconds)
/// while still being responsive — 10 Hz is visually smooth.
const COMPLETION_THROTTLE_MS: u64 = 100;

/// Decide whether a throttled snapshot emit should fire.
///
/// Returns `true` when either:
/// - the caller is reporting a file completion (`is_file_complete`) and at
///   least [`COMPLETION_THROTTLE_MS`] have elapsed, or
/// - at least `min_interval_ms` have elapsed since the previous emit.
///
/// Pure function with no side effects — safe to call from any thread.
///
/// # Arguments
/// * `elapsed_since_last_ms` — milliseconds since the last throttled emit.
///   Monotonic. Callers should derive this from [`std::time::Instant`], not
///   wall-clock time, so that backward NTP jumps cannot stall the throttle.
/// * `is_file_complete` — `true` when this tick represents `bytes == total`
///   for a file. Completion ticks use a shorter 100 ms window so burst
///   completions are batched without flooding the WebKit eval queue.
/// * `min_interval_ms` — minimum gap between throttled emits. `0` disables
///   the throttle entirely (every call emits).
pub const fn should_emit_snapshot(elapsed_since_last_ms: u64, is_file_complete: bool, min_interval_ms: u64) -> bool {
    if is_file_complete {
        elapsed_since_last_ms >= COMPLETION_THROTTLE_MS
    } else {
        elapsed_since_last_ms >= min_interval_ms
    }
}

/// Attempt to claim a throttled snapshot emit slot.
///
/// Reads `last_emit_ms`, consults [`should_emit_snapshot`], and — if the emit
/// is allowed — stores `now_ms` back into `last_emit_ms` and returns `true`.
/// Otherwise leaves the cursor untouched and returns `false`.
///
/// # Ordering
///
/// Uses [`Ordering::Relaxed`] for both load and store. In a race between two
/// worker threads, both may observe a stale `last_emit_ms` and pass the gate
/// within the same window. That produces at most one extra emit per window —
/// acceptable and self-correcting on the next tick. We only need atomicity,
/// not synchronization with other memory.
///
/// # Arguments
/// * `last_emit_ms` — process-wide cursor holding the millisecond timestamp
///   of the most recent throttled emit. Must hold monotonic values.
/// * `now_ms` — current monotonic time in milliseconds. Must be `>=` any
///   value previously stored in `last_emit_ms`.
/// * `is_file_complete` — see [`should_emit_snapshot`].
/// * `min_interval_ms` — see [`should_emit_snapshot`].
pub fn try_claim_snapshot_emit(last_emit_ms: &AtomicU64, now_ms: u64, is_file_complete: bool, min_interval_ms: u64) -> bool {
    let last = last_emit_ms.load(Ordering::Relaxed);
    // First-ever call (cursor holds the [`NEVER_EMITTED`] sentinel): treat
    // elapsed as infinite so the very first progress tick always emits. This
    // matters at process startup, when `now_ms` is tiny and a zero-initialised
    // cursor would otherwise block the first tick by a full window.
    let elapsed = if last == NEVER_EMITTED { u64::MAX } else { now_ms.saturating_sub(last) };
    if should_emit_snapshot(elapsed, is_file_complete, min_interval_ms) {
        last_emit_ms.store(now_ms, Ordering::Relaxed);
        true
    } else {
        false
    }
}

/// Is this progress tick a file-completion tick?
///
/// Returns `true` when `bytes == total` and `total > 0`. The `total > 0`
/// guard is load-bearing: some backends emit a single `(0, 0, path)` tick
/// for empty files, and we do not want to treat those as completions.
///
/// This unifies the "file complete?" check used by two hot-path sites:
/// - [`crate::sync::progress::update_file_progress`] to bypass the snapshot
///   throttle so per-file completions reach the UI immediately, and
/// - `handle_transfer_progress` in `sync/drive/lifecycle.rs` to decide whether
///   to emit `FILE_TRANSFER_COMPLETE` and append to the activity log.
///
/// Keeping these two call sites in sync via a single pure function avoids
/// the class of bug where one path treats a tick as completion and the
/// other doesn't.
pub const fn is_file_completion_tick(bytes: u64, total: u64) -> bool {
    total > 0 && bytes == total
}

/// Decide whether the caller — whose emit was just suppressed by
/// [`try_claim_snapshot_emit`] — should schedule the single trailing flush
/// for the current throttle window.
///
/// The claim gate alone is leading-edge: the first tick in a window emits and
/// every later tick is *dropped*, not deferred. When the dropped tick is the
/// last one of a burst (typical for small files, whose only progress tick IS
/// their completion tick), the UI shows a stale snapshot until some unrelated
/// emit happens — possibly seconds later at cycle finalization. The trailing
/// flush closes that gap: exactly one suppressed caller per window wins this
/// gate and schedules a deferred forced emit, restoring the invariant that
/// every progress mutation is visible within one throttle window.
///
/// `flush_scheduled` must be cleared by the flush task right before it emits,
/// so a tick arriving after the flush can schedule the next one. `swap` makes
/// winner selection atomic under concurrent suppressed callers; `Relaxed`
/// suffices because (as with the emit cursor) a rare double-schedule costs
/// one extra emit and self-corrects.
pub fn should_schedule_flush(flush_scheduled: &AtomicBool) -> bool {
    !flush_scheduled.swap(true, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── should_emit_snapshot ────────────────────────────────────────────

    #[test]
    fn throttles_within_window() {
        // Only 100 ms elapsed, threshold is 250 ms, not a completion → block.
        assert!(!should_emit_snapshot(100, false, 250));
    }

    #[test]
    fn allows_exactly_at_window() {
        // elapsed == interval is the boundary; must allow to guarantee
        // progress under steady tick rates.
        assert!(should_emit_snapshot(250, false, 250));
    }

    #[test]
    fn allows_after_window() {
        assert!(should_emit_snapshot(1000, false, 250));
    }

    #[test]
    fn completion_uses_shorter_throttle() {
        // 0ms elapsed — within 100ms completion window → block
        assert!(!should_emit_snapshot(0, true, 250));
        // 50ms elapsed — still within window → block
        assert!(!should_emit_snapshot(50, true, 250));
        // 100ms elapsed — at boundary → allow
        assert!(should_emit_snapshot(100, true, 250));
        // 200ms elapsed — past window → allow
        assert!(should_emit_snapshot(200, true, 250));
    }

    #[test]
    fn zero_interval_disables_throttle() {
        // Escape hatch: setting min_interval_ms = 0 means "emit on every
        // non-completion tick". Completions still respect their own 100 ms
        // window.
        assert!(should_emit_snapshot(0, false, 0));
        // Completion at 0 ms elapsed is still within the 100 ms window.
        assert!(!should_emit_snapshot(0, true, 0));
        // Completion past the window emits normally.
        assert!(should_emit_snapshot(100, true, 0));
    }

    // ── should_schedule_flush ──────────────────────────────────────────

    #[test]
    fn first_suppressed_caller_wins_the_flush_slot() {
        let scheduled = AtomicBool::new(false);
        assert!(should_schedule_flush(&scheduled));
        // Slot is now taken until the flush task clears it.
        assert!(!should_schedule_flush(&scheduled));
        assert!(!should_schedule_flush(&scheduled));
    }

    #[test]
    fn flush_slot_reopens_after_clear() {
        let scheduled = AtomicBool::new(false);
        assert!(should_schedule_flush(&scheduled));
        // The flush task clears the flag just before emitting…
        scheduled.store(false, Ordering::Relaxed);
        // …so the next suppressed tick can schedule the next window's flush.
        assert!(should_schedule_flush(&scheduled));
    }

    // ── is_file_completion_tick ────────────────────────────────────────

    #[test]
    fn completion_tick_when_bytes_equal_total() {
        assert!(is_file_completion_tick(100, 100));
        assert!(is_file_completion_tick(1, 1));
        assert!(is_file_completion_tick(u64::MAX, u64::MAX));
    }

    #[test]
    fn partial_tick_is_not_completion() {
        assert!(!is_file_completion_tick(0, 100));
        assert!(!is_file_completion_tick(50, 100));
        assert!(!is_file_completion_tick(99, 100));
    }

    #[test]
    fn zero_total_never_completes() {
        // Empty-file ticks (0/0) and pre-init ticks must not be classified
        // as completions, otherwise `FILE_TRANSFER_COMPLETE` would fire for
        // files that were never actually transferred.
        assert!(!is_file_completion_tick(0, 0));
    }

    #[test]
    fn bytes_exceeding_total_not_treated_as_completion() {
        // Defensive: if a backend over-reports bytes past total (bug-class
        // we've seen in other chunked transfer systems), we don't want a
        // stale completion event. Exact equality is required.
        assert!(!is_file_completion_tick(101, 100));
    }

    // ── try_claim_snapshot_emit ────────────────────────────────────────

    #[test]
    fn first_call_always_claims() {
        let cursor = AtomicU64::new(0);
        assert!(try_claim_snapshot_emit(&cursor, 1_000, false, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 1_000);
    }

    #[test]
    fn sentinel_cursor_claims_even_at_zero_now() {
        // Production cursor is initialised to NEVER_EMITTED. The very first
        // progress tick can arrive while `monotonic_now_ms()` is still 0 if
        // sync starts that early, and it MUST emit. A naive elapsed check
        // would silently block the first emit for a full window.
        let cursor = AtomicU64::new(NEVER_EMITTED);
        assert!(try_claim_snapshot_emit(&cursor, 0, false, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 0);
        // Subsequent in-window ticks are throttled as expected.
        assert!(!try_claim_snapshot_emit(&cursor, 100, false, 250));
    }

    #[test]
    fn burst_within_window_collapses_to_single_emit() {
        // Simulates the hot path: many workers hammering the gate with
        // now_ms values inside a 250 ms window. Only the first should claim.
        let cursor = AtomicU64::new(0);
        let base = 10_000;
        // First call at t=10_000 establishes the cursor.
        assert!(try_claim_snapshot_emit(&cursor, base, false, 250));
        // Next 100 calls spread across the next 249 ms all see the claim.
        let mut claimed = 0_usize;
        for offset in 1..=100 {
            // Spread across 0..249 ms after base.
            let now = base + (offset * 249) / 100;
            if try_claim_snapshot_emit(&cursor, now, false, 250) {
                claimed += 1;
            }
        }
        assert_eq!(claimed, 0, "no secondary claim allowed inside the 250 ms window");
    }

    #[test]
    fn second_window_reopens_the_gate() {
        let cursor = AtomicU64::new(0);
        assert!(try_claim_snapshot_emit(&cursor, 10_000, false, 250));
        assert!(!try_claim_snapshot_emit(&cursor, 10_100, false, 250));
        assert!(!try_claim_snapshot_emit(&cursor, 10_249, false, 250));
        // At exactly 250 ms past the stored cursor, the window has elapsed.
        assert!(try_claim_snapshot_emit(&cursor, 10_250, false, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 10_250);
    }

    #[test]
    fn completion_uses_100ms_window_inside_normal_throttle() {
        // Completions use COMPLETION_THROTTLE_MS (100 ms), not the normal
        // 250 ms window. A completion within 100 ms of the last emit is
        // batched; one at or past 100 ms emits.
        let cursor = AtomicU64::new(5_000);
        // 50 ms after cursor — within 100 ms completion window → blocked.
        assert!(!try_claim_snapshot_emit(&cursor, 5_050, true, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 5_000);
        // Non-completion also blocked (within 250 ms window).
        assert!(!try_claim_snapshot_emit(&cursor, 5_060, false, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 5_000);
        // Completion at exactly 100 ms → emits.
        assert!(try_claim_snapshot_emit(&cursor, 5_100, true, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 5_100);
        // Another completion 50 ms later → within window again → blocked.
        assert!(!try_claim_snapshot_emit(&cursor, 5_150, true, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 5_100);
        // Completion 100 ms after last emit → emits.
        assert!(try_claim_snapshot_emit(&cursor, 5_200, true, 250));
        assert_eq!(cursor.load(Ordering::Relaxed), 5_200);
    }

    #[test]
    fn saturating_elapsed_handles_equal_cursor() {
        // now_ms == last_emit_ms → elapsed = 0 → block (non-completion).
        let cursor = AtomicU64::new(12_345);
        assert!(!try_claim_snapshot_emit(&cursor, 12_345, false, 250));
    }

    #[test]
    fn simulates_hot_path_reduction() {
        // Regression guard for the 2026-04-05 hang report. Simulates 2000
        // per-byte progress ticks arriving over 1 full second (2 kHz tick
        // rate — comparable to what hcfs-client produced during the hang).
        // With a 250 ms window we must emit at most ~5 times over 1 second
        // (t=0, t=250, t=500, t=750, t=1000 = 5 slots). Seeded with the
        // production sentinel so the t=0 tick claims as it would in the real
        // app.
        let cursor = AtomicU64::new(NEVER_EMITTED);
        let mut emitted = 0_usize;
        for i in 0..=2_000 {
            // Tick at millisecond i/2 (half-ms granularity rounded down).
            let now_ms = i / 2;
            if try_claim_snapshot_emit(&cursor, now_ms, false, 250) {
                emitted += 1;
            }
        }
        // 5 slots available over [0, 1000]: at 0, 250, 500, 750, 1000.
        assert_eq!(
            emitted, 5,
            "expected exactly 5 throttled emits over 1 s at 2 kHz tick rate; got {emitted}"
        );
    }

    #[test]
    fn reduces_emits_by_two_orders_of_magnitude_under_hang_workload() {
        // Strong regression guard tied directly to the bug report. The hang
        // report shows the webview main thread falling behind when tokio
        // workers call `update_file_progress` at very high rates. Under a
        // pessimistic 10 kHz tick rate sustained for 5 seconds (50 000
        // calls), the throttle must reduce emits to at most ~21 (one per
        // 250 ms window over 5 s, plus the initial claim). This is a >2000x
        // reduction in work pushed at webview.eval(), which is what resolves
        // the hang.
        let cursor = AtomicU64::new(NEVER_EMITTED);
        let mut emitted = 0_usize;
        for i in 0..50_000 {
            // 10 kHz ticks → 10 calls per millisecond → i / 10 is ms.
            let now_ms = i / 10;
            if try_claim_snapshot_emit(&cursor, now_ms, false, 250) {
                emitted += 1;
            }
        }
        assert!(
            emitted <= 21,
            "expected ≤21 emits from 50k calls over 5 s at 10 kHz; got {emitted} — throttle not working"
        );
        assert!(
            emitted >= 20,
            "expected ≥20 emits from 50k calls over 5 s at 10 kHz; got {emitted} — throttle too aggressive"
        );
    }
}
