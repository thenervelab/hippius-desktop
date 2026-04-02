//! Substrate/Polkadot RPC client with auto-retry.
//!
//! Maintains a cached `OnlineClient<PolkadotConfig>` behind the `RwLock`
//! in `AppState.blockchain.client`. On first use (or after
//! `clear_substrate_client()`), connects to the WSS endpoint from the
//! database with up to 10 retries using exponential backoff.

use crate::constants::substrate::WSS_ENDPOINT;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use subxt::{OnlineClient, PolkadotConfig};
use tokio::time::sleep;
use tracing::{info, warn};

const MAX_RETRIES: usize = 10;

/// Get or create the shared Substrate RPC client from `AppState.blockchain.client`.
pub async fn get_substrate_client(app_state: &crate::app_state::AppState) -> Result<Arc<OnlineClient<PolkadotConfig>>, String> {
    let lock = &app_state.blockchain.client;

    // Check if we have an existing client
    let existing_client = {
        let client = lock.read().map_err(|e| format!("Substrate client lock failed: {e}"))?;
        client.clone()
    };

    if let Some(client) = existing_client {
        return Ok(client);
    }

    let pool = app_state.pool().map_err(|e| e.to_string())?;

    // Get the current WSS endpoint from database, fallback to default constant
    let wss_endpoint = get_current_wss_endpoint(pool).await.unwrap_or_else(|_| WSS_ENDPOINT.to_string());

    let mut attempt = 0;
    loop {
        attempt += 1;
        match OnlineClient::<PolkadotConfig>::from_url(&wss_endpoint).await {
            Ok(client) => {
                let arc = Arc::new(client);
                let mut client_lock = lock.write().map_err(|e| format!("Substrate client lock failed: {e}"))?;
                *client_lock = Some(arc.clone());
                info!(
                    attempt,
                    endpoint = %wss_endpoint,
                    "Connected to Substrate node"
                );
                return Ok(arc);
            }
            Err(e) => {
                warn!(
                    attempt,
                    endpoint = %wss_endpoint,
                    error = %e,
                    "Failed to connect to Substrate node"
                );
                if attempt >= MAX_RETRIES {
                    return Err(format!("Failed to connect to Substrate node after {MAX_RETRIES} attempts: {e}"));
                }
                // Exponential backoff: 2^min(attempt,5) seconds + random jitter (0-1s)
                let base_delay = 2u64.pow(attempt.min(5) as u32);
                let jitter_ms = rand::random::<u64>() % 1000;
                let delay = Duration::from_millis(base_delay * 1000 + jitter_ms);
                sleep(delay).await;
            }
        }
    }
}

/// Clear the cached Substrate client so the next call to `get_substrate_client`
/// will reconnect.
pub fn clear_substrate_client(app_state: &crate::app_state::AppState) {
    if let Ok(mut client) = app_state.blockchain.client.write() {
        *client = None;
        info!("Cleared substrate client");
    } else {
        warn!("Failed to acquire write lock to clear substrate client");
    }
}

/// Get the current WSS endpoint from database.
pub async fn get_current_wss_endpoint(pool: &SqlitePool) -> Result<String, String> {
    let row = sqlx::query("SELECT endpoint FROM wss_endpoint WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to query WSS endpoint: {e}"))?;

    match row {
        Some(row) => {
            let endpoint: String = row.get("endpoint");
            Ok(endpoint)
        }
        None => Err("No WSS endpoint found in database".to_string()),
    }
}

/// Update the WSS endpoint in database and clear the current client.
pub async fn update_wss_endpoint(app_state: &crate::app_state::AppState, new_endpoint: String) -> Result<(), String> {
    // Validate the endpoint format (basic check)
    if !new_endpoint.starts_with("ws://") && !new_endpoint.starts_with("wss://") {
        return Err("Invalid WSS endpoint format. Must start with ws:// or wss://".to_string());
    }

    let pool = app_state.pool().map_err(|e| e.to_string())?;

    // Update or insert the endpoint
    let result = sqlx::query("INSERT OR REPLACE INTO wss_endpoint (id, endpoint, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)")
        .bind(&new_endpoint)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update WSS endpoint: {e}"))?;

    if result.rows_affected() > 0 {
        // Clear the current client so it will reconnect with new endpoint
        clear_substrate_client(app_state);
        info!("WSS endpoint updated to: {}", new_endpoint);
        Ok(())
    } else {
        Err("Failed to update WSS endpoint".to_string())
    }
}
