//! Authentication commands — mnemonic login, passcode lock/unlock, token refresh.
//!
//! All cryptographic operations (key derivation, signing, mnemonic encryption)
//! happen in Rust. The frontend never touches key material — it sends intents
//! ("login with this mnemonic", "unlock with this passcode") and gets back
//! a session result.

use alloy_signer::SignerSync;
use alloy_signer_local::coins_bip39::English;
use alloy_signer_local::{MnemonicBuilder, PrivateKeySigner};
use sha2::{Digest, Sha256};
use sp_core::Pair as _;
use sp_core::crypto::Ss58Codec;
use tracing::{info, warn};
use zeroize::Zeroizing;

use crate::commands::syncing::get_mnemonic_for_account;
use crate::utils::account_key::account_key;
use crate::utils::auth_tokens::save_api_token;
use sqlx::sqlite::SqlitePool;
use tauri::Emitter;

const DEFAULT_BASE_URL: &str = "https://api.hippius.com";
const CHALLENGE_PATH: &str = "/api/auth/mnemonic/";
const VERIFY_PATH: &str = "/api/auth/verify/";

fn base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

// ── Types ──────────────────────────────────────────────────────────────

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

// ── Key Derivation ─────────────────────────────────────────────────────

fn derive_keys(
    mnemonic: &str,
) -> Result<(sp_core::sr25519::Pair, String, PrivateKeySigner, String), String> {
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

// ── Challenge-Response ─────────────────────────────────────────────────

async fn challenge_response(
    client: &reqwest::Client,
    eth_signer: &PrivateKeySigner,
    eth_address: &str,
    substrate_address: &str,
    referral_code: Option<&str>,
) -> Result<(String, serde_json::Value, String, bool, i64), String> {
    let base = base_url();

    // 1. Request challenge
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

    // 2. Sign the message (EIP-191 personal_sign)
    let sig = eth_signer
        .sign_message_sync(cr.message.as_bytes())
        .map_err(|e| format!("Signing failed: {e}"))?;
    let formatted_sig = format!("{sig}");

    // 3. Verify signature with backend
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

// ── Helper: persist session ────────────────────────────────────────────

async fn persist_session(
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
        r#"
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
        "#,
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

// ── Commands ───────────────────────────────────────────────────────────

/// Full mnemonic login: validate → derive keys → challenge-response → persist session.
///
/// The mnemonic is zeroized after key derivation. The derived keypair is held
/// in `AppState.auth` for subsequent signing operations (staking, transfers).
#[tauri::command]
pub async fn login_with_mnemonic(
    state: tauri::State<'_, crate::app_state::AppState>,
    mnemonic: String,
    referral_code: Option<String>,
    logout_time_minutes: Option<i64>,
) -> Result<LoginResult, String> {
    info!("Login initiated via mnemonic");
    let mnemonic = Zeroizing::new(mnemonic);

    // 1. Derive keys (mnemonic auto-zeroized on drop)
    let (sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(&mnemonic)?;

    // 2. Challenge-response auth
    let (token, user_id, username, is_new, token_expiry) = challenge_response(
        &state.api_client,
        &eth_signer,
        &eth_address,
        &substrate_address,
        referral_code.as_deref(),
    )
    .await?;

    // 3. Store keypair in AppState.auth
    {
        let mut auth = state
            .auth
            .lock()
            .map_err(|e| format!("Auth state lock failed: {e}"))?;
        auth.sr25519_pair = Some(sr25519_pair);
        auth.substrate_address = Some(substrate_address.clone());
        auth.eth_address = Some(eth_address.clone());
    }

    // 4. Persist session in DB
    let pool = state.pool()?;
    let ltm = logout_time_minutes.unwrap_or(-1);
    persist_session(
        pool,
        &substrate_address,
        &token,
        token_expiry,
        &user_id,
        &username,
        "mnemonic",
        ltm,
    )
    .await?;

    // 5. Persist API token for sync engine
    save_api_token(pool, &substrate_address, &token)
        .await
        .map_err(|e| format!("Failed to persist API token: {e}"))?;

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

/// Validate a BIP-39 mnemonic without performing any auth.
#[tauri::command]
pub fn validate_mnemonic(mnemonic: String) -> bool {
    bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &mnemonic).is_ok()
}

/// Generate a new 12-word BIP-39 mnemonic.
#[tauri::command]
pub fn generate_mnemonic() -> Result<String, String> {
    use bip39::{Language, Mnemonic};
    let mnemonic = Mnemonic::generate_in(Language::English, 12)
        .map_err(|e| format!("Failed to generate mnemonic: {e}"))?;
    Ok(mnemonic.to_string())
}

/// Hash a passcode with SHA-256 (matches frontend's `hashPasscode`).
fn hash_passcode(passcode: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(passcode.as_bytes());
    hex::encode(hasher.finalize())
}

/// Set a passcode: hash it, AES-encrypt the mnemonic, store in wallet_store.
///
/// The mnemonic comes from the in-memory session (via `get_drive_mnemonic`)
/// or is passed directly during initial setup.
#[tauri::command]
pub async fn set_passcode(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    passcode: String,
    mnemonic: String,
) -> Result<(), String> {
    let mnemonic = Zeroizing::new(mnemonic);

    info!("Setting passcode for account");
    let passcode_hash = hash_passcode(&passcode);

    // AES encrypt using the same method as crypto-js:
    // For compatibility with the existing frontend encrypted mnemonics,
    // we use the same CryptoJS-compatible AES encryption.
    // However, since new passcodes will only be verified in Rust going forward,
    // we use a simpler approach: just store the encrypted data.
    let encrypted = {
        use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};

        // CryptoJS key derivation: single MD5 of passphrase → key + IV
        // For forward-compatibility, use SHA-256 and a random salt
        let salt: [u8; 8] = rand::random();
        let (key, iv) = crypto_js_derive_key_iv(passcode.as_bytes(), &salt);

        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
        let encryptor = Aes256CbcEnc::new(&key.into(), &iv.into());

        let plaintext = mnemonic.as_bytes();
        let mut buf = vec![0u8; plaintext.len() + 16]; // padding room
        buf[..plaintext.len()].copy_from_slice(plaintext);
        let ciphertext = encryptor
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
            .map_err(|e| format!("Encryption failed: {e}"))?;

        // CryptoJS format: "Salted__" + salt + ciphertext, base64-encoded
        let mut output = Vec::with_capacity(16 + ciphertext.len());
        output.extend_from_slice(b"Salted__");
        output.extend_from_slice(&salt);
        output.extend_from_slice(ciphertext);
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&output)
    };

    // mnemonic is auto-zeroized on drop via Zeroizing wrapper

    // Store in wallet_store
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r#"
        INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            encrypted_mnemonic = excluded.encrypted_mnemonic,
            passcode_hash = excluded.passcode_hash,
            updated_at = datetime('now')
        "#,
    )
    .bind(&owner)
    .bind(&encrypted)
    .bind(&passcode_hash)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save wallet: {e}"))?;

    Ok(())
}

/// CryptoJS-compatible key derivation (EVP_BytesToKey with MD5).
///
/// CryptoJS uses OpenSSL's EVP_BytesToKey with MD5 to derive a 32-byte key
/// and 16-byte IV from a passphrase and salt.
fn crypto_js_derive_key_iv(passphrase: &[u8], salt: &[u8]) -> ([u8; 32], [u8; 16]) {
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];
    let mut derived = Vec::new();
    let mut prev_block: Vec<u8> = Vec::new();

    while derived.len() < 48 {
        let mut ctx = md5::Context::new();
        if !prev_block.is_empty() {
            ctx.consume(&prev_block);
        }
        ctx.consume(passphrase);
        ctx.consume(salt);
        prev_block = ctx.compute().to_vec();
        derived.extend_from_slice(&prev_block);
    }

    key.copy_from_slice(&derived[..32]);
    iv.copy_from_slice(&derived[32..48]);
    (key, iv)
}

/// Decrypt a CryptoJS-AES encrypted mnemonic with a passcode.
fn decrypt_mnemonic_aes(encrypted: &str, passcode: &str) -> Result<String, String> {
    use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    use base64::Engine;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(encrypted)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    // CryptoJS format: "Salted__" (8 bytes) + salt (8 bytes) + ciphertext
    if raw.len() < 16 || &raw[..8] != b"Salted__" {
        return Err("Invalid encrypted data format".to_string());
    }

    let salt = &raw[8..16];
    let ciphertext = &raw[16..];

    let (key, iv) = crypto_js_derive_key_iv(passcode.as_bytes(), salt);

    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
    let decryptor = Aes256CbcDec::new(&key.into(), &iv.into());

    let mut buf = ciphertext.to_vec();
    let plaintext = decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "Decryption failed (wrong passcode?)".to_string())?;

    String::from_utf8(plaintext.to_vec()).map_err(|e| format!("Invalid UTF-8 after decrypt: {e}"))
}

/// Unlock with passcode: verify hash, decrypt mnemonic, derive keypair, restore session.
#[tauri::command]
pub async fn unlock_with_passcode(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    passcode: String,
    logout_time_minutes: Option<i64>,
) -> Result<LoginResult, String> {
    info!("Passcode unlock initiated");
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    // 1. Fetch wallet record
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT encrypted_mnemonic, passcode_hash FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch wallet: {e}"))?
    .ok_or("No wallet record found")?;

    let (encrypted_mnemonic, stored_hash) = row;

    // 2. Verify passcode hash
    let passcode_hash = hash_passcode(&passcode);
    if passcode_hash != stored_hash {
        return Err("Incorrect passcode".to_string());
    }

    // 3. Decrypt mnemonic (auto-zeroized on drop)
    let mnemonic = Zeroizing::new(decrypt_mnemonic_aes(&encrypted_mnemonic, &passcode)?);

    // 4. Validate mnemonic
    if bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &mnemonic).is_err() {
        return Err("Decrypted mnemonic is invalid".to_string());
    }

    // 5. Derive keys (mnemonic auto-zeroized on drop)
    let (sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(&mnemonic)?;

    // 6. Challenge-response auth to get a fresh token
    let (token, user_id, username, is_new, token_expiry) = challenge_response(
        &state.api_client,
        &eth_signer,
        &eth_address,
        &substrate_address,
        None,
    )
    .await?;

    // 7. Store keypair in AppState.auth
    {
        let mut auth = state
            .auth
            .lock()
            .map_err(|e| format!("Auth state lock failed: {e}"))?;
        auth.sr25519_pair = Some(sr25519_pair);
        auth.substrate_address = Some(substrate_address.clone());
        auth.eth_address = Some(eth_address.clone());
    }

    // 8. Persist session
    let ltm = logout_time_minutes.unwrap_or(1440);
    persist_session(
        pool,
        &substrate_address,
        &token,
        token_expiry,
        &user_id,
        &username,
        "mnemonic",
        ltm,
    )
    .await?;

    // 9. Persist API token for sync engine
    save_api_token(pool, &substrate_address, &token)
        .await
        .map_err(|e| format!("Failed to persist API token: {e}"))?;

    info!(address = %substrate_address, "Passcode unlock successful");

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

/// Internal implementation for token refresh, callable from both the Tauri
/// command and the sync loop (which only has an AppHandle, not tauri::State).
pub async fn refresh_auth_token_internal(
    pool: &SqlitePool,
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<(), String> {
    info!(account_id = %account_id, "Auth token refresh started");
    // Block sync during token refresh to avoid 401 races
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();
    let _guard = crate::sync_engine::TokenRefreshGuard::new(sync);

    // 1. Get mnemonic from Drive (auto-zeroized on drop)
    let app_state = app.state::<crate::app_state::AppState>();
    let mnemonic = Zeroizing::new(get_mnemonic_for_account(&app_state, account_id).await?);

    // 2. Derive keys
    let (_sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(&mnemonic)?;

    // 3. Challenge-response
    let (token, user_id, username, _is_new, token_expiry) = challenge_response(
        &app_state.api_client,
        &eth_signer,
        &eth_address,
        &substrate_address,
        None,
    )
    .await?;

    // 4. Persist new session
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

    // 5. Persist API token for sync engine
    save_api_token(pool, &substrate_address, &token)
        .await
        .map_err(|e| format!("Failed to persist API token: {e}"))?;

    // 6. Update live drive's bearer token
    if let Err(e) =
        crate::commands::syncing::update_sync_bearer_token_internal(&app_state, account_id, &token)
            .await
    {
        warn!("Could not update live drive token: {e}");
    }

    info!(address = %substrate_address, "Auth token refreshed");

    // 7. Emit event to frontend
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

/// Silently refresh the auth token using the mnemonic from the encrypted Drive.
///
/// Called when the sync engine detects a 401. No frontend round-trip needed
/// for mnemonic-based sessions.
#[tauri::command]
pub async fn refresh_auth_token(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
) -> Result<(), String> {
    refresh_auth_token_internal(state.pool()?, &app, &account_id).await
}

/// Logout: clear in-memory keypair and session.
///
/// Note: the frontend should call `stop_sync` separately before calling this.
#[tauri::command]
pub async fn auth_logout(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<(), String> {
    info!(account_id = %account_id, "Logout initiated");

    // 1. Clear auth info
    {
        let mut auth = state
            .auth
            .lock()
            .map_err(|e| format!("Auth state lock failed: {e}"))?;
        auth.sr25519_pair = None;
        auth.substrate_address = None;
        auth.eth_address = None;
    }

    // 3. Clear session in DB (preserves logout_time_minutes)
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r#"
        UPDATE auth_session SET
            auth_token = NULL,
            token_expiry = NULL,
            user_id = NULL,
            username = NULL,
            provider = NULL,
            substrate_address = NULL,
            last_login_at = NULL,
            updated_at = datetime('now')
        WHERE owner = ?
        "#,
    )
    .bind(&owner)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to clear auth session: {e}"))?;

    info!("Logout complete");
    Ok(())
}

/// Return the SS58 address for the currently authenticated session.
#[tauri::command]
pub fn get_polkadot_address(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<Option<String>, String> {
    let auth = state
        .auth
        .lock()
        .map_err(|e| format!("Auth state lock failed: {e}"))?;
    Ok(auth.substrate_address.clone())
}

/// Return the Ethereum address for the currently authenticated session.
#[tauri::command]
pub fn get_eth_address(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<Option<String>, String> {
    let auth = state
        .auth
        .lock()
        .map_err(|e| format!("Auth state lock failed: {e}"))?;
    Ok(auth.eth_address.clone())
}
