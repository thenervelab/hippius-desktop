//! Authentication commands — mnemonic login, passcode lock/unlock, token refresh.
//!
//! All cryptographic operations (key derivation, signing, mnemonic encryption)
//! happen in Rust. The frontend never touches key material — it sends intents
//! ("login with this mnemonic", "unlock with this passcode") and gets back
//! a session result.
//!
//! The authentication flow uses Ethereum EIP-191 challenge-response signing
//! against the Hippius API. Both Substrate (sr25519) and Ethereum (secp256k1)
//! keypairs are derived from the same BIP-39 mnemonic. After authentication,
//! the sr25519 keypair is stored in [`crate::app_state::AppState::auth`] for
//! signing blockchain transactions (staking, transfers).
//!
//! Passcode-based unlock re-derives keys from an AES-encrypted mnemonic stored
//! in SQLite, using CryptoJS-compatible encryption for backward compatibility
//! with mnemonics encrypted by the earlier TypeScript implementation.

use crate::error::AppError;
use sha2::{Digest, Sha256};
use tracing::info;
use zeroize::Zeroizing;

use crate::auth_service::{challenge_response, derive_keys, persist_session};
use crate::utils::account_key::account_key;
use crate::utils::auth_tokens::save_api_token;

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
) -> Result<LoginResult, AppError> {
    info!("Login initiated via mnemonic");
    let mnemonic = Zeroizing::new(mnemonic);

    let (sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(&mnemonic)?;

    let (token, user_id, username, is_new, token_expiry) =
        challenge_response(&state.api_client, &eth_signer, &eth_address, &substrate_address, referral_code.as_deref()).await?;

    {
        let mut auth = state.auth.lock()?;
        auth.sr25519_pair = Some(sr25519_pair);
        auth.substrate_address = Some(substrate_address.clone());
        auth.eth_address = Some(eth_address.clone());
    }

    let pool = state.pool()?;
    let ltm = logout_time_minutes.unwrap_or(-1);
    persist_session(pool, &substrate_address, &token, token_expiry, &user_id, &username, "mnemonic", ltm).await?;

    save_api_token(pool, &substrate_address, &token).await?;

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
pub fn generate_mnemonic() -> Result<String, AppError> {
    use bip39::{Language, Mnemonic};
    let mnemonic = Mnemonic::generate_in(Language::English, 12).map_err(|e| AppError::Crypto(format!("Failed to generate mnemonic: {e}")))?;
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
) -> Result<(), AppError> {
    let mnemonic = Zeroizing::new(mnemonic);

    info!("Setting passcode for account");
    let passcode_hash = hash_passcode(&passcode);

    let encrypted = {
        use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};

        let salt: [u8; 8] = rand::random();
        let (key, iv) = crypto_js_derive_key_iv(passcode.as_bytes(), &salt);

        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
        let encryptor = Aes256CbcEnc::new(&key.into(), &iv.into());

        let plaintext = mnemonic.as_bytes();
        let mut buf = vec![0u8; plaintext.len() + 16];
        buf[..plaintext.len()].copy_from_slice(plaintext);
        let ciphertext = encryptor
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
            .map_err(|e| AppError::Crypto(format!("Encryption failed: {e}")))?;

        // CryptoJS format: "Salted__" + salt + ciphertext, base64-encoded
        let mut output = Vec::with_capacity(16 + ciphertext.len());
        output.extend_from_slice(b"Salted__");
        output.extend_from_slice(&salt);
        output.extend_from_slice(ciphertext);
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&output)
    };

    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r"
        INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            encrypted_mnemonic = excluded.encrypted_mnemonic,
            passcode_hash = excluded.passcode_hash,
            updated_at = datetime('now')
        ",
    )
    .bind(&owner)
    .bind(&encrypted)
    .bind(&passcode_hash)
    .execute(pool)
    .await?;

    Ok(())
}

/// CryptoJS-compatible key derivation (OpenSSL `EVP_BytesToKey` with MD5).
///
/// Produces a 32-byte AES key and 16-byte IV from a passphrase and salt
/// by repeatedly hashing with MD5. This matches the default key derivation
/// used by CryptoJS's `AES.encrypt`, ensuring backward compatibility with
/// mnemonics encrypted by the earlier TypeScript frontend.
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
///
/// Expects the CryptoJS wire format: base64("Salted__" + 8-byte salt + ciphertext).
fn decrypt_mnemonic_aes(encrypted: &str, passcode: &str) -> Result<String, AppError> {
    use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    use base64::Engine;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(encrypted)
        .map_err(|e| AppError::Crypto(format!("Base64 decode failed: {e}")))?;

    if raw.len() < 16 || &raw[..8] != b"Salted__" {
        return Err(AppError::Crypto("Invalid encrypted data format".into()));
    }

    let salt = &raw[8..16];
    let ciphertext = &raw[16..];

    let (key, iv) = crypto_js_derive_key_iv(passcode.as_bytes(), salt);

    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
    let decryptor = Aes256CbcDec::new(&key.into(), &iv.into());

    let mut buf = ciphertext.to_vec();
    let plaintext = decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| AppError::Auth("Decryption failed (wrong passcode?)".into()))?;

    String::from_utf8(plaintext.to_vec()).map_err(|e| AppError::Crypto(format!("Invalid UTF-8 after decrypt: {e}")))
}

/// Unlock with passcode: verify hash, decrypt mnemonic, derive keypair, restore session.
///
/// This is the returning-user flow: the encrypted mnemonic lives in SQLite's
/// `wallet_store` table. After verifying the passcode hash, the mnemonic is
/// decrypted, keys are derived, and a fresh API token is obtained via
/// challenge-response. The mnemonic is zeroized immediately after use.
#[tauri::command]
pub async fn unlock_with_passcode(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    passcode: String,
    logout_time_minutes: Option<i64>,
) -> Result<LoginResult, AppError> {
    info!("Passcode unlock initiated");
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (String, String)>("SELECT encrypted_mnemonic, passcode_hash FROM wallet_store WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::Auth("No wallet record found".into()))?;

    let (encrypted_mnemonic, stored_hash) = row;

    let passcode_hash = hash_passcode(&passcode);
    if passcode_hash != stored_hash {
        return Err(AppError::Auth("Incorrect passcode".into()));
    }

    let mnemonic = Zeroizing::new(decrypt_mnemonic_aes(&encrypted_mnemonic, &passcode)?);

    if bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &mnemonic).is_err() {
        return Err(AppError::Crypto("Decrypted mnemonic is invalid".into()));
    }

    let (sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(&mnemonic)?;

    let (token, user_id, username, is_new, token_expiry) =
        challenge_response(&state.api_client, &eth_signer, &eth_address, &substrate_address, None).await?;

    {
        let mut auth = state.auth.lock()?;
        auth.sr25519_pair = Some(sr25519_pair);
        auth.substrate_address = Some(substrate_address.clone());
        auth.eth_address = Some(eth_address.clone());
    }

    let ltm = logout_time_minutes.unwrap_or(1440);
    persist_session(pool, &substrate_address, &token, token_expiry, &user_id, &username, "mnemonic", ltm).await?;

    save_api_token(pool, &substrate_address, &token).await?;

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

/// Re-export so existing callers that still reference `commands::auth::refresh_auth_token_internal`
/// (e.g. the `#[tauri::command]` wrapper below) can reach the moved function.
pub(crate) use crate::auth_service::refresh_auth_token_internal;

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
    refresh_auth_token_internal(state.pool()?, &app, &account_id).await?;
    Ok(())
}

/// Logout: clear in-memory keypair and session.
///
/// Note: the frontend should call `stop_sync` separately before calling this.
#[tauri::command]
pub async fn auth_logout(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<(), AppError> {
    info!(account_id = %account_id, "Logout initiated");

    {
        let mut auth = state.auth.lock()?;
        auth.sr25519_pair = None;
        auth.substrate_address = None;
        auth.eth_address = None;
    }

    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r"
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
        ",
    )
    .bind(&owner)
    .execute(pool)
    .await?;

    info!("Logout complete");
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
