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

    // Clear the PERSISTED session first. If this fails we return Err with the
    // in-memory AuthInfo still intact, leaving the app in a consistent
    // "still logged in" state. Wiping memory first would let a failed DB clear
    // leave a live on-disk token that silently rehydrates the session on the
    // next restore while the UI believes it has logged out.
    crate::auth::auth_session_repo::clear(state.pool()?, account_id).await?;

    // Clear the plaintext token fallbacks (`objectstore_auth_scoped` +
    // legacy `objectstore_auth`) that `auth_session_repo::clear` leaves
    // behind. Without this, on a keychain-less host `get_api_token` resolves
    // the still-present plaintext token after logout and the session is
    // silently resurrected (audit R-05).
    crate::auth::tokens::clear_api_token(state.pool()?, account_id).await?;

    {
        let mut auth = state.auth.lock()?;
        auth.capabilities = crate::auth::state::AuthCapabilities::None;
        auth.sr25519_pair = None;
        auth.substrate_address = None;
        auth.eth_address = None;
        auth.mnemonic = None;
    }

    // Reset the recovery gate so an OAuth account's `Pending` gate can't leak
    // into a subsequent mnemonic login and hang its `ensure_sync_mnemonic`
    // (audit R-30). Default-after-logout is `Skipped`, the non-blocking state.
    state.set_recovery_state(crate::recovery::RecoveryGateState::Skipped);

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
/// Bundles sync teardown, auth-state clearing, and progress cleanup into one
/// command. The frontend still needs to clear localStorage and React state.
#[tauri::command]
pub async fn logout_full(app: tauri::AppHandle, account_id: String) -> Result<(), AppError> {
    use tauri::Manager;
    info!(account_id = %account_id, "Full logout initiated");

    // 1. Stop sync engine
    if let Err(e) = crate::sync::lifecycle::stop_sync(app.clone()).await {
        warn!("stop_sync during logout failed: {e}");
    }

    // 1b. Stop the block subscription so its background task doesn't outlive the
    //     session — otherwise it keeps reconnecting and emitting
    //     `block_number_updated` against the logged-out account, and its still-set
    //     `running` flag would make the next login's `start_block_subscription`
    //     CAS refuse to start a fresh subscription.
    crate::blockchain::subscription::stop_block_subscription_inner(&app).await;

    // 1c. Tear down the VM-connection VPN: leave the NetBird overlay and close
    //     every localhost forward, so the next signed-in account can't inherit
    //     the previous tenant's live `127.0.0.1:<port>` forwards. No-op on
    //     default builds (the disabled engine's `disconnect` is `Ok`).
    //     Best-effort — a failure must not block logout.
    if let Err(e) = app.state::<crate::app_state::AppState>().vpn.disconnect().await {
        warn!("vpn disconnect during logout failed: {e}");
    }

    // 2. Clear auth state. PROPAGATE a failure here instead of swallowing it:
    //    `auth_logout_internal` clears the persisted `auth_session` row BEFORE
    //    wiping in-memory `AuthInfo`, so on failure it returns Err with the
    //    session left intact and consistent ("still logged in"). Reporting
    //    Ok(()) would make the frontend clear its local state and show the login
    //    screen while the live on-disk token silently rehydrates the session on
    //    the next boot. A `warn!`-and-continue here would defeat that guarantee.
    //    The post-logout cleanups below are best-effort and only run once the
    //    session is genuinely cleared.
    let state = app.state::<crate::app_state::AppState>();
    auth_logout_internal(&state, &account_id).await?;

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

    // 5. Drop this account's cached share list so another user's share
    //    metadata (filenames, mime types, timestamps) does not linger in
    //    memory after logout. Account-scoped, mirroring step 4 — a second
    //    account sharing the process keeps its own entry.
    if let Ok(mut cache) = state.share_active_list_cache.lock() {
        cache.remove(&account_id);
    }

    Ok(())
}
