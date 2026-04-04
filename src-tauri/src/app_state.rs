//! Centralized application state managed by Tauri.
//!
//! All mutable state is initialized once at startup in `AppState::new()`,
//! registered via `app.manage(AppState::new())`, and accessed by command
//! handlers via `tauri::State<'_, AppState>`. Background tasks retrieve
//! it from `AppHandle` via `app.state::<AppState>()`.
//!
//! Sub-state definitions live in their respective domain modules. This file
//! composes them into the single `AppState` container.

use crate::auth::state::AuthInfo;
use crate::auth::oauth::OAuthState;
use crate::blockchain::state::{BlockchainState, BlockSubscriptionState};
use crate::sync::migration::MigrationState;
use crate::nebula::state::NebulaState;
use crate::sync::tauri_bridge::TauriSyncBridge;
use hcfs_client::engine::runner::SyncRunner;

use sqlx::sqlite::SqlitePool;
use std::sync::{Arc, Mutex, OnceLock};

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
    pub sync: Arc<SyncRunner>,
    /// Tauri bridge for sync event emission and callbacks.
    /// Stored separately so `set_app_handle` can be called after construction.
    pub sync_bridge: Arc<TauriSyncBridge>,
    pub blockchain: BlockchainState,
    pub block_sub: BlockSubscriptionState,
    pub oauth: OAuthState,
    pub nebula: NebulaState,
    pub migration: MigrationState,
    /// HTTP client for HCFS health checks (accepts self-signed certs in debug).
    pub health_client: reqwest::Client,
    /// HTTP client for Hippius API calls (reuses connection pool + TLS cache).
    pub api_client: reqwest::Client,
}

impl AppState {
    pub fn new() -> Self {
        let sync_bridge = Arc::new(TauriSyncBridge::new());
        let health_client = {
            #[allow(unused_mut)]
            let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10));
            #[cfg(debug_assertions)]
            {
                builder = builder.danger_accept_invalid_certs(true);
            }
            builder.build().expect("Failed to build health HTTP client")
        };
        let sync = Arc::new(SyncRunner::new(
            sync_bridge.clone() as Arc<dyn hcfs_client::engine::events::SyncEventHandler>,
            sync_bridge.clone() as Arc<dyn hcfs_client::engine::events::SyncCallbacks>,
            health_client.clone(),
        ));
        Self {
            db: OnceLock::new(),
            auth: Mutex::new(AuthInfo::default()),
            active_account_id: Mutex::new(None),
            sync,
            sync_bridge,
            blockchain: BlockchainState::new(),
            block_sub: BlockSubscriptionState::new(),
            oauth: OAuthState::new(),
            nebula: NebulaState::new(),
            migration: MigrationState::new(),
            health_client,
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
    pub fn pool(&self) -> Result<&SqlitePool, crate::error::AppError> {
        self.db
            .get()
            .ok_or_else(|| crate::error::AppError::Db(sqlx::Error::PoolClosed))
    }

    /// Store the active account ID for background tasks to reference.
    pub fn set_active_account(&self, account_id: &str) {
        let mut guard = self
            .active_account_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard = Some(account_id.to_string());
    }

    /// Retrieve the active account ID, or error if no user is logged in.
    pub fn current_account_id(&self) -> Result<String, String> {
        self.active_account_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(|| "No active account set".to_string())
    }
}
