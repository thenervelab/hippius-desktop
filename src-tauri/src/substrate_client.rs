use crate::constants::substrate::WSS_ENDPOINT;
use crate::DB_POOL; // Add this import
use std::sync::Arc;
use std::time::Duration;
use subxt::{OnlineClient, PolkadotConfig};
use tokio::time::sleep;
use std::sync::RwLock;
use once_cell::sync::Lazy;
use sqlx::Row; // Add this import

static SUBSTRATE_CLIENT: Lazy<RwLock<Option<Arc<OnlineClient<PolkadotConfig>>>>> = Lazy::new(|| RwLock::new(None));

const MAX_RETRIES: usize = 10;
const RETRY_DELAY_SECS: u64 = 5;

pub async fn get_substrate_client() -> Result<Arc<OnlineClient<PolkadotConfig>>, String> {
    // Check if we have an existing client
    let existing_client = {
        let client = SUBSTRATE_CLIENT.read().unwrap();
        client.clone()
    };
    
    if let Some(client) = existing_client {
        return Ok(client);
    }
    
    // Get the current WSS endpoint from database, fallback to default constant
    let wss_endpoint = get_current_wss_endpoint().await.unwrap_or_else(|_| WSS_ENDPOINT.to_string());
    
    let mut attempt = 0;
    loop {
        attempt += 1;
        match OnlineClient::<PolkadotConfig>::from_url(&wss_endpoint).await {
            Ok(client) => {
                let arc = Arc::new(client);
                let mut client_lock = SUBSTRATE_CLIENT.write().unwrap();
                *client_lock = Some(arc.clone());
                println!("[Substrate] Connected to node on attempt {} using endpoint: {}", attempt, wss_endpoint);
                return Ok(arc);
            }
            Err(e) => {
                eprintln!(
                    "[Substrate] Failed to connect to node (attempt {}) using endpoint {}: {}",
                    attempt, wss_endpoint, e
                );
                if attempt >= MAX_RETRIES {
                    return Err(format!(
                        "Failed to connect to Substrate node after {} attempts: {}",
                        MAX_RETRIES, e
                    ));
                }
                sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
            }
        }
    }
}

pub fn clear_substrate_client() {
    let mut client = SUBSTRATE_CLIENT.write().unwrap();
    *client = None;
    println!("[Substrate] Cleared substrate client");
}

// Get the current WSS endpoint from database
pub async fn get_current_wss_endpoint() -> Result<String, String> {
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    
    let row = sqlx::query("SELECT endpoint FROM wss_endpoint WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to query WSS endpoint: {}", e))?;
    
    match row {
        Some(row) => {
            let endpoint: String = row.get("endpoint");
            Ok(endpoint)
        }
        None => Err("No WSS endpoint found in database".to_string())
    }
}

// Update the WSS endpoint in database and clear the current client
pub async fn update_wss_endpoint(new_endpoint: String) -> Result<(), String> {
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    
    // Validate the endpoint format (basic check)
    if !new_endpoint.starts_with("ws://") && !new_endpoint.starts_with("wss://") {
        return Err("Invalid WSS endpoint format. Must start with ws:// or wss://".to_string());
    }
    
    // Update or insert the endpoint
    let result = sqlx::query(
        "INSERT OR REPLACE INTO wss_endpoint (id, endpoint, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)"
    )
    .bind(&new_endpoint)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update WSS endpoint: {}", e))?;
    
    if result.rows_affected() > 0 {
        // Clear the current client so it will reconnect with new endpoint
        clear_substrate_client();
        println!("[Substrate] WSS endpoint updated to: {}", new_endpoint);
        Ok(())
    } else {
        Err("Failed to update WSS endpoint".to_string())
    }
}

// Test connection to a WSS endpoint without updating the database
pub async fn test_wss_endpoint(endpoint: String) -> Result<bool, String> {
    if !endpoint.starts_with("ws://") && !endpoint.starts_with("wss://") {
        return Err("Invalid WSS endpoint format. Must start with ws:// or wss://".to_string());
    }
    
    match OnlineClient::<PolkadotConfig>::from_url(&endpoint).await {
        Ok(_) => {
            println!("[Substrate] Successfully tested connection to: {}", endpoint);
            Ok(true)
        }
        Err(e) => {
            eprintln!("[Substrate] Failed to connect to {}: {}", endpoint, e);
            Err(format!("Connection test failed: {}", e))
        }
    }
}