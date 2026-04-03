//! Centralized application state managed by Tauri.
//!
//! All mutable state is initialized once at startup in `AppState::new()`,
//! registered via `app.manage(AppState::new())`, and accessed by command
//! handlers via `tauri::State<'_, AppState>`. Background tasks retrieve
//! it from `AppHandle` via `app.state::<AppState>()`.
//!
//! Zero `static` variables — all state flows through parameters.

use crate::sync_engine::SyncEngine;
use sp_core::sr25519;
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, OnceLock};

/// Cryptographic identity derived from the user's BIP-39 mnemonic at login.
///
/// Populated by `login_with_mnemonic` and cleared on logout. The sr25519
/// keypair is used to sign Substrate extrinsics; the addresses are
/// displayed in the UI and used for API authentication.
#[derive(Default)]
pub struct AuthInfo {
    pub sr25519_pair: Option<sr25519::Pair>,
    pub substrate_address: Option<String>,
    pub eth_address: Option<String>,
}

/// Lazily-initialized Substrate RPC client connection.
///
/// The client is created on first use and reconnected if the WebSocket
/// endpoint changes. Protected by `RwLock` for concurrent read access
/// from multiple command handlers.
pub struct BlockchainState {
    pub client: std::sync::RwLock<Option<Arc<subxt::OnlineClient<subxt::PolkadotConfig>>>>,
}

impl BlockchainState {
    pub fn new() -> Self {
        Self {
            client: std::sync::RwLock::new(None),
        }
    }
}

/// Tracks a background task that subscribes to new finalized blocks.
///
/// Used by the frontend to display the latest block number and
/// connection status indicator.
pub struct BlockSubscriptionState {
    pub running: AtomicBool,
    pub latest_block: AtomicU64,
    pub is_connected: AtomicBool,
    pub handle: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
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

/// In-flight OAuth PKCE states, keyed by the `state` parameter.
///
/// Each entry is created when an OAuth flow starts and consumed when
/// the callback arrives. Entries expire naturally if the user abandons
/// the flow.
pub struct OAuthState {
    pub pkce_states: Mutex<HashMap<String, crate::commands::oauth::PkceState>>,
}

impl OAuthState {
    pub fn new() -> Self {
        Self {
            pkce_states: Mutex::new(HashMap::new()),
        }
    }
}

/// Nebula VPN runtime state — setup progress and background ping task.
pub struct NebulaState {
    pub setup: Mutex<crate::utils::nebula::NebulaSetupState>,
    pub ping_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl NebulaState {
    pub fn new() -> Self {
        Self {
            setup: Mutex::new(crate::utils::nebula::NebulaSetupState::default()),
            ping_handle: Mutex::new(None),
        }
    }
}

/// State for the server-side migration workflow.
///
/// - `in_progress`: true while a migration is running (blocks non-migration sync init)
/// - `client`: shared HTTP client for migration API calls
pub struct MigrationState {
    pub in_progress: AtomicBool,
    pub client: reqwest::Client,
}

impl MigrationState {
    pub fn new() -> Self {
        let client = {
            let mut builder = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30));
            #[cfg(debug_assertions)]
            {
                builder = builder.danger_accept_invalid_certs(true);
            }
            builder.build().expect("Failed to build migration HTTP client")
        };
        Self {
            in_progress: AtomicBool::new(false),
            client,
        }
    }
}

/// The single top-level state container for the entire Tauri backend.
///
/// Registered once at startup via `app.manage(AppState::new())`. Command
/// handlers access it through `tauri::State<'_, AppState>`; background
/// tasks use `app.state::<AppState>()`. All sub-states use interior
/// mutability so `&AppState` suffices everywhere.
pub struct AppState {
    db: OnceLock<SqlitePool>,
    pub auth: Mutex<AuthInfo>,
    pub active_account_id: Mutex<Option<String>>,
    pub sync: Arc<SyncEngine>,
    pub blockchain: BlockchainState,
    pub block_sub: BlockSubscriptionState,
    pub oauth: OAuthState,
    pub nebula: NebulaState,
    pub migration: MigrationState,
    /// HTTP client for HCFS health checks (accepts self-signed certs).
    pub health_client: reqwest::Client,
    /// HTTP client for Hippius API calls (reuses connection pool + TLS cache).
    pub api_client: reqwest::Client,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            db: OnceLock::new(),
            auth: Mutex::new(AuthInfo::default()),
            active_account_id: Mutex::new(None),
            sync: Arc::new(SyncEngine::new()),
            blockchain: BlockchainState::new(),
            block_sub: BlockSubscriptionState::new(),
            oauth: OAuthState::new(),
            nebula: NebulaState::new(),
            migration: MigrationState::new(),
            health_client: reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to build health HTTP client"),
            api_client: reqwest::Client::builder().build().expect("Failed to build API HTTP client"),
        }
    }

    /// Set the database pool. Called once during async setup.
    pub fn set_pool(&self, pool: SqlitePool) {
        self.db.set(pool).expect("AppState pool already initialized");
    }

    /// Get a reference to the database pool.
    pub fn pool(&self) -> Result<&SqlitePool, crate::error::AppError> {
        self.db.get().ok_or_else(|| crate::error::AppError::Db(sqlx::Error::PoolClosed))
    }
}
