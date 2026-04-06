//! Blockchain runtime state — RPC client and block subscription.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use subxt::backend::rpc::RpcClient;

/// Lazily-initialized Substrate RPC client connection.
pub struct BlockchainState {
    pub client: std::sync::RwLock<Option<Arc<subxt::OnlineClient<subxt::PolkadotConfig>>>>,
    /// Cached RPC client for legacy RPC methods (shares the same WebSocket).
    pub rpc_client: std::sync::RwLock<Option<RpcClient>>,
}

impl Default for BlockchainState {
    fn default() -> Self {
        Self::new()
    }
}

impl BlockchainState {
    pub fn new() -> Self {
        Self {
            client: std::sync::RwLock::new(None),
            rpc_client: std::sync::RwLock::new(None),
        }
    }
}

/// Tracks a background task that subscribes to new finalized blocks.
pub struct BlockSubscriptionState {
    pub running: AtomicBool,
    pub latest_block: AtomicU64,
    pub is_connected: AtomicBool,
    pub handle: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Default for BlockSubscriptionState {
    fn default() -> Self {
        Self::new()
    }
}

impl BlockSubscriptionState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            latest_block: AtomicU64::new(0),
            is_connected: AtomicBool::new(false),
            handle: tokio::sync::Mutex::new(None),
        }
    }
}
