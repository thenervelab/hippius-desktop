//! Core authentication logic shared between Tauri commands and the sync engine.
//!
//! Extracted from `commands/auth.rs` so that `hcfs_drive.rs` can refresh tokens
//! without importing the IPC layer.

use alloy_signer::SignerSync;
use alloy_signer_local::coins_bip39::English;
use alloy_signer_local::{MnemonicBuilder, PrivateKeySigner};
use sqlx::sqlite::SqlitePool;
use tauri::Emitter;
use tracing::{info, warn};
use zeroize::Zeroizing;

use crate::commands::syncing::get_mnemonic_for_account;
use crate::utils::account_key::account_key;
use crate::utils::auth_tokens::save_api_token;

const DEFAULT_BASE_URL: &str = "https://api.hippius.com";
const CHALLENGE_PATH: &str = "/api/auth/mnemonic/";
const VERIFY_PATH: &str = "/api/auth/verify/";

fn base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

#[derive(serde::Deserialize)]
struct ChallengeResponse {
    challenge: String,
    message: String,
}

#[derive(serde::Deserialize)]
struct VerifyResponse {
    token: String,
    user_id: serde_json::Value,
    username: String,
    #[serde(default)]
    is_new: bool,
}

/// Derive both Substrate (sr25519) and Ethereum (secp256k1) keypairs from a
/// BIP-39 mnemonic. Returns both keypairs and their formatted addresses.
pub(crate) fn derive_keys(
    mnemonic: &str,
) -> Result<(sp_core::sr25519::Pair, String, PrivateKeySigner, String), String> {
    use sp_core::Pair as _;
    use sp_core::crypto::Ss58Codec;

    let (sr25519_pair, _) =
        sp_core::sr25519::Pair::from_phrase(mnemonic, None).map_err(|e| format!("{e:?}"))?;
    let substrate_address = sr25519_pair.public().to_ss58check();

    let eth_signer: PrivateKeySigner = MnemonicBuilder::<English>::default()
        .phrase(mnemonic)
        .index(0)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let eth_address = format!("{}", eth_signer.address());

    Ok((sr25519_pair, substrate_address, eth_signer, eth_address))
}

/// Execute the two-step challenge-response authentication against the Hippius API.
///
/// 1. POST to `/api/auth/mnemonic/` with addresses to receive a challenge
/// 2. Sign the challenge message with the Ethereum key (EIP-191 personal_sign)
/// 3. POST to `/api/auth/verify/` with the signature to receive a session token
pub(crate) async fn challenge_response(
    client: &reqwest::Client,
    eth_signer: &PrivateKeySigner,
    eth_address: &str,
    substrate_address: &str,
    referral_code: Option<&str>,
) -> Result<(String, serde_json::Value, String, bool, i64), String> {
    let base = base_url();

    let challenge_res = client
        .post(format!("{base}{CHALLENGE_PATH}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .json(&serde_json::json!({
            "address": eth_address,
            "substrate_address": substrate_address,
        }))
        .send()
        .await
        .map_err(|e| format!("Challenge request failed: {e}"))?;

    if !challenge_res.status().is_success() {
        let status = challenge_res.status();
        let body = challenge_res.text().await.unwrap_or_default();
        warn!(status = %status, "Challenge request failed: {body}");
        return Err(format!(
            "Authentication failed (HTTP {status}). Please try again."
        ));
    }

    let cr: ChallengeResponse = challenge_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse challenge: {e}"))?;

    let sig = eth_signer
        .sign_message_sync(cr.message.as_bytes())
        .map_err(|e| format!("Signing failed: {e}"))?;
    let formatted_sig = format!("{sig}");

    let verify_res = client
        .post(format!("{base}{VERIFY_PATH}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .json(&serde_json::json!({
            "signature": formatted_sig,
            "address": eth_address,
            "substrate_address": substrate_address,
            "challenge": cr.challenge,
            "referral_code": referral_code.unwrap_or(""),
            "session_data": {
                "challenge": cr.challenge,
                "address": eth_address,
            },
        }))
        .send()
        .await
        .map_err(|e| format!("Verify request failed: {e}"))?;

    if !verify_res.status().is_success() {
        let status = verify_res.status();
        let body = verify_res.text().await.unwrap_or_default();
        warn!(status = %status, "Verify request failed: {body}");
        return Err(format!(
            "Authentication failed (HTTP {status}). Please try again."
        ));
    }

    let vr: VerifyResponse = verify_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse verify response: {e}"))?;

    // Token expires in 30 days (matching frontend authService behavior)
    let token_expiry = chrono::Utc::now().timestamp_millis() + 30 * 24 * 60 * 60 * 1000;

    Ok((vr.token, vr.user_id, vr.username, vr.is_new, token_expiry))
}

/// Upsert the auth session row in SQLite so it survives app restarts.
///
/// Uses `ON CONFLICT` to update existing sessions. The `logout_time_minutes`
/// field is preserved via `COALESCE` when the new value is NULL, so a
/// token refresh does not reset the user's timeout preference.
#[expect(clippy::too_many_arguments)] // bundling into struct deferred to Phase 4
pub(crate) async fn persist_session(
    pool: &SqlitePool,
    substrate_address: &str,
    token: &str,
    token_expiry: i64,
    user_id: &serde_json::Value,
    username: &str,
    provider: &str,
    logout_time_minutes: i64,
) -> Result<(), String> {
    let owner = account_key(substrate_address);

    let user_id_i64 = user_id.as_i64();

    sqlx::query(
        r"
        INSERT INTO auth_session (
            owner, auth_token, token_expiry, user_id, username,
            provider, substrate_address, logout_time_minutes,
            last_login_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            auth_token = excluded.auth_token,
            token_expiry = excluded.token_expiry,
            user_id = excluded.user_id,
            username = excluded.username,
            provider = excluded.provider,
            substrate_address = excluded.substrate_address,
            logout_time_minutes = COALESCE(excluded.logout_time_minutes, auth_session.logout_time_minutes),
            last_login_at = excluded.last_login_at,
            updated_at = datetime('now')
        ",
    )
    .bind(&owner)
    .bind(token)
    .bind(token_expiry)
    .bind(user_id_i64)
    .bind(username)
    .bind(provider)
    .bind(substrate_address)
    .bind(logout_time_minutes)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save auth session: {e}"))?;

    Ok(())
}

/// Internal implementation for token refresh, callable from both the Tauri
/// command and the sync loop (which only has an AppHandle, not tauri::State).
///
/// Acquires a [`crate::sync_engine::TokenRefreshGuard`] to pause sync while
/// the token is being replaced, preventing 401 races.
pub(crate) async fn refresh_auth_token_internal(
    pool: &SqlitePool,
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<(), String> {
    info!(account_id = %account_id, "Auth token refresh started");
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();
    let _guard = crate::sync_engine::TokenRefreshGuard::new(sync);

    let app_state = app.state::<crate::app_state::AppState>();
    let mnemonic = Zeroizing::new(get_mnemonic_for_account(&app_state, account_id).await?);

    let (_sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(&mnemonic)?;

    let (token, user_id, username, _is_new, token_expiry) =
        challenge_response(
            &app_state.api_client,
            &eth_signer,
            &eth_address,
            &substrate_address,
            None,
        )
        .await?;

    persist_session(
        pool,
        &substrate_address,
        &token,
        token_expiry,
        &user_id,
        &username,
        "mnemonic",
        -1,
    )
    .await?;

    save_api_token(pool, &substrate_address, &token)
        .await
        .map_err(|e| format!("Failed to persist API token: {e}"))?;

    if let Err(e) = app_state
        .sync
        .update_bearer_token(pool, account_id, &token)
        .await
    {
        warn!("Could not update live drive token: {e}");
    }

    info!(address = %substrate_address, "Auth token refreshed");

    if let Err(e) = app.emit(
        "auth_token_refreshed",
        serde_json::json!({
            "substrateAddress": substrate_address,
        }),
    ) {
        warn!(error = %e, "Failed to emit auth_token_refreshed");
    }

    Ok(())
}
