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
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, OnceLock};

// ── Auth ────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct AuthInfo {
    pub sr25519_pair: Option<sr25519::Pair>,
    pub substrate_address: Option<String>,
    pub eth_address: Option<String>,
}

// ── Blockchain (Substrate RPC client) ───────────────────────────────────

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

// ── Block Subscription ──────────────────────────────────────────────────

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

// ── OAuth ───────────────────────────────────────────────────────────────

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

// ── Nebula VPN ──────────────────────────────────────────────────────────

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

// ── Migration ───────────────────────────────────────────────────────────

/// State for the S3-to-HCFS migration workflow.
///
/// - `cancel`: cancellation flag for the download loop
/// - `task`: handle to the background migration tokio task
/// - `uploaded`: set of relative paths confirmed uploaded to HCFS
pub struct MigrationState {
    pub cancel: AtomicBool,
    pub task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub uploaded: Mutex<HashSet<String>>,
}

impl MigrationState {
    pub fn new() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            task: tokio::sync::Mutex::new(None),
            uploaded: Mutex::new(HashSet::new()),
        }
    }
}

// ── AppState (the single top-level container) ───────────────────────────

pub struct AppState {
    // Database
    db: OnceLock<SqlitePool>,

    // Authentication
    pub auth: Mutex<AuthInfo>,
    pub active_account_id: Mutex<Option<String>>,

    // Sync Engine (file sync, progress tracking, drive registry)
    pub sync: Arc<SyncEngine>,

    // Blockchain / Substrate RPC
    pub blockchain: BlockchainState,

    // Block Subscription
    pub block_sub: BlockSubscriptionState,

    // OAuth
    pub oauth: OAuthState,

    // Nebula VPN
    pub nebula: NebulaState,

    // Migration (S3 → HCFS)
    pub migration: MigrationState,

    // Shared HTTP client for health checks (connection pool reuse)
    pub health_client: reqwest::Client,

    /// Shared HTTP client for API calls (reuses connection pool + TLS cache).
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
            api_client: reqwest::Client::builder()
                .build()
                .expect("Failed to build API HTTP client"),
        }
    }

    /// Set the database pool. Called once during async setup.
    pub fn set_pool(&self, pool: SqlitePool) {
        self.db
            .set(pool)
            .expect("AppState pool already initialized");
    }

    /// Get a reference to the database pool.
    pub fn pool(&self) -> Result<&SqlitePool, String> {
        self.db
            .get()
            .ok_or_else(|| "Database not initialized".to_string())
    }
}
