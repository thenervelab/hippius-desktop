//! Logout flow.
//!
//! Three layers, in order of completeness:
//! - [`auth_logout_internal`] — pure Rust helper that clears `AuthInfo`
//!   and the `auth_session` row. Callable from other Rust commands.
//! - [`auth_logout`] — Tauri command wrapper around `_internal`.
//! - [`logout_full`] — orchestration: stops sync, then calls
//!   `auth_logout_internal`, then clears in-memory sync progress.
//!
//! `logout_full` is what the frontend calls; the other two exist for
//! programmatic use from internal Rust commands and for tests.

use crate::error::AppError;
use tracing::{info, warn};

/// Internal logout — clears `AuthInfo`, the `auth_session` row, and
/// the OS keychain entry for this account.
///
/// Preserves the user's `logout_time_minutes` preference (the repo's
/// `clear` only nulls the credential fields). Keychain deletion is
/// best-effort — failures log a warning but don't propagate.
pub async fn auth_logout_internal(state: &crate::app_state::AppState, account_id: &str) -> Result<(), AppError> {
    info!(account_id = %account_id, "Logout initiated");

    {
        let mut auth = state.auth.lock()?;
        auth.capabilities = crate::auth::state::AuthCapabilities::None;
        auth.sr25519_pair = None;
        auth.substrate_address = None;
        auth.eth_address = None;
        auth.mnemonic = None;
    }

    crate::auth::auth_session_repo::clear(state.pool()?, account_id).await?;

    // Best-effort OS keychain cleanup so the next user on this machine
    // doesn't inherit credentials. Non-fatal — the user is already
    // logged out from a token-validity perspective at this point.
    if let Err(e) = crate::auth::keychain::delete_mnemonic(account_id) {
        warn!(error = %e, "Failed to delete OS keychain mnemonic on logout");
    }

    info!("Logout complete");
    Ok(())
}

/// Full logout: stops sync, clears auth state, clears sync progress.
///
/// Replaces the 3-sequential-invoke pattern in wallet-auth-context.tsx.
/// The frontend still needs to clear localStorage and React state.
#[tauri::command]
pub async fn logout_full(app: tauri::AppHandle, account_id: String) -> Result<(), AppError> {
    use tauri::Manager;
    info!(account_id = %account_id, "Full logout initiated");

    // 1. Stop sync engine
    if let Err(e) = crate::sync::lifecycle::stop_sync(app.clone()).await {
        warn!("stop_sync during logout failed: {e}");
    }

    // 2. Clear auth state
    let state = app.state::<crate::app_state::AppState>();
    if let Err(e) = auth_logout_internal(&state, &account_id).await {
        warn!("auth_logout during logout failed: {e}");
    }

    // 3. Clear sync progress data
    if let Err(e) = crate::sync::progress::clear_all_data(&state.sync) {
        warn!("sp_clear_all_data during logout failed: {e}");
    }

    // 4. Clear intent manifest rows for this account. Intent represents
    //    in-flight upload intent; logging out should not leak it into the
    //    next session if a different user logs in. Best-effort: a stale
    //    row would only show wrong totals in the widget, not affect sync
    //    correctness. Symmetric with how the auth_session row is cleared
    //    in step 2. Account-scoped (NOT unconditional) so a different
    //    account sharing the SQLite file is unaffected — the invariant
    //    lives at the SQL layer in `IntentRepo::clear_account`.
    match state.pool() {
        Ok(pool) => {
            let repo = crate::sync::intent::IntentRepo::new(pool.clone());
            if let Err(e) = repo.clear_account(&account_id).await {
                warn!("clear_account during logout failed: {e}");
            }
        }
        Err(e) => warn!("pool unavailable during logout clear_account: {e}"),
    }

    Ok(())
}
