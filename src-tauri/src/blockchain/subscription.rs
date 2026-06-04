//! Background block subscription.
//!
//! Subscribes to finalized blocks via subxt and emits `block_number_updated`
//! events to the frontend. Auto-reconnects on connection loss.

use crate::blockchain::client::get_substrate_client;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;
use tracing::{info, warn};

/// Minimum milliseconds between throttled `block_number_updated` emits.
///
/// Finalized blocks normally arrive every ~6s on Hippius, so this throttle
/// is a no-op in steady state. It only kicks in during catch-up bursts
/// (e.g. just after reconnect, when several finalized blocks land in quick
/// succession) where the FE would otherwise see a flood of identical-shape
/// events firing TanStack invalidations on every tick.
///
/// **Trailing-edge flush guarantee**: the gate is leading-edge with a
/// trailing flush. The first block in a burst emits immediately; subsequent
/// blocks update `latest_block` but skip the immediate emit. Each
/// throttled block schedules (at most one) deferred task that wakes when
/// the throttle window closes and emits the most-recent `latest_block`.
/// The FE therefore catches up to the burst's final block within
/// `BLOCK_EMIT_THROTTLE_MS` rather than waiting for the next steady-state
/// block 6s later.
///
/// Connection-state changes bypass the throttle — `is_connected` flips
/// must reach the FE immediately so the connectivity indicator is honest.
const BLOCK_EMIT_THROTTLE_MS: u64 = 1000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlockUpdate {
    pub block_number: u64,
    pub is_connected: bool,
}

/// Start the background block subscription. Idempotent — does nothing if already running.
#[tauri::command]
pub async fn start_block_subscription(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let bsub = &app_state.block_sub;

    // Atomic claim: exactly one caller flips false→true and proceeds; a
    // concurrent caller loses the compare_exchange and returns. The previous
    // load-then-store had a gap spanning the `.await` on `handle.lock()`, so
    // two overlapping invocations could both pass the running check and both
    // spawn a subscription task — the second's JoinHandle overwrote the first
    // at the store below, leaking the first task (never aborted) and doubling
    // per-block processing for the rest of the process lifetime.
    if bsub.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Ok(());
    }

    // Abort a leftover handle from a prior run that already reset `running`.
    // Only the CAS winner reaches here, so this runs at most once.
    if let Some(handle) = bsub.handle.lock().await.take() {
        handle.abort();
    }

    // Clone the handle so `app` can be moved into the spawned task while we
    // keep a reference for storing the JoinHandle afterwards.
    let app_for_spawn = app.clone();

    let handle = tokio::spawn(async move {
        let app = app_for_spawn;
        let mut consecutive_failures: u32 = 0;
        loop {
            // Re-acquire state each iteration (app_state borrows are scoped)
            {
                let app_state = app.state::<crate::app_state::AppState>();
                if !app_state.block_sub.running.load(Ordering::SeqCst) {
                    break;
                }
            }

            match subscribe_blocks(&app).await {
                Ok(()) => break,
                Err(e) => {
                    consecutive_failures += 1;
                    // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
                    let delay_secs = 5u64
                        .saturating_mul(2u64.saturating_pow(consecutive_failures.saturating_sub(1).min(4)))
                        .min(60);
                    let is_rate_limited = e.contains("429");
                    let delay_secs = if is_rate_limited { delay_secs.max(30) } else { delay_secs };

                    warn!(
                        error = %e,
                        delay_secs,
                        consecutive_failures,
                        rate_limited = is_rate_limited,
                        "Block subscription error, reconnecting after backoff"
                    );
                    let app_state = app.state::<crate::app_state::AppState>();
                    let bsub = &app_state.block_sub;
                    bsub.is_connected.store(false, Ordering::SeqCst);
                    let _ = app.emit(
                        "block_number_updated",
                        BlockUpdate {
                            block_number: bsub.latest_block.load(Ordering::SeqCst),
                            is_connected: false,
                        },
                    );
                    // Only clear the cached client on real disconnections.
                    // On 429 the endpoint is reachable but rejecting us —
                    // clearing the client would trigger a fresh connect_and_cache
                    // retry loop that hammers the endpoint even harder.
                    if !is_rate_limited {
                        crate::blockchain::client::clear_substrate_client(&app_state);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
                }
            }
        }
        let app_state = app.state::<crate::app_state::AppState>();
        let bsub = &app_state.block_sub;
        bsub.running.store(false, Ordering::SeqCst);
        bsub.is_connected.store(false, Ordering::SeqCst);
    });

    *app_state.block_sub.handle.lock().await = Some(handle);
    Ok(())
}

/// Stop the background block subscription. Idempotent.
///
/// Sets `running = false` so the reconnect loop won't restart, then aborts the
/// in-flight task so it stops immediately instead of waiting out a backoff
/// sleep (up to 60s) or the next finalized block. Without this the task
/// outlived logout: it kept reconnecting and emitting `block_number_updated`
/// against a stale session, and a subsequent login's `start_block_subscription`
/// CAS could observe `running == true` and refuse to start a fresh one.
pub(crate) async fn stop_block_subscription_inner(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let bsub = &app_state.block_sub;
    bsub.running.store(false, Ordering::SeqCst);
    if let Some(handle) = bsub.handle.lock().await.take() {
        handle.abort();
    }
    bsub.is_connected.store(false, Ordering::SeqCst);
    info!("Block subscription stopped");
}

/// Stop the background block subscription (IPC wrapper). Idempotent.
#[tauri::command]
pub async fn stop_block_subscription(app: tauri::AppHandle) -> Result<(), String> {
    stop_block_subscription_inner(&app).await;
    Ok(())
}

async fn subscribe_blocks(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let client = get_substrate_client(&app_state).await?;
    app_state.block_sub.is_connected.store(true, Ordering::SeqCst);

    let mut blocks = client
        .blocks()
        .subscribe_finalized()
        .await
        .map_err(|e| format!("Block subscription failed: {e}"))?;

    info!("Subscribed to finalized blocks");

    while let Some(result) = blocks.next().await {
        let app_state = app.state::<crate::app_state::AppState>();
        if !app_state.block_sub.running.load(Ordering::SeqCst) {
            break;
        }

        let block = result.map_err(|e| format!("Block error: {e}"))?;
        let number = block.number() as u64;
        app_state.block_sub.latest_block.store(number, Ordering::SeqCst);

        if try_claim_block_emit(&app_state.block_sub.last_emit_ms, monotonic_now_ms(), BLOCK_EMIT_THROTTLE_MS) {
            // Window open — emit immediately.
            let _ = app.emit(
                "block_number_updated",
                BlockUpdate {
                    block_number: number,
                    is_connected: true,
                },
            );
        } else {
            // Window closed — schedule a single trailing-edge flush so the
            // most-recent block reaches the FE when the window opens.
            // Without this, a burst of N blocks landing inside the throttle
            // window would leave the FE on the FIRST block until the next
            // steady-state block ~6s later (visible after a reconnect
            // catch-up of dozens of blocks).
            schedule_trailing_block_emit(app.clone());
        }
    }

    // The `while let Some(..)` above exits for one of two reasons: an
    // intentional stop (the in-loop `break` after observing `running == false`)
    // or the stream yielding `None`. A `None` is a graceful server-side
    // WebSocket close (idle timeout, load-balancer recycle, proxy drop) that
    // subxt's non-reconnecting legacy backend does NOT resubscribe. Re-read
    // `running` and let `classify_stream_exit` decide whether this exit is a
    // clean shutdown (Ok) or a disconnect the caller must reconnect (Err).
    let running = app.state::<crate::app_state::AppState>().block_sub.running.load(Ordering::SeqCst);
    classify_stream_exit(running)
}

/// Decide whether a finalized-block stream exit is an intentional shutdown
/// or a reconnectable disconnect.
///
/// `running == false` means [`start_block_subscription`] cleared the flag to
/// stop the task — that is a clean `Ok(())` and the reconnect loop exits. A
/// stream that ends while `running` is still `true` ended on its own (a
/// graceful WebSocket `None`); returning `Err` routes it through the caller's
/// backoff-and-reconnect arm, which also emits `is_connected = false` so the
/// FE connectivity indicator stays honest.
fn classify_stream_exit(running: bool) -> Result<(), String> {
    if running {
        Err("block stream ended unexpectedly (graceful disconnect)".to_string())
    } else {
        Ok(())
    }
}

/// Spawn a one-shot deferred task that emits `latest_block` when the
/// throttle window closes. At most one task runs at a time — `swap` on
/// `deferred_emit_in_flight` returns the previous value, and we early-out
/// if another task has already claimed the slot.
///
/// The task reads the current `last_emit_ms` and `latest_block` at wake
/// time, so it always flushes the freshest block — even if more blocks
/// arrived after this task was scheduled. After the emit it resets
/// `deferred_emit_in_flight` so a later burst can schedule another flush.
fn schedule_trailing_block_emit(app: tauri::AppHandle) {
    use tauri::Manager;
    let app_state_check = app.state::<crate::app_state::AppState>();
    if app_state_check.block_sub.deferred_emit_in_flight.swap(true, Ordering::AcqRel) {
        // Another deferred task is already pending; it will pick up the
        // latest block when it wakes.
        return;
    }
    // `app_state_check` borrows `app`; NLL ends that borrow at its last use
    // (the `swap` above), so `app` moves freely into the spawn below — no
    // explicit drop needed (`tauri::State` is a reference wrapper, not `Drop`).

    tokio::spawn(async move {
        // Sleep until the throttle window has had a chance to close. We
        // use the full window length rather than computing remaining time
        // because a burst typically spans <1ms — sleeping a bit longer is
        // fine and keeps the math simple.
        tokio::time::sleep(std::time::Duration::from_millis(BLOCK_EMIT_THROTTLE_MS)).await;

        let app_state = app.state::<crate::app_state::AppState>();
        // If the subscription has shut down while we slept, just clear
        // the in-flight flag and exit quietly.
        if !app_state.block_sub.running.load(Ordering::SeqCst) {
            app_state.block_sub.deferred_emit_in_flight.store(false, Ordering::Release);
            return;
        }

        let latest = app_state.block_sub.latest_block.load(Ordering::Acquire);
        let is_connected = app_state.block_sub.is_connected.load(Ordering::Acquire);
        // Mark this as the new last-emit-time so the next tick within the
        // window is throttled cleanly.
        app_state.block_sub.last_emit_ms.store(monotonic_now_ms(), Ordering::Release);
        let _ = app.emit(
            "block_number_updated",
            BlockUpdate {
                block_number: latest,
                is_connected,
            },
        );
        app_state.block_sub.deferred_emit_in_flight.store(false, Ordering::Release);
    });
}

/// Pure helper: claim the right to emit if at least `min_interval_ms` ms
/// have elapsed since the last successful emit.
///
/// Uses `compare_exchange` so concurrent callers race for the slot — at most
/// one wins per interval. Returns `true` if this caller should emit. If the
/// stored timestamp is `0` (never emitted), this caller always wins.
fn try_claim_block_emit(last_emit_ms: &AtomicU64, now_ms: u64, min_interval_ms: u64) -> bool {
    loop {
        let prev = last_emit_ms.load(Ordering::Acquire);
        if prev != 0 && now_ms.saturating_sub(prev) < min_interval_ms {
            return false;
        }
        if last_emit_ms.compare_exchange(prev, now_ms, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            return true;
        }
        // Lost the race — re-read and re-evaluate.
    }
}

/// Monotonic milliseconds since process start. Same source the sync engine
/// uses for its snapshot throttle (`sync::progress::monotonic_now_ms`); we
/// duplicate the helper here so the blockchain crate doesn't depend on
/// `sync`. Process start is `Instant::elapsed()`'s zero, monotonic across
/// any wall-clock manipulation.
fn monotonic_now_ms() -> u64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    let epoch = EPOCH.get_or_init(Instant::now);
    u64::try_from(epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_emit_always_succeeds_against_zero_baseline() {
        let last = AtomicU64::new(0);
        assert!(try_claim_block_emit(&last, 100, 1000));
        assert_eq!(last.load(Ordering::Acquire), 100);
    }

    #[test]
    fn emit_throttled_within_interval() {
        let last = AtomicU64::new(100);
        // 500 ms after baseline, still inside the 1000 ms throttle window.
        assert!(!try_claim_block_emit(&last, 600, 1000));
        // Storage unchanged.
        assert_eq!(last.load(Ordering::Acquire), 100);
    }

    #[test]
    fn emit_allowed_after_interval() {
        let last = AtomicU64::new(100);
        assert!(try_claim_block_emit(&last, 1100, 1000));
        assert_eq!(last.load(Ordering::Acquire), 1100);
    }

    #[test]
    fn graceful_stream_end_while_running_is_reconnectable_error() {
        // A `None` from the block stream while the task is still meant to be
        // running is a graceful disconnect — it must surface as Err so the
        // caller reconnects instead of treating it as a clean shutdown.
        assert!(
            classify_stream_exit(true).is_err(),
            "stream ending while running=true must be a reconnectable error"
        );
    }

    #[test]
    fn intentional_stop_is_clean_exit() {
        // The in-loop break clears nothing; `running == false` means the user
        // (logout/stop) asked the task to end. That is a clean Ok, not a
        // reconnect.
        assert!(
            classify_stream_exit(false).is_ok(),
            "stream ending after running=false must be a clean shutdown"
        );
    }

    #[test]
    fn six_rapid_emits_throttle_to_two_within_one_second() {
        // Real callers see `monotonic_now_ms()` which is process-start
        // elapsed and always non-zero. Use realistic timestamps starting
        // at 100 ms so the helper's "prev == 0 means never-emitted"
        // sentinel doesn't fire on subsequent attempts.
        let last = AtomicU64::new(0);
        let attempts = [100, 200, 300, 400, 500, 600];
        let wins = attempts.iter().filter(|&&ts| try_claim_block_emit(&last, ts, 1000)).count();
        // Only the first attempt wins; the next five fall inside the
        // 1000 ms throttle window after ts=100.
        assert_eq!(wins, 1, "expected exactly one win in a 500 ms burst against a 1000 ms gate");
        // After the throttle window closes, the next attempt wins (ts=1101 - 100 = 1001 ms ≥ 1000).
        assert!(try_claim_block_emit(&last, 1101, 1000));
    }
}
