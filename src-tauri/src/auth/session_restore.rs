//! Session restoration on app boot.
//!
//! Two-tier flow: try the OAuth-session JSON the frontend reads from
//! localStorage first; if that's expired or absent, fall back to the
//! most recently updated row in the `auth_session` table. Either way,
//! Rust validates token expiry, populates `AuthInfo`, and returns a
//! structured result for the frontend to render.

use crate::auth::auth_session_repo::{self, TokenStatus};
use crate::auth::keychain::{self, KeychainResult};
use crate::auth::state::AuthCapabilities;
use crate::error::AppError;
use tracing::{info, warn};

/// Outcome of [`rehydrate_or_restored`]. Tells the caller whether the
/// helper has already populated `AuthInfo` (via the keychain rehydrate
/// path) or whether the caller still needs to write
/// `AuthInfo.substrate_address` + `capabilities` via
/// [`crate::app_state::AppState::set_active_account`].
enum RehydrateOutcome {
    /// Keychain hit. `login::rehydrate_full_session` already wrote
    /// `substrate_address`, `capabilities = Full`, and the keypair.
    /// The caller MUST NOT call `set_active_account` (it would
    /// redundantly re-acquire the lock and overwrite the same fields
    /// with the same values).
    AlreadyWritten,
    /// Keychain miss / unavailable, OR the session is OAuth-only.
    /// The caller still needs to call
    /// `state.set_active_account(addr, cap)` to write the address
    /// and capability.
    NeedsActiveAccount(AuthCapabilities),
}

/// Try to fully rehydrate `AuthInfo` from the OS keychain.
///
/// For mnemonic users this attempts a keychain load and, if successful,
/// derives the full keypair via [`crate::auth::login::rehydrate_full_session`].
/// For OAuth users it skips straight to `OAuthOnly`. For mnemonic users
/// without a keychain entry, returns `Restored`.
fn rehydrate_or_restored(state: &crate::app_state::AppState, addr: &str, auth_type: &str) -> RehydrateOutcome {
    if auth_type != "mnemonic" {
        return RehydrateOutcome::NeedsActiveAccount(AuthCapabilities::OAuthOnly);
    }
    match keychain::load_mnemonic(addr) {
        KeychainResult::Found(mnemonic) => match crate::auth::login::rehydrate_full_session(state, mnemonic) {
            Ok(_) => {
                info!("Session fully restored from OS keychain — capability = Full");
                return RehydrateOutcome::AlreadyWritten;
            }
            Err(e) => warn!(error = %e, "Keychain mnemonic failed to derive keys; falling back to Restored"),
        },
        KeychainResult::NotFound => {
            // Expected for users without a keychain entry yet (first launch
            // since keychain integration shipped, or post-logout). The user
            // will see the "re-enter your seed phrase" CTA on signing.
        }
        KeychainResult::Unavailable(reason) => {
            warn!(reason = %reason, "OS keychain unavailable; falling back to Restored");
        }
    }
    RehydrateOutcome::NeedsActiveAccount(AuthCapabilities::Restored)
}

/// Result of session restoration, returned to the frontend for state setup.
///
/// The frontend reads localStorage (Rust can't), passes the OAuth data
/// to this command, and Rust makes all decisions about what's valid.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoreResult {
    pub authenticated: bool,
    pub substrate_address: Option<String>,
    pub auth_type: Option<String>,
    pub oauth_session: Option<serde_json::Value>,
    /// Milliseconds until logout. None = infinite / no timer.
    pub logout_time_ms: Option<i64>,
    /// Frontend should clear OAuth localStorage entries.
    pub should_clear_oauth: bool,
    /// true = initSync with mnemonic from Rust; false = initSync without mnemonic (or skip)
    pub needs_sync_mnemonic: bool,
    /// Where to navigate: "/" for home, "/login" for login, null for no navigation
    pub redirect_to: Option<String>,
}

/// Restore the user's session at app boot.
///
/// Replaces the 150-line boot cascade in `wallet-auth-context.tsx`.
/// The frontend reads localStorage OAuth data and passes it here.
/// Rust validates tokens, checks expiry, falls back to DB session,
/// and returns a structured result for the frontend to render.
#[tauri::command]
#[expect(
    clippy::too_many_lines,
    reason = "Linear multi-stage auth flow (OAuth JSON validation → DB fallback → result build). Splitting fragments the early-return error paths and has caused past regressions; auth_session_repo's inline unit tests cover the upsert/clear/COALESCE invariants."
)]
pub async fn restore_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    oauth_session_json: Option<String>,
    oauth_expiry_ms: Option<i64>,
) -> Result<SessionRestoreResult, AppError> {
    let pool = state.pool()?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    // ── Try OAuth session first ─────────────────────────────────────────
    if let (Some(json), Some(expiry)) = (&oauth_session_json, oauth_expiry_ms) {
        if now_ms < expiry {
            match serde_json::from_str::<serde_json::Value>(json) {
                Ok(session_data) => {
                    let substrate_address = session_data.get("substrateAddress").and_then(|v| v.as_str()).map(String::from);

                    // Validate token in Rust DB
                    if let Some(ref addr) = substrate_address {
                        let token_row = auth_session_repo::get_token_and_expiry(pool, addr).await?;
                        let token_valid = matches!(
                            token_row,
                            Some(TokenStatus { token: Some(_), expiry_ms: Some(exp) }) if exp > now_ms
                        );
                        if !token_valid {
                            info!("OAuth token expired in DB, clearing session");
                            return Ok(SessionRestoreResult {
                                authenticated: false,
                                substrate_address: None,
                                auth_type: None,
                                oauth_session: None,
                                logout_time_ms: None,
                                should_clear_oauth: true,
                                needs_sync_mnemonic: false,
                                redirect_to: Some("/login".into()),
                            });
                        }
                    }

                    let provider = session_data.get("provider").and_then(|v| v.as_str()).unwrap_or("oauth");
                    let auth_type = if provider == "mnemonic" { "mnemonic" } else { "oauth" };
                    let needs_mnemonic = provider != "mnemonic";

                    if let Some(ref addr) = substrate_address {
                        // For mnemonic users: try the OS keychain — if it
                        // has the seed phrase, fully rehydrate AuthInfo
                        // (capability = Full, signing works immediately).
                        // Otherwise fall back to Restored. For OAuth users:
                        // always OAuthOnly. The `AlreadyWritten` outcome
                        // means rehydrate already wrote `AuthInfo` and we
                        // must not double-write via `set_active_account`.
                        match rehydrate_or_restored(&state, addr, auth_type) {
                            RehydrateOutcome::AlreadyWritten => {
                                // Mnemonic is in AuthInfo — run encryption migration.
                                // Extract the mnemonic BEFORE awaiting (can't hold mutex across await).
                                if let Ok(pool) = state.pool() {
                                    let mnemonic_str = state.auth.lock().ok().and_then(|g| g.mnemonic.as_deref().map(String::from));
                                    if let Some(m) = mnemonic_str
                                        && let Err(e) = crate::crypto::store::migrate_if_needed(pool, &m, addr).await
                                    {
                                        warn!(error = %e, "Encryption migration failed — will retry on next login");
                                    }
                                }
                            }
                            RehydrateOutcome::NeedsActiveAccount(cap) => {
                                state.set_active_account(addr, cap)?;
                            }
                        }
                    }
                    info!("Restoring OAuth session for {:?}", substrate_address);
                    return Ok(SessionRestoreResult {
                        authenticated: true,
                        substrate_address,
                        auth_type: Some(auth_type.into()),
                        oauth_session: Some(session_data),
                        logout_time_ms: None, // OAuth uses server-side 30-day expiry
                        should_clear_oauth: false,
                        needs_sync_mnemonic: needs_mnemonic,
                        redirect_to: None,
                    });
                }
                Err(e) => {
                    info!("Failed to parse OAuth session JSON: {e}");
                    // Fall through to DB session
                }
            }
        } else {
            info!("OAuth session expired");
        }
        // OAuth expired or invalid — tell frontend to clear localStorage
    }

    let should_clear = oauth_session_json.is_some();

    // ── Fall back to Rust DB session ────────────────────────────────────
    let row = auth_session_repo::get_latest(pool).await?;

    let Some(row) = row else {
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: None,
        });
    };

    let Some(auth_token) = row.auth_token else {
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: None,
        });
    };

    // Check token expiry
    if let Some(expiry) = row.token_expiry
        && expiry > 0
        && expiry < now_ms
    {
        info!("DB session token expired, clearing");
        if let Some(ref addr) = row.substrate_address {
            let _ = auth_session_repo::clear(pool, addr).await;
        }
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: Some("/login".into()),
        });
    }

    // Valid session — build OAuth session object for frontend display
    let oauth_session = serde_json::json!({
        "token": auth_token,
        "userId": row.user_id.unwrap_or(0),
        "username": row.username.clone().unwrap_or_default(),
        "provider": row.provider.clone().unwrap_or_else(|| "mnemonic".into()),
        "expiresAt": row.token_expiry.and_then(|e| chrono::DateTime::from_timestamp_millis(e).map(|d| d.to_rfc3339())).unwrap_or_default(),
        "substrateAddress": row.substrate_address.clone(),
        "isNew": false,
    });

    let auth_type = if row.provider.as_deref() == Some("oauth") { "oauth" } else { "mnemonic" };
    let eff_minutes = row.logout_time_minutes.unwrap_or(1440);
    let logout_time_ms = if eff_minutes == -1 { None } else { Some(eff_minutes * 60_000) };

    if let Some(ref addr) = row.substrate_address {
        // Same flow as the OAuth-JSON branch above. See `rehydrate_or_restored`.
        match rehydrate_or_restored(&state, addr, auth_type) {
            RehydrateOutcome::AlreadyWritten => {
                // Mnemonic is in AuthInfo — run encryption migration.
                // Extract the mnemonic BEFORE awaiting (can't hold mutex across await).
                if let Ok(pool) = state.pool() {
                    let mnemonic_str = state.auth.lock().ok().and_then(|g| g.mnemonic.as_deref().map(String::from));
                    if let Some(m) = mnemonic_str
                        && let Err(e) = crate::crypto::store::migrate_if_needed(pool, &m, addr).await
                    {
                        warn!(error = %e, "Encryption migration failed — will retry on next login");
                    }
                }
            }
            RehydrateOutcome::NeedsActiveAccount(cap) => {
                state.set_active_account(addr, cap)?;
            }
        }
    }
    info!("Restoring DB session for {:?}", row.substrate_address);
    Ok(SessionRestoreResult {
        authenticated: true,
        substrate_address: row.substrate_address,
        auth_type: Some(auth_type.into()),
        oauth_session: Some(oauth_session),
        logout_time_ms,
        should_clear_oauth: should_clear,
        needs_sync_mnemonic: row.provider.as_deref() != Some("mnemonic"),
        redirect_to: Some("/".into()),
    })
}

/// Update the logout timeout preference (minutes). Pass -1 for "never expire".
#[tauri::command]
pub async fn update_logout_time(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    logout_time_minutes: i64,
) -> Result<(), AppError> {
    auth_session_repo::update_logout_time(state.pool()?, &account_id, logout_time_minutes).await
}

/// Server-side token expiry check. Returns `true` if the token exists
/// in `auth_session` and has not expired, `false` otherwise.
///
/// Used by the frontend's `useTokenValidation` hook to decide whether
/// to nudge the user to re-authenticate. Lives in `session_restore`
/// because it's a read-only inspection of session validity, the same
/// concern as `restore_session`.
#[tauri::command]
pub async fn is_token_valid(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<bool, AppError> {
    let row = auth_session_repo::get_token_and_expiry(state.pool()?, &account_id).await?;
    Ok(matches!(
        row,
        Some(TokenStatus { token: Some(_), expiry_ms: Some(expiry) })
            if expiry == 0 || expiry > chrono::Utc::now().timestamp_millis()
    ))
}
