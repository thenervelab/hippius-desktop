//! Connect to the bridge's two chains (Bittensor + Hippius testnet).
//!
//! Bridge operations are user-initiated and infrequent, so we connect fresh per
//! operation rather than caching a long-lived client — that side-steps the
//! stale-connection / reconnect bookkeeping the mainnet `blockchain::client`
//! needs only because its connection is hot. Both chains are
//! `PolkadotConfig`/sr25519, so the existing signer + extrinsic types apply.

use std::time::Duration;
use subxt::backend::rpc::RpcClient;
use subxt::{OnlineClient, PolkadotConfig};

use crate::error::{AppError, Result};

/// One bounded connection attempt — a dead endpoint surfaces as a timeout
/// `Err` instead of hanging the bridge command.
const CONNECT_TIMEOUT_SECS: u64 = 20;

/// Open a fresh `OnlineClient` to `ws_url`.
///
/// # Errors
/// [`AppError::Substrate`] on connection failure or timeout.
pub async fn connect(ws_url: &str) -> Result<OnlineClient<PolkadotConfig>> {
    tokio::time::timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS), async {
        let rpc = RpcClient::from_url(ws_url)
            .await
            .map_err(|e| AppError::Substrate(format!("Bridge RPC connect to {ws_url} failed: {e}")))?;
        OnlineClient::<PolkadotConfig>::from_rpc_client(rpc)
            .await
            .map_err(|e| AppError::Substrate(format!("Bridge client init for {ws_url} failed: {e}")))
    })
    .await
    .map_err(|_| AppError::Substrate(format!("Timed out connecting to bridge endpoint {ws_url}")))?
}

/// Connect to the Bittensor chain (ink! contract + proxy + stake side).
///
/// # Errors
/// See [`connect`].
pub async fn connect_bittensor() -> Result<OnlineClient<PolkadotConfig>> {
    connect(super::config::BITTENSOR_WS_URL).await
}

/// Connect to the Hippius testnet chain (`AlphaBridge` pallet side).
///
/// # Errors
/// See [`connect`].
pub async fn connect_hippius() -> Result<OnlineClient<PolkadotConfig>> {
    connect(super::config::HIPPIUS_TESTNET_WS_URL).await
}
