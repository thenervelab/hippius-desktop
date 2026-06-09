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
use crate::recovery::RecoveryGateState;
use crate::sync::drive_status::DriveStatus;
use crate::sync::migration::MigrationState;
use crate::sync::tauri_bridge::TauriSyncBridge;
use hcfs_client::engine::runner::SyncRunner;

use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, atomic::AtomicU64};

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
    pub migration: MigrationState,
    /// Tracks the disk-copy + encryption window for user-initiated
    /// uploads. Drives the top-of-page processing banner. See
    /// `crate::sync::upload_processing`.
    pub upload_processing: std::sync::Arc<crate::sync::upload_processing::UploadProcessingState>,
    /// Tracks the scan + remote-state-fetch + plan-build window for
    /// file-watcher-initiated sync cycles. Drives the bottom-right
    /// widget's "Preparing sync…" badge so the user has feedback
    /// between `SyncStarted` and the first ProgressSnapshot with
    /// files. IPC uploads use `upload_processing` instead — the two
    /// surfaces are intentionally exclusive (the `SyncStarted`
    /// handler suppresses `mark_preparing` when the banner is
    /// already raised). See `crate::sync::preparing`.
    pub preparing: std::sync::Arc<crate::sync::preparing::PreparingState>,
    /// Per-label running count of `InsufficientBalance` per-file
    /// failures in the current sync cycle. Read by the `FileFailed`
    /// arm of the bridge to attach `file_count` to the
    /// `hcfs_credits_exhausted` payload, cleared on every cycle
    /// boundary (`SyncStarted`, `SyncStopped`, the non-cancel branch
    /// of `SyncError`, and globally on `SyncReset`). See
    /// `crate::sync::credits_exhausted`.
    pub credits_exhausted: std::sync::Arc<crate::sync::credits_exhausted::CreditsExhaustedState>,
    /// Monotonically increasing counter, incremented on every
    /// `SyncStarted` event. The `UploadProcessingState` clear gate
    /// reads this to distinguish events from a cycle that began
    /// AFTER an `add_file`/`add_files`/`add_folder` call from events
    /// that belong to a cycle that was already running.
    pub sync_session_epoch: AtomicU64,
    /// Unix-millis timestamp of the last time the tray panel was hidden by a
    /// focus-loss (blur) event. Read by `tray::panel::toggle_tray_panel` to
    /// suppress the immediate re-open that would otherwise happen when the
    /// user clicks the already-open tray icon: the click first blurs+hides the
    /// panel, then fires the toggle, which would see it hidden and re-show it.
    /// `0` means "never hidden by blur". See `tray::panel` for the cooldown.
    pub tray_panel_hidden_at: AtomicU64,
    /// HTTP client for HCFS health checks (accepts self-signed certs in debug).
    pub health_client: reqwest::Client,
    /// HTTP client for Hippius API calls (reuses connection pool + TLS cache).
    pub api_client: reqwest::Client,
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
    /// Per-account async locks serializing auth-token refreshes. Two concurrent
    /// `refresh_auth_token_internal` calls for the same account would otherwise
    /// race a parallel challenge-response (double session upsert + token save);
    /// the second caller awaits the first on this per-account `tokio::Mutex`.
    /// The outer std `Mutex` only guards the map insert (never held across an
    /// await); the inner tokio `Mutex` guard is held across the refresh.
    pub refresh_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Recovery dialog gate. `ensure_sync_mnemonic` awaits a non-`Pending`
    /// value before touching the local mnemonic store, preventing a race
    /// where a fresh-device sync init mints a new mnemonic before the
    /// recovery flow has had a chance to install the unsealed one.
    /// See `docs/plans/2026-04-14-oauth-account-recovery.md`.
    recovery_gate: tokio::sync::watch::Sender<RecoveryGateState>,
    /// Serializes the mnemonic-mutating recovery/rotation commands
    /// (`change_recovery_password`, `recover_mnemonic`, `seal_and_upload_mnemonic`,
    /// `resume_recovery_password_rotation`). Each holds this for its whole
    /// POST → install → align sequence, so two overlapping rotations (a rapid
    /// double-submit, or a rotation racing another device's resume) can't
    /// interleave the master-file write, the per-folder rewrites, and the
    /// DB-row flip and leave a drive wedged under a half-applied password
    /// (audit R-18). The FE `has_pending_rotation` gate is advisory only; this
    /// is the real guard.
    pub recovery_lock: tokio::sync::Mutex<()>,
    /// Per-account snapshot of the most recent `hcfs_list_shares`
    /// result. Used by `crate::shares::history::diff_active_lists` to
    /// detect tokens that have left the active set since the last
    /// refresh, and by `hcfs_revoke_share` to recover filename/mime/
    /// timestamps for the cached `ShareSummary` of the token being
    /// revoked.
    ///
    /// Lost on app restart. The plan's design doc accepts the tradeoff:
    /// rows that vanish while the app is closed don't surface in
    /// history, which is acceptable because (a) `hcfs_list_shares` only
    /// returns currently-active tokens — historical knowledge is purely
    /// local presentation state — and (b) a persistent snapshot table
    /// would add a write path on every refresh for marginal benefit.
    ///
    /// Mutex held only for the snapshot read at revoke time and the
    /// snapshot write at end of list — lock duration is microseconds.
    pub share_active_list_cache: Mutex<HashMap<String, Vec<hcfs_client::client::share::ShareSummary>>>,
    /// Per-wallet rate limiter for password operations. See
    /// `crate::wallet::rate_limit` for the policy. Process-local — no
    /// persistence across app restarts (intentional: against a
    /// stolen-DB attacker this layer adds nothing; its job is to clamp
    /// online IPC abuse during a single session).
    pub wallet_rate_limit: Arc<crate::wallet::rate_limit::RateLimitState>,
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
            migration: MigrationState::new(),
            upload_processing: std::sync::Arc::new(crate::sync::upload_processing::UploadProcessingState::new()),
            preparing: std::sync::Arc::new(crate::sync::preparing::PreparingState::new()),
            credits_exhausted: std::sync::Arc::new(crate::sync::credits_exhausted::CreditsExhaustedState::new()),
            sync_session_epoch: AtomicU64::new(0),
            tray_panel_hidden_at: AtomicU64::new(0),
            health_client,
            // Explicit timeouts. Without them a hung connection (e.g. a
            // billing-server blip during `check_action_eligibility`) would
            // stall the IPC forever — the UI would appear frozen, and when
            // the TCP layer eventually errored out the FE's fail-closed
            // catch would mis-report it as "Insufficient Credits".
            api_client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Failed to build API HTTP client"),
            file_failures: crate::sync::failure_tracking::FileFailureState::new(),
            refresh_locks: Mutex::new(HashMap::new()),
            drive_status_cache: Mutex::new(HashMap::new()),
            // Default `Skipped` — non-OAuth login paths (mnemonic login,
            // session restore for a returning user) never need the dialog,
            // so `ensure_sync_mnemonic`'s await passes through immediately.
            // `complete_oauth_flow` flips this to `Pending` at its start so
            // the dialog gets a chance to run before any sync init races in.
            recovery_gate: tokio::sync::watch::channel(RecoveryGateState::Skipped).0,
            recovery_lock: tokio::sync::Mutex::new(()),
            share_active_list_cache: Mutex::new(HashMap::new()),
            wallet_rate_limit: Arc::new(crate::wallet::rate_limit::RateLimitState::new()),
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
    ///
    /// Returns [`crate::error::NotReadyKind::DatabaseNotReady`] when the pool
    /// has not been installed yet (early startup, before the boot-time DB-init
    /// task runs `set_pool`). This is a distinct signal from `Db(PoolClosed)`,
    /// so callers can tell "never initialized" apart from a live pool that was
    /// later closed.
    pub fn pool(&self) -> Result<&SqlitePool, crate::error::AppError> {
        self.db
            .get()
            .ok_or(crate::error::AppError::NotReady(crate::error::NotReadyKind::DatabaseNotReady))
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
    /// for the active account. Returns the crate's `AppError` (lock poison →
    /// `Lock`, no logged-in account → `Auth`) so the ~30 callers that already
    /// return `Result<_, AppError>` propagate it with a bare `?` instead of
    /// wrapping a stringly error in `AppError::Other`.
    pub fn current_account_id(&self) -> Result<String, crate::error::AppError> {
        self.auth
            .lock()?
            .substrate_address
            .clone()
            .ok_or_else(|| crate::error::AppError::Auth("No active account set".into()))
    }

    /// Validate that a frontend-supplied `account_id` is the active session
    /// account, returning the (validated) session account on success.
    ///
    /// IPC command arguments come from the webview and are untrusted. On a
    /// device where more than one account has been configured, a buggy or
    /// compromised renderer could pass *another* account's address to read,
    /// download, delete, or write that account's data under its token. Routing
    /// every account-scoped command through this guard makes the session the
    /// single authority — the boundary-validation discipline (convert the
    /// untrusted input into a trusted value once, here, rather than scoping
    /// raw input deep in each command).
    ///
    /// Returns the session account rather than `()` so callers shadow their
    /// `account_id` parameter with the trusted value and cannot accidentally
    /// keep using the raw input.
    ///
    /// # Errors
    ///
    /// - [`crate::error::AppError::Auth`] when no account is logged in, or when
    ///   `account_id` does not match the active session account.
    /// - [`crate::error::AppError::Lock`] if the auth mutex is poisoned.
    pub fn require_session_account(&self, account_id: &str) -> Result<String, crate::error::AppError> {
        let current = self.current_account_id()?;
        if current != account_id {
            return Err(crate::error::AppError::Auth("Requested account is not the active session account".into()));
        }
        Ok(current)
    }

    /// Like [`require_session_account`](Self::require_session_account) but
    /// returns the proof type [`SessionAccount`].
    ///
    /// Use this when a frontend-supplied `account_id` must be handed to a
    /// token-fetching API (`ApiClient` / `get_auth_token_for_account`), which
    /// require that proof at compile time. Validates exactly as the string
    /// form, then mints the proof.
    ///
    /// # Errors
    /// Same as [`require_session_account`](Self::require_session_account).
    pub fn require_session_account_typed(&self, account_id: &str) -> Result<SessionAccount, crate::error::AppError> {
        Ok(SessionAccount(self.require_session_account(account_id)?))
    }

    /// The active session account as a [`SessionAccount`] proof, for internal
    /// (non-command) token calls that act on the logged-in account itself
    /// (e.g. the sync engine's credit pre-check). The session account is
    /// trusted by definition, so this is the mint point that needs no
    /// frontend input to validate.
    ///
    /// # Errors
    /// [`crate::error::AppError::Auth`] when no account is logged in;
    /// [`crate::error::AppError::Lock`] if the auth mutex is poisoned.
    pub fn current_session_account(&self) -> Result<SessionAccount, crate::error::AppError> {
        Ok(SessionAccount(self.current_account_id()?))
    }
}

/// A frontend-supplied account id proven to equal the active session account.
///
/// Account-scoped IPC commands take `account_id: SessionAccount` instead of
/// `account_id: String`. The value is minted ONLY by this type's
/// [`tauri::ipc::CommandArg`] extraction, which runs
/// [`AppState::require_session_account`] against the managed [`AppState`] before
/// the command body runs — so holding a `SessionAccount` is compile-time proof
/// the cross-account check already passed, and the untrusted raw string never
/// reaches the body. The inner field is private, so a `SessionAccount` cannot be
/// forged outside this module; combined with the
/// `tests/account_authority_guard.rs` check that token-backed commands take
/// this type (not a raw `String`), a command physically cannot use an
/// unvalidated account.
#[derive(Debug, Clone)]
pub struct SessionAccount(String);

impl SessionAccount {
    /// The validated SS58 account id.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume into the owned validated account id.
    #[must_use]
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl std::ops::Deref for SessionAccount {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SessionAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for SessionAccount {
    /// Pull `account_id` from the IPC payload and validate it against the
    /// session account before the command body runs.
    ///
    /// # Errors
    ///
    /// - The managed [`AppState`] missing, or `account_id` absent/not a string.
    /// - [`crate::error::AppError::Auth`] (serialized to the `{kind,message}`
    ///   shape the frontend matches on) when the supplied account is not the
    ///   active session account.
    fn from_command(command: tauri::ipc::CommandItem<'de, R>) -> Result<Self, tauri::ipc::InvokeError> {
        use serde::Deserialize;
        let (name, key) = (command.name, command.key);
        // `message` is a `Copy` reference, so reading it does not move
        // `command`, which the deserializer below consumes.
        let message = command.message;
        let state = message.state_ref().try_get::<AppState>().ok_or_else(|| {
            tauri::ipc::InvokeError(serde_json::Value::String(format!(
                "AppState is not managed (command `{name}`, arg `{key}`)"
            )))
        })?;
        let account_id = String::deserialize(command)
            .map_err(|e| tauri::ipc::InvokeError(serde_json::Value::String(format!("command `{name}` arg `{key}`: {e}"))))?;
        // `?` converts AppError -> InvokeError via `impl<T: Serialize> From<T>`,
        // preserving AppError's `{kind, message}` JSON for FE error matching.
        let validated = state.require_session_account(&account_id)?;
        Ok(SessionAccount(validated))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::state::AuthCapabilities;
    use crate::error::AppError;

    #[tokio::test]
    async fn require_session_account_rejects_when_logged_out() {
        let state = AppState::new();
        let err = state.require_session_account("addr-A").unwrap_err();
        assert!(matches!(err, AppError::Auth(_)), "no session must be an Auth error, got {err:?}");
    }

    #[tokio::test]
    async fn require_session_account_accepts_matching_account() {
        let state = AppState::new();
        state.set_active_account("addr-A", AuthCapabilities::Full).expect("set account");
        assert_eq!(state.require_session_account("addr-A").expect("match"), "addr-A");
    }

    #[test]
    fn session_account_exposes_validated_id() {
        // The validation path is covered by the require_session_account tests;
        // this pins the accessor surface commands rely on (as_str / Deref /
        // into_inner). Constructed via the private ctor, available only here in
        // the defining module — proving the type cannot be forged elsewhere.
        let acct = SessionAccount("addr-A".to_string());
        assert_eq!(acct.as_str(), "addr-A");
        assert_eq!(&*acct, "addr-A");
        assert_eq!(acct.clone().into_inner(), "addr-A");
    }

    #[tokio::test]
    async fn require_session_account_rejects_other_account() {
        // The core defense: a session logged in as A must not authorize an
        // operation requested for B even though B is a valid address string.
        let state = AppState::new();
        state.set_active_account("addr-A", AuthCapabilities::Full).expect("set account");
        let err = state.require_session_account("addr-B").unwrap_err();
        assert!(
            matches!(err, AppError::Auth(_)),
            "cross-account request must be an Auth error, got {err:?}"
        );
    }
}
