use crate::constants::substrate::WSS_ENDPOINT;
use once_cell::sync::OnceCell;
use std::sync::Arc;
use std::time::Duration;
use subxt::{OnlineClient, PolkadotConfig};
use tokio::time::sleep;

static SUBSTRATE_CLIENT: OnceCell<Arc<OnlineClient<PolkadotConfig>>> = OnceCell::new();

const MAX_RETRIES: usize = 10;
const RETRY_DELAY_SECS: u64 = 5;

pub async fn get_substrate_client() -> Result<Arc<OnlineClient<PolkadotConfig>>, String> {
    if let Some(client) = SUBSTRATE_CLIENT.get() {
        Ok(client.clone())
    } else {
        let mut attempt = 0;
        loop {
            attempt += 1;
            match OnlineClient::<PolkadotConfig>::from_url(WSS_ENDPOINT).await {
                Ok(client) => {
                    let arc = Arc::new(client);
                    SUBSTRATE_CLIENT.set(arc.clone()).ok();
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
}
