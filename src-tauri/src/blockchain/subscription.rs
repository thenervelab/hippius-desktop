//! Background block subscription.
//!
//! Subscribes to finalized blocks via subxt and emits `block_number_updated`
//! events to the frontend. Auto-reconnects on connection loss.

use crate::blockchain::client::get_substrate_client;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::Emitter;
use tracing::{info, warn};

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
                        .saturating_mul(
                            2u64.saturating_pow(consecutive_failures.saturating_sub(1).min(4)),
                        )
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
                    // Clear the substrate client so it reconnects
                    crate::blockchain::client::clear_substrate_client(&app_state);
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

        let _ = app.emit(
            "block_number_updated",
            BlockUpdate {
                block_number: number,
                is_connected: true,
            },
        );
    }

    Ok(())
}

/// Stop the block subscription.
#[tauri::command]
pub async fn stop_block_subscription(app: tauri::AppHandle) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let bsub = &app_state.block_sub;

    bsub.running.store(false, Ordering::SeqCst);
    if let Some(handle) = bsub.handle.lock().await.take() {
        handle.abort();
    }
    bsub.is_connected.store(false, Ordering::SeqCst);
}

/// Get the latest cached block number (0 if not yet subscribed).
#[tauri::command]
pub fn get_current_block_number(state: tauri::State<'_, crate::app_state::AppState>) -> BlockUpdate {
    let bsub = &state.block_sub;
    BlockUpdate {
        block_number: bsub.latest_block.load(Ordering::SeqCst),
        is_connected: bsub.is_connected.load(Ordering::SeqCst),
    }
}
