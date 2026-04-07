//! Mnemonic-based login flow + small mnemonic utilities.
//!
//! This module owns the BIP-39 mnemonic login path: validate the phrase,
//! derive Substrate (sr25519) and Ethereum (secp256k1) keypairs, complete
//! the EIP-191 challenge-response with the Hippius API, and persist the
//! resulting session. The keypair is held in
//! [`crate::app_state::AppState::auth`] for subsequent extrinsic signing.
//!
//! Sibling modules:
//! - [`crate::auth::oauth`] — OAuth provider login
//! - [`crate::auth::logout`] — logout flow
//! - [`crate::auth::session_restore`] — restore session at app boot
//! - [`crate::auth::keychain`] — OS keychain backend for mnemonic persistence

use crate::auth::auth_session_repo::{self, UpsertSession};
use crate::auth::service::{challenge_response, derive_keys};
use crate::auth::tokens::save_api_token;
use crate::error::AppError;
use tracing::{info, warn};
use zeroize::Zeroizing;

/// Successful authentication result returned to the frontend after login or unlock.
///
/// Contains both blockchain addresses (Substrate SS58 + Ethereum), the API
/// session token, and user profile metadata. The frontend stores this in
/// Jotai atoms and uses the token for subsequent API calls.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub substrate_address: String,
    pub eth_address: String,
    pub user_id: serde_json::Value,
    pub username: String,
    pub provider: String,
    pub token: String,
    pub token_expiry: i64,
    pub is_new: bool,
}

/// Populate `AuthInfo` from a verified mnemonic — the shared write
/// path used by both `login_with_mnemonic` (fresh login) and
/// `session_restore::rehydrate_or_restored` (boot-time keychain restore).
///
/// Derives the sr25519 + secp256k1 keypairs, acquires the auth lock
/// once, writes all 5 fields atomically, and returns the substrate +
/// eth addresses for the caller to use in result construction.
///
/// Caller is responsible for everything else (challenge-response, DB
/// session upsert, API token persistence). This helper exists so the
/// keychain-restore path doesn't have to duplicate the AuthInfo write.
pub(crate) fn rehydrate_full_session(
    state: &crate::app_state::AppState,
    mnemonic: Zeroizing<String>,
) -> Result<(String, String), AppError> {
    let (sr25519_pair, substrate_address, _eth_signer, eth_address) = derive_keys(&mnemonic)?;

    let mut auth = state.auth.lock()?;
    auth.capabilities = crate::auth::state::AuthCapabilities::Full;
    auth.sr25519_pair = Some(sr25519_pair);
    auth.substrate_address = Some(substrate_address.clone());
    auth.eth_address = Some(eth_address.clone());
    auth.mnemonic = Some(mnemonic);

    Ok((substrate_address, eth_address))
}

/// Full mnemonic login: validate → derive keys → challenge-response → persist session.
///
/// The mnemonic is held in `Zeroizing` and cached in `AuthInfo.mnemonic`
/// for the session lifetime. The derived sr25519 keypair is held in
/// `AppState.auth` for subsequent signing operations (staking, transfers).
/// Also persisted to the OS keychain so returning users on this device
/// don't have to re-enter their seed phrase to sign extrinsics.
#[tauri::command]
pub async fn login_with_mnemonic(
    state: tauri::State<'_, crate::app_state::AppState>,
    mnemonic: String,
    referral_code: Option<String>,
    logout_time_minutes: Option<i64>,
) -> Result<LoginResult, AppError> {
    info!("Login initiated via mnemonic");
    let mnemonic = Zeroizing::new(mnemonic);

    // Run the challenge-response BEFORE writing AuthInfo, so a failed
    // login leaves the previous session intact.
    let (_sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(&mnemonic)?;
    let (token, user_id, username, is_new, token_expiry) =
        challenge_response(&state.api_client, &eth_signer, &eth_address, &substrate_address, referral_code.as_deref()).await?;

    // Now write the full AuthInfo via the shared rehydrate helper.
    rehydrate_full_session(&state, mnemonic.clone())?;

    let pool = state.pool()?;
    auth_session_repo::upsert(
        pool,
        UpsertSession {
            substrate_address: &substrate_address,
            token: &token,
            token_expiry_ms: token_expiry,
            user_id: user_id.as_i64(),
            username: &username,
            provider: "mnemonic",
            // Pass through whatever the caller provided. `None` means
            // "preserve the existing preference" via the repo's COALESCE
            // — defense in depth so a future caller passing `None` can't
            // accidentally clobber the user's logout-timeout setting.
            logout_time_minutes,
        },
    )
    .await?;

    save_api_token(pool, &substrate_address, &token).await?;

    // Persist the mnemonic in the OS keychain so returning users on
    // this device don't have to re-enter their seed phrase to sign
    // extrinsics. Failures are non-fatal — login still succeeds, the
    // user just gets the seed-phrase prompt on the next restart.
    if let Err(e) = crate::auth::keychain::store_mnemonic(&substrate_address, &mnemonic) {
        warn!(
            error = %e,
            "Failed to persist mnemonic to OS keychain — sign-after-restart will require re-entering seed phrase"
        );
    }

    info!(
        address = %substrate_address,
        is_new = is_new,
        "Mnemonic login successful"
    );

    Ok(LoginResult {
        substrate_address,
        eth_address,
        user_id,
        username,
        provider: "mnemonic".to_string(),
        token,
        token_expiry,
        is_new,
    })
}

/// Validates whether the given string is a valid BIP-39 mnemonic.
///
/// The input is zeroized after validation to prevent the mnemonic
/// from lingering in freed heap memory.
#[tauri::command]
pub fn validate_mnemonic(mnemonic: String) -> bool {
    let mnemonic = zeroize::Zeroizing::new(mnemonic);
    bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &mnemonic).is_ok()
}

/// Generate a new 12-word BIP-39 mnemonic.
#[tauri::command]
pub fn generate_mnemonic() -> Result<String, AppError> {
    use bip39::{Language, Mnemonic};
    let mnemonic = Mnemonic::generate_in(Language::English, 12).map_err(|e| AppError::Crypto(format!("Failed to generate mnemonic: {e}")))?;
    Ok(mnemonic.to_string())
}

/// Silently refresh the auth token using the mnemonic from the encrypted Drive.
///
/// Called when the sync engine detects a 401. No frontend round-trip needed
/// for mnemonic-based sessions.
#[tauri::command]
pub async fn refresh_auth_token(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
) -> Result<(), AppError> {
    crate::auth::service::refresh_auth_token_internal(state.pool()?, &app, &account_id).await?;
    Ok(())
}

/// Return the SS58 address for the currently authenticated session.
#[tauri::command]
pub fn get_polkadot_address(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Option<String>, AppError> {
    let auth = state.auth.lock()?;
    Ok(auth.substrate_address.clone())
}

/// Return the Ethereum address for the currently authenticated session.
#[tauri::command]
pub fn get_eth_address(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Option<String>, AppError> {
    let auth = state.auth.lock()?;
    Ok(auth.eth_address.clone())
}

#[cfg(test)]
mod tests {
    use super::validate_mnemonic;

    /// A well-known 12-word BIP-39 mnemonic (test vector from the BIP-39 spec).
    const VALID_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn validate_mnemonic_accepts_valid_12_word() {
        assert!(
            validate_mnemonic(VALID_MNEMONIC.to_string()),
            "Expected a valid 12-word BIP-39 mnemonic to be accepted"
        );
    }

    #[test]
    fn validate_mnemonic_rejects_garbage() {
        assert!(
            !validate_mnemonic("this is not a valid mnemonic at all xyzzy".to_string()),
            "Expected a garbage string to be rejected"
        );
    }
}
