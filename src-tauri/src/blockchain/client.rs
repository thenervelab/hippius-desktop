//! Substrate/Polkadot RPC client with auto-retry.
//!
//! Maintains a cached `OnlineClient<PolkadotConfig>` behind the `RwLock`
//! in `AppState.blockchain.client`. On first use (or after
//! `clear_substrate_client()`), connects to the WSS endpoint from the
//! database with up to 10 retries using exponential backoff.

use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use subxt::backend::rpc::RpcClient;
use subxt::{OnlineClient, PolkadotConfig};
use tokio::time::sleep;
use tracing::{info, warn};

/// Default WebSocket endpoint for the Hippius parachain RPC node.
///
/// Used as the fallback when no custom endpoint is stored in the database.
/// Users can override this via the settings UI, which persists the new
/// endpoint in the `wss_endpoint` table.
pub const WSS_ENDPOINT: &str = "wss://rpc.hippius.network";

const MAX_RETRIES: usize = 10;
/// Fewer retries for 429 — the endpoint is actively rejecting us,
/// so hammering it with 10 attempts over 5+ minutes is wasteful.
const MAX_RETRIES_RATE_LIMITED: usize = 3;

/// Get or create the shared Substrate RPC client from `AppState.blockchain.client`.
///
/// Uses `connect_guard` to serialize connection attempts — only one task
/// connects at a time; concurrent callers wait and reuse the result.
pub async fn get_substrate_client(app_state: &crate::app_state::AppState) -> Result<Arc<OnlineClient<PolkadotConfig>>, String> {
    // Fast path: return cached client without acquiring the connection guard.
    if let Some(client) = read_cached_client(app_state)? {
        return Ok(client);
    }

    // Slow path: acquire the connection guard so only one task retries.
    let _guard = app_state.blockchain.connect_guard.lock().await;

    // Re-check: another task may have connected while we waited.
    if let Some(client) = read_cached_client(app_state)? {
        return Ok(client);
    }

    connect_and_cache(app_state).await
}

/// Read the cached client without modifying state.
fn read_cached_client(app_state: &crate::app_state::AppState) -> Result<Option<Arc<OnlineClient<PolkadotConfig>>>, String> {
    let client = app_state
        .blockchain
        .client
        .read()
        .map_err(|e| format!("Substrate client lock failed: {e}"))?;
    Ok(client.clone())
}

/// Returns `true` when the error string indicates HTTP 429 rate-limiting.
fn is_rate_limited(error: &str) -> bool {
    error.contains("429")
}

/// Compute retry delay with exponential backoff and jitter.
/// Rate-limited (429) errors use a 30s minimum to let the limit window reset.
fn retry_delay(attempt: usize, rate_limited: bool) -> Duration {
    // Normal: 2s, 4s, 8s, 16s, 32s (capped)
    let base_secs = 2u64.pow(attempt.min(5) as u32);
    // 429: floor at 30s so we don't hammer a rate-limited endpoint
    let base_secs = if rate_limited { base_secs.max(30) } else { base_secs };
    let jitter_ms = rand::random::<u64>() % 1000;
    Duration::from_millis(base_secs * 1000 + jitter_ms)
}

/// Connect to the RPC endpoint and cache the client.
/// Called while holding `connect_guard` — no other task is connecting.
async fn connect_and_cache(app_state: &crate::app_state::AppState) -> Result<Arc<OnlineClient<PolkadotConfig>>, String> {
    let pool = app_state.pool().map_err(|e| e.to_string())?;
    let wss_endpoint = get_current_wss_endpoint(pool).await.unwrap_or_else(|_| WSS_ENDPOINT.to_string());

    let mut attempt = 0;
    loop {
        attempt += 1;
        match RpcClient::from_url(&wss_endpoint).await {
            Ok(rpc) => match OnlineClient::<PolkadotConfig>::from_rpc_client(rpc.clone()).await {
                Ok(client) => {
                    let arc = Arc::new(client);
                    let mut client_lock = app_state
                        .blockchain
                        .client
                        .write()
                        .map_err(|e| format!("Substrate client lock failed: {e}"))?;
                    *client_lock = Some(arc.clone());

                    if let Ok(mut rpc_lock) = app_state.blockchain.rpc_client.write() {
                        *rpc_lock = Some(rpc);
                    } else {
                        warn!("Failed to acquire write lock to cache RPC client");
                    }

                    info!(
                        attempt,
                        endpoint = %wss_endpoint,
                        "Connected to Substrate node"
                    );
                    return Ok(arc);
                }
                Err(e) => {
                    let err_str = e.to_string();
                    let rate_limited = is_rate_limited(&err_str);
                    let max = if rate_limited { MAX_RETRIES_RATE_LIMITED } else { MAX_RETRIES };
                    warn!(
                        attempt,
                        max_retries = max,
                        endpoint = %wss_endpoint,
                        error = %err_str,
                        rate_limited,
                        "Failed to build OnlineClient from RPC"
                    );
                    if attempt >= max {
                        return Err(format!("Failed to connect to Substrate node after {max} attempts: {err_str}"));
                    }
                    sleep(retry_delay(attempt, rate_limited)).await;
                }
            },
            Err(e) => {
                let err_str = e.to_string();
                let rate_limited = is_rate_limited(&err_str);
                let max = if rate_limited { MAX_RETRIES_RATE_LIMITED } else { MAX_RETRIES };
                warn!(
                    attempt,
                    max_retries = max,
                    endpoint = %wss_endpoint,
                    error = %err_str,
                    rate_limited,
                    "Failed to connect to Substrate node"
                );
                if attempt >= max {
                    return Err(format!("Failed to connect to Substrate node after {max} attempts: {err_str}"));
                }
                sleep(retry_delay(attempt, rate_limited)).await;
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
    if let Ok(mut rpc) = app_state.blockchain.rpc_client.write() {
        *rpc = None;
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

/// Test if an RPC endpoint is reachable by attempting a WebSocket connection.
///
/// Replaces the raw WebSocket test in `CustomizeRPC.tsx`.
/// Returns Ok(()) on success, Err with message on failure.
pub async fn test_rpc_endpoint(endpoint: &str) -> Result<(), String> {
    if !endpoint.starts_with("ws://") && !endpoint.starts_with("wss://") {
        return Err("Invalid endpoint format. Must start with ws:// or wss://".into());
    }

    // Try to establish an RPC connection with a 10-second timeout
    match tokio::time::timeout(Duration::from_secs(10), async {
        subxt::backend::rpc::RpcClient::from_url(endpoint)
            .await
            .map_err(|e| format!("Connection failed: {e}"))
    })
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Connection timed out after 10 seconds".into()),
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
