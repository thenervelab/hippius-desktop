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

    if bsub.running.load(Ordering::SeqCst) {
        return Ok(());
    }

    // Abort previous task if any
    if let Some(handle) = bsub.handle.lock().await.take() {
        handle.abort();
    }

    bsub.running.store(true, Ordering::SeqCst);

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

    Ok(())
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
    drop(app_state_check);

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
        if last_emit_ms
            .compare_exchange(prev, now_ms, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
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
    fn six_rapid_emits_throttle_to_two_within_one_second() {
        // Real callers see `monotonic_now_ms()` which is process-start
        // elapsed and always non-zero. Use realistic timestamps starting
        // at 100 ms so the helper's "prev == 0 means never-emitted"
        // sentinel doesn't fire on subsequent attempts.
        let last = AtomicU64::new(0);
        let attempts = [100, 200, 300, 400, 500, 600];
        let wins = attempts
            .iter()
            .filter(|&&ts| try_claim_block_emit(&last, ts, 1000))
            .count();
        // Only the first attempt wins; the next five fall inside the
        // 1000 ms throttle window after ts=100.
        assert_eq!(wins, 1, "expected exactly one win in a 500 ms burst against a 1000 ms gate");
        // After the throttle window closes, the next attempt wins (ts=1101 - 100 = 1001 ms ≥ 1000).
        assert!(try_claim_block_emit(&last, 1101, 1000));
    }
}
