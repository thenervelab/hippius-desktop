//! Centralized application state managed by Tauri.
//!
//! Registered via `app.manage(AppState::new())` during setup.
//! Command handlers receive it as `tauri::State<'_, AppState>`.

use sp_core::sr25519;
use sqlx::sqlite::SqlitePool;
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
pub struct AuthInfo {
    pub sr25519_pair: Option<sr25519::Pair>,
    pub substrate_address: Option<String>,
    pub eth_address: Option<String>,
}

pub struct AppState {
    db: OnceLock<SqlitePool>,
    pub auth: Mutex<AuthInfo>,
    pub active_account_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            db: OnceLock::new(),
            auth: Mutex::new(AuthInfo::default()),
            active_account_id: Mutex::new(None),
        }
    }

    /// Set the database pool. Called once during async setup.
    /// Panics if called more than once (programming error).
    pub fn set_pool(&self, pool: SqlitePool) {
        self.db
            .set(pool)
            .expect("AppState pool already initialized");
    }

    /// Get a reference to the database pool.
    /// Returns Err if the pool hasn't been initialized yet.
    pub fn pool(&self) -> Result<&SqlitePool, String> {
        self.db
            .get()
            .ok_or_else(|| "Database not initialized".to_string())
    }
}
