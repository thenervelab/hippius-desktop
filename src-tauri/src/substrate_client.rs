use crate::constants::substrate::WSS_ENDPOINT;
use std::sync::Arc;
use std::time::Duration;
use subxt::{OnlineClient, PolkadotConfig};
use tokio::time::sleep;
use std::sync::RwLock;
use once_cell::sync::Lazy;

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
    
    let mut attempt = 0;
    loop {
        attempt += 1;
        match OnlineClient::<PolkadotConfig>::from_url(WSS_ENDPOINT).await {
            Ok(client) => {
                let arc = Arc::new(client);
                let mut client_lock = SUBSTRATE_CLIENT.write().unwrap();
                *client_lock = Some(arc.clone());
                println!("[Substrate] Connected to node on attempt {}", attempt);
                return Ok(arc);
            }
            Err(e) => {
                eprintln!(
                    "[Substrate] Failed to connect to node (attempt {}): {}",
                    attempt, e
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
}
