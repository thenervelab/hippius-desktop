//! Centralized application state managed by Tauri.
//!
//! All mutable state is initialized once at startup in `AppState::new()`,
//! registered via `app.manage(AppState::new())`, and accessed by command
//! handlers via `tauri::State<'_, AppState>`. Background tasks retrieve
//! it from `AppHandle` via `app.state::<AppState>()`.
//!
//! Sub-state definitions live in their respective domain modules. This file
//! composes them into the single `AppState` container.

use crate::auth::oauth::OAuthState;
use crate::auth::state::AuthInfo;
use crate::blockchain::state::{BlockSubscriptionState, BlockchainState};
use crate::nebula::state::NebulaState;
use crate::recovery::RecoveryGateState;
use crate::sync::drive_status::DriveStatus;
use crate::sync::migration::MigrationState;
use crate::sync::tauri_bridge::TauriSyncBridge;
use hcfs_client::engine::runner::SyncRunner;

use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
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
    /// Notified when a drive is removed from the registry, allowing
    /// `remove_drive_and_wait` to wake without polling.
    pub drive_removed_notify: tokio::sync::Notify,
    /// Per-file consecutive failure counters and session-skip state.
    pub file_failures: crate::sync::failure_tracking::FileFailureState,
    /// Last emitted `DriveStatus` per drive label. The single source of
    /// truth for `get_all_drive_statuses` — without this, an errored
    /// drive (`is_paused=false` in the DB but failed to init) would be
    /// reported as `Active` on FE bootstrap because the DB-derived
    /// fallback can only say Active/Paused. Writes flow through
    /// `sync::status::emit_drive_status`; reads happen in
    /// `get_all_drive_statuses_inner` and fall back to the DB-derived
    /// status for labels with no cached value yet.
    ///
    /// Cleared on `stop_sync` (logout/reset) and pruned on
    /// `emit_drive_removed` (per-drive removal). Never persisted to
    /// disk — an Error state is transient and should not survive app
    /// restart.
    pub drive_status_cache: Mutex<HashMap<String, DriveStatus>>,
    /// Recovery dialog gate. `ensure_sync_mnemonic` awaits a non-`Pending`
    /// value before touching the local mnemonic store, preventing a race
    /// where a fresh-device sync init mints a new mnemonic before the
    /// recovery flow has had a chance to install the unsealed one.
    /// See `docs/plans/2026-04-14-oauth-account-recovery.md`.
    recovery_gate: tokio::sync::watch::Sender<RecoveryGateState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
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
            sync,
            sync_bridge,
            blockchain: BlockchainState::new(),
            block_sub: BlockSubscriptionState::new(),
            oauth: OAuthState::new(),
            nebula: NebulaState::new(),
            migration: MigrationState::new(),
            health_client,
            api_client: reqwest::Client::builder().build().expect("Failed to build API HTTP client"),
            drive_removed_notify: tokio::sync::Notify::new(),
            file_failures: crate::sync::failure_tracking::FileFailureState::new(),
            drive_status_cache: Mutex::new(HashMap::new()),
            // Default `Skipped` — non-OAuth login paths (mnemonic login,
            // session restore for a returning user) never need the dialog,
            // so `ensure_sync_mnemonic`'s await passes through immediately.
            // `complete_oauth_flow` flips this to `Pending` at its start so
            // the dialog gets a chance to run before any sync init races in.
            recovery_gate: tokio::sync::watch::channel(RecoveryGateState::Skipped).0,
        }
    }

    /// Current recovery gate state.
    pub fn recovery_state(&self) -> RecoveryGateState {
        *self.recovery_gate.borrow()
    }

    /// Transition the recovery gate, waking any `await_recovery_resolved` waiters.
    /// Idempotent: sending the same state twice is a no-op.
    pub fn set_recovery_state(&self, state: RecoveryGateState) {
        // `send_replace` unconditionally updates the stored value and notifies
        // subscribers. `send` would silently drop the value when no receivers
        // are active — which happens on startup before any waiter subscribes.
        self.recovery_gate.send_replace(state);
    }

    /// Await until the recovery gate leaves `Pending`. Returns immediately if
    /// already resolved. Intended for `ensure_sync_mnemonic` and any other
    /// code path that must not touch the mnemonic store before recovery
    /// decides whether to install a server-sealed one.
    pub async fn await_recovery_resolved(&self) -> RecoveryGateState {
        let mut rx = self.recovery_gate.subscribe();
        loop {
            let current = *rx.borrow();
            if current.is_resolved() {
                return current;
            }
            if rx.changed().await.is_err() {
                // Sender dropped — state is whatever was last seen.
                return *rx.borrow();
            }
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

    /// Set the active account by populating `AuthInfo.substrate_address`
    /// and `AuthInfo.capabilities` together.
    ///
    /// Used by login/restore flows that don't write the full `AuthInfo`
    /// themselves: `complete_oauth_flow` (OAuth) and `restore_session`
    /// (the `Restored` / `OAuthOnly` paths). The mnemonic-login flow
    /// (`login_with_mnemonic`) and keychain rehydration
    /// (`login::rehydrate_full_session`) write the full `AuthInfo`
    /// directly inside the same lock acquisition and don't call this
    /// helper.
    pub fn set_active_account(&self, account_id: &str, capabilities: crate::auth::state::AuthCapabilities) -> Result<(), crate::error::AppError> {
        let mut auth = self.auth.lock()?;
        auth.substrate_address = Some(account_id.to_string());
        auth.capabilities = capabilities;
        Ok(())
    }

    /// Retrieve the active account ID, or error if no user is logged in.
    ///
    /// Reads from `AuthInfo.substrate_address` — the single source of truth
    /// for the active account.
    pub fn current_account_id(&self) -> Result<String, String> {
        self.auth
            .lock()
            .map_err(|e| format!("auth lock poisoned: {e}"))?
            .substrate_address
            .clone()
            .ok_or_else(|| "No active account set".to_string())
    }
}
