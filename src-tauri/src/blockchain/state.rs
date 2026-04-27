//! Blockchain runtime state — RPC client and block subscription.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};
use subxt::backend::rpc::RpcClient;

/// Lazily-initialized Substrate RPC client connection.
pub struct BlockchainState {
    pub client: std::sync::RwLock<Option<Arc<subxt::OnlineClient<subxt::PolkadotConfig>>>>,
    /// Cached RPC client for legacy RPC methods (shares the same WebSocket).
    pub rpc_client: std::sync::RwLock<Option<RpcClient>>,
    /// Serializes connection attempts so only one task connects at a time.
    /// Other callers wait on this lock and reuse the resulting client.
    pub connect_guard: tokio::sync::Mutex<()>,
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
            connect_guard: tokio::sync::Mutex::new(()),
        }
    }
}

/// Tracks a background task that subscribes to new finalized blocks.
pub struct BlockSubscriptionState {
    pub running: AtomicBool,
    pub latest_block: AtomicU64,
    pub is_connected: AtomicBool,
    pub handle: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Monotonic millisecond timestamp of the last `block_number_updated`
    /// emit. Used to throttle high-frequency block emits during catch-up
    /// bursts. Zero means "never emitted, allow immediately."
    pub last_emit_ms: AtomicU64,
    /// Set to `true` while a deferred trailing-edge emit task is sleeping.
    /// Ensures only one such task runs at a time so a burst of throttled
    /// blocks doesn't spawn N redundant flush tasks.
    pub deferred_emit_in_flight: AtomicBool,
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
            last_emit_ms: AtomicU64::new(0),
            deferred_emit_in_flight: AtomicBool::new(false),
        }
    }
}
