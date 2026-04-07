//! Billing authentication via Ethereum challenge-response signing.
//!
//! Replaces the frontend's JavaScript-based billing auth flow so the BIP-39
//! mnemonic never needs to be stored in plaintext in the browser DB. The
//! mnemonic is retrieved from the encrypted HCFS Drive on disk, used
//! transiently to derive signing keys, then zeroized.
//!
//! Unlike [`super::auth`] which persists a full session, this module returns
//! only a short-lived token for billing API calls. It also retries up to
//! [`MAX_ATTEMPTS`] times to handle transient network failures.

use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use zeroize::Zeroize;

use crate::auth::service::{base_url, CHALLENGE_PATH, VERIFY_PATH};
use crate::auth::tokens::{get_api_token, save_api_token};
use crate::sync::mnemonic::get_mnemonic_for_account;
use tracing::{info, warn};

const MAX_ATTEMPTS: u32 = 3;

/// Short-lived billing auth result containing only the token and user info.
///
/// Unlike [`super::auth::LoginResult`], this omits addresses and session
/// metadata since billing auth is a one-shot operation.
#[derive(serde::Serialize, Clone)]
pub struct BillingAuthResult {
    pub token: String,
    pub user_id: serde_json::Value,
    pub username: String,
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
}

/// Derives billing keys from a mnemonic.
///
/// Delegates to [`crate::auth::service::derive_keys`] and discards the
/// sr25519 keypair (not needed for billing authentication).
fn derive_keys(mnemonic: &str) -> Result<(String, PrivateKeySigner, String), crate::error::AppError> {
    let (_pair, substrate_address, eth_signer, eth_address) =
        crate::auth::service::derive_keys(mnemonic)
            .map_err(crate::error::AppError::Crypto)?;
    Ok((substrate_address, eth_signer, eth_address))
}

/// Perform Ethereum challenge-response auth against the billing API.
///
/// 1. Retrieves the mnemonic from the encrypted Drive (or uses the one provided)
/// 2. Derives sr25519 (Substrate) and secp256k1 (Ethereum) keypairs
/// 3. Zeroizes the mnemonic
/// 4. Requests a challenge, signs it with the Ethereum key
/// 5. Verifies the signature and returns the auth token
///
/// `mnemonic` — optional plaintext mnemonic for use during initial login
/// before the HCFS Drive is set up. If omitted, the mnemonic is read from
/// the encrypted Drive on disk.
#[tauri::command]
pub async fn billing_auth(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    mnemonic: Option<String>,
) -> Result<BillingAuthResult, crate::error::AppError> {
    info!("Billing auth initiated");
    let mut mnemonic = match mnemonic {
        Some(m) if !m.is_empty() => m,
        _ => {
            let z = get_mnemonic_for_account(&state, &account_id).await?;
            (*z).clone()
        }
    };

    let derive_result = derive_keys(&mnemonic);
    mnemonic.zeroize();
    let (substrate_address, eth_signer, eth_address) = derive_result?;

    let client = state.api_client.clone();
    let base = base_url();
    let challenge_url = format!("{base}{CHALLENGE_PATH}");
    let verify_url = format!("{base}{VERIFY_PATH}");

    let mut last_err = crate::error::AppError::Auth("Billing auth failed".into());

    for _ in 0..MAX_ATTEMPTS {
        match attempt(&client, &challenge_url, &verify_url, &eth_signer, &eth_address, &substrate_address).await {
            Ok(result) => {
                info!("Billing auth successful");
                return Ok(result);
            }
            Err(e) => last_err = e,
        }
    }

    Err(last_err)
}

/// Execute a single challenge-response attempt against the billing API.
async fn attempt(
    client: &reqwest::Client,
    challenge_url: &str,
    verify_url: &str,
    eth_signer: &PrivateKeySigner,
    eth_address: &str,
    substrate_address: &str,
) -> Result<BillingAuthResult, crate::error::AppError> {
    let challenge_res = client
        .post(challenge_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .json(&serde_json::json!({
            "address": eth_address,
            "substrate_address": substrate_address,
        }))
        .send()
        .await?;

    if !challenge_res.status().is_success() {
        let status = challenge_res.status();
        let body = challenge_res.text().await.unwrap_or_default();
        warn!(status = %status, "Challenge request failed: {body}");
        return Err(crate::error::AppError::Api {
            status: status.as_u16(),
            body,
        });
    }

    let cr: ChallengeResponse = challenge_res.json().await?;

    let sig = eth_signer
        .sign_message_sync(cr.message.as_bytes())
        .map_err(|e| crate::error::AppError::Crypto(format!("Signing failed: {e}")))?;
    let formatted_sig = format!("{sig}");

    let verify_res = client
        .post(verify_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .json(&serde_json::json!({
            "signature": formatted_sig,
            "address": eth_address,
            "substrate_address": substrate_address,
            "challenge": cr.challenge,
            "referral_code": "",
            "session_data": {
                "challenge": cr.challenge,
                "address": eth_address,
            },
        }))
        .send()
        .await?;

    if !verify_res.status().is_success() {
        let status = verify_res.status();
        let body = verify_res.text().await.unwrap_or_default();
        warn!(status = %status, "Verify request failed: {body}");
        return Err(crate::error::AppError::Api {
            status: status.as_u16(),
            body,
        });
    }

    let vr: VerifyResponse = verify_res.json().await?;

    Ok(BillingAuthResult {
        token: vr.token,
        user_id: vr.user_id,
        username: vr.username,
    })
}

/// Ensure a billing auth token exists for this account.
///
/// If a valid token already exists in the DB, returns immediately. Otherwise
/// performs the full challenge-response auth and persists the new token.
/// This replaces the frontend `ensureBillingAuth()` orchestration that was
/// chaining `get_auth_token` → `billing_auth` → `save_auth_session`.
#[tauri::command]
pub async fn ensure_billing_auth(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<(), crate::error::AppError> {
    let pool = state.pool()?;

    let config = crate::sync::config::get_hcfs_config_internal(pool, &account_id).await;
    match config {
        Ok(c) if c.has_password => {}
        _ => return Ok(()),
    }

    if let Some(token) = get_api_token(pool, &account_id).await?
        && !token.is_empty()
    {
        return Ok(());
    }

    // No token — perform billing auth and persist. Unwrap the Zeroizing
    // wrapper into a plain `mut String` so we can call `.zeroize()` after
    // key derivation; the original `Zeroizing` wrapper is dropped here,
    // wiping the intermediate copy.
    info!("No existing billing auth token, performing challenge-response");
    let mnemonic_z = get_mnemonic_for_account(&state, &account_id).await?;
    let mut mnemonic = (*mnemonic_z).clone();
    drop(mnemonic_z);
    let derive_result = derive_keys(&mnemonic);
    mnemonic.zeroize();
    let (substrate_address, eth_signer, eth_address) = derive_result?;

    let client = state.api_client.clone();
    let base = base_url();
    let challenge_url = format!("{base}{CHALLENGE_PATH}");
    let verify_url = format!("{base}{VERIFY_PATH}");

    let mut last_err = crate::error::AppError::Auth("Billing auth failed".into());
    let mut result = None;
    for _ in 0..MAX_ATTEMPTS {
        match attempt(&client, &challenge_url, &verify_url, &eth_signer, &eth_address, &substrate_address).await {
            Ok(r) => {
                result = Some(r);
                break;
            }
            Err(e) => last_err = e,
        }
    }
    let result = result.ok_or(last_err)?;

    save_api_token(pool, &account_id, &result.token)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Failed to persist billing auth token: {e}")))?;

    // Token expiry: 30 days from now. The server doesn't include expiry in
    // the response, so we assume 30 days to match the auth service's default.
    // If the server changes its token lifetime, this should be updated.
    let token_expiry = chrono::Utc::now().timestamp_millis() + 30_i64 * 24 * 60 * 60 * 1000;
    crate::auth::auth_session_repo::upsert(
        pool,
        crate::auth::auth_session_repo::UpsertSession {
            substrate_address: &account_id,
            token: &result.token,
            token_expiry_ms: token_expiry,
            user_id: result.user_id.as_i64(),
            username: &result.username,
            provider: "mnemonic",
            logout_time_minutes: None, // billing auth refresh — don't touch the user's preference
        },
    )
    .await
    .map_err(|e| crate::error::AppError::Other(format!("Failed to persist billing auth session: {e}")))?;

    info!("Billing auth token persisted for {account_id}");
    Ok(())
}
