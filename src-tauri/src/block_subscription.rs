//! Background block subscription.
//!
//! Subscribes to finalized blocks via subxt and emits `block_number_updated`
//! events to the frontend. Auto-reconnects on connection loss.

use crate::substrate_client::get_substrate_client;
use futures::StreamExt;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Emitter;
use tokio::sync::Mutex;
use tracing::{info, warn};

static BLOCK_SUB_RUNNING: AtomicBool = AtomicBool::new(false);
static LATEST_BLOCK: AtomicU64 = AtomicU64::new(0);
static IS_CONNECTED: AtomicBool = AtomicBool::new(false);

static BLOCK_SUB_HANDLE: Mutex<Option<tokio::task::JoinHandle<()>>> =
    Mutex::const_new(None);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlockUpdate {
    pub block_number: u64,
    pub is_connected: bool,
}

/// Start the background block subscription. Idempotent — does nothing if already running.
#[tauri::command]
pub async fn start_block_subscription(app: tauri::AppHandle) -> Result<(), String> {
    if BLOCK_SUB_RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }

    // Abort previous task if any
    if let Some(handle) = BLOCK_SUB_HANDLE.lock().await.take() {
        handle.abort();
    }

    BLOCK_SUB_RUNNING.store(true, Ordering::SeqCst);

    let handle = tokio::spawn(async move {
        loop {
            if !BLOCK_SUB_RUNNING.load(Ordering::SeqCst) {
                break;
            }

            match subscribe_blocks(&app).await {
                Ok(()) => break,
                Err(e) => {
                    warn!("Block subscription error: {e}, reconnecting in 5s...");
                    IS_CONNECTED.store(false, Ordering::SeqCst);
                    let _ = app.emit(
                        "block_number_updated",
                        BlockUpdate {
                            block_number: LATEST_BLOCK.load(Ordering::SeqCst),
                            is_connected: false,
                        },
                    );
                    // Clear the substrate client so it reconnects
                    crate::substrate_client::clear_substrate_client();
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
        BLOCK_SUB_RUNNING.store(false, Ordering::SeqCst);
        IS_CONNECTED.store(false, Ordering::SeqCst);
    });

    *BLOCK_SUB_HANDLE.lock().await = Some(handle);
    Ok(())
}

async fn subscribe_blocks(app: &tauri::AppHandle) -> Result<(), String> {
    let client = get_substrate_client().await?;
    IS_CONNECTED.store(true, Ordering::SeqCst);

    let mut blocks = client
        .blocks()
        .subscribe_finalized()
        .await
        .map_err(|e| format!("Block subscription failed: {e}"))?;

    info!("Subscribed to finalized blocks");

    while let Some(result) = blocks.next().await {
        if !BLOCK_SUB_RUNNING.load(Ordering::SeqCst) {
            break;
        }

        let block = result.map_err(|e| format!("Block error: {e}"))?;
        let number = block.number() as u64;
        LATEST_BLOCK.store(number, Ordering::SeqCst);

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
pub async fn stop_block_subscription() {
    BLOCK_SUB_RUNNING.store(false, Ordering::SeqCst);
    if let Some(handle) = BLOCK_SUB_HANDLE.lock().await.take() {
        handle.abort();
    }
    IS_CONNECTED.store(false, Ordering::SeqCst);
}

/// Get the latest cached block number (0 if not yet subscribed).
#[tauri::command]
pub fn get_current_block_number() -> BlockUpdate {
    BlockUpdate {
        block_number: LATEST_BLOCK.load(Ordering::SeqCst),
        is_connected: IS_CONNECTED.load(Ordering::SeqCst),
    }
}
