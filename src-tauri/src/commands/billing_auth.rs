//! Billing authentication via Ethereum challenge-response signing.
//!
//! Replaces the frontend's JavaScript-based billing auth flow so the BIP-39
//! mnemonic never needs to be stored in plaintext in the browser DB. The
//! mnemonic is retrieved from the encrypted HCFS Drive on disk, used
//! transiently to derive signing keys, then zeroized.

use alloy_signer::SignerSync;
use alloy_signer_local::coins_bip39::English;
use alloy_signer_local::{MnemonicBuilder, PrivateKeySigner};
use sp_core::Pair as _;
use zeroize::Zeroize;

use crate::commands::syncing::get_mnemonic_for_account;

const MAX_ATTEMPTS: u32 = 3;
const DEFAULT_BASE_URL: &str = "https://api.hippius.com";
const CHALLENGE_PATH: &str = "/api/auth/mnemonic/";
const VERIFY_PATH: &str = "/api/auth/verify/";

fn base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

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

fn derive_keys(mnemonic: &str) -> Result<(String, PrivateKeySigner, String), String> {
    let (sr25519_pair, _) =
        sp_core::sr25519::Pair::from_phrase(mnemonic, None).map_err(|e| format!("{e:?}"))?;
    let substrate_address = sp_core::crypto::Ss58Codec::to_ss58check(&sr25519_pair.public());

    let eth_signer: PrivateKeySigner = MnemonicBuilder::<English>::default()
        .phrase(mnemonic)
        .index(0)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let eth_address = format!("{}", eth_signer.address());

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
) -> Result<BillingAuthResult, String> {
    let pool = state.pool()?;
    let mut mnemonic = match mnemonic {
        Some(m) if !m.is_empty() => m,
        _ => get_mnemonic_for_account(pool, &account_id).await?,
    };

    // Derive keys from the mnemonic, then zeroize it immediately.
    // Using a scope + explicit zeroize (no catch_unwind / AssertUnwindSafe)
    // to avoid unsound assumptions about panic safety of third-party code.
    let derive_result = derive_keys(&mnemonic);
    mnemonic.zeroize();
    let (substrate_address, eth_signer, eth_address) = derive_result?;

    let client = reqwest::Client::new();
    let base = base_url();
    let challenge_url = format!("{base}{CHALLENGE_PATH}");
    let verify_url = format!("{base}{VERIFY_PATH}");

    let mut last_err = String::from("Billing auth failed");

    for _ in 0..MAX_ATTEMPTS {
        match attempt(
            &client,
            &challenge_url,
            &verify_url,
            &eth_signer,
            &eth_address,
            &substrate_address,
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(e) => last_err = e,
        }
    }

    Err(last_err)
}

async fn attempt(
    client: &reqwest::Client,
    challenge_url: &str,
    verify_url: &str,
    eth_signer: &PrivateKeySigner,
    eth_address: &str,
    substrate_address: &str,
) -> Result<BillingAuthResult, String> {
    // Request challenge
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
        .await
        .map_err(|e| format!("Challenge request failed: {e}"))?;

    if !challenge_res.status().is_success() {
        let status = challenge_res.status();
        let body = challenge_res.text().await.unwrap_or_default();
        return Err(format!("Challenge failed: {status} {body}"));
    }

    let cr: ChallengeResponse = challenge_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse challenge: {e}"))?;

    // Sign the message (EIP-191 personal_sign)
    let sig = eth_signer
        .sign_message_sync(cr.message.as_bytes())
        .map_err(|e| format!("Signing failed: {e}"))?;
    let formatted_sig = format!("{sig}");

    // Verify signature
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
        .await
        .map_err(|e| format!("Verify request failed: {e}"))?;

    if !verify_res.status().is_success() {
        let status = verify_res.status();
        let body = verify_res.text().await.unwrap_or_default();
        return Err(format!("Verify failed: {status} {body}"));
    }

    let vr: VerifyResponse = verify_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse verify response: {e}"))?;

    Ok(BillingAuthResult {
        token: vr.token,
        user_id: vr.user_id,
        username: vr.username,
    })
}
