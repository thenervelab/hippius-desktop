//! Authenticated encryption for sensitive SQLite columns.
//!
//! Uses HKDF-SHA256 for key derivation from the master BIP-39 mnemonic and
//! ChaCha20-Poly1305 (AEAD) for encryption. Each encrypted value is stored as
//! `base64(nonce[12] || ciphertext || tag[16])`.

use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::Aead};
use hkdf::Hkdf;
use sha2::Sha256;
use sqlx::sqlite::SqlitePool;
use tracing::info;
use zeroize::Zeroizing;

/// HKDF info string for key separation (drive-password encryption).
pub const INFO_DRIVE_PASSWORD: &str = "hippius-drive-password-encryption";

/// Minimum length of `base64(nonce[12] || tag[16])` — no ciphertext.
const MIN_DECODED_LEN: usize = 12 + 16;

/// Derives a 256-bit encryption key from a BIP-39 mnemonic.
///
/// Uses HKDF-SHA256 with the account ID as salt and a purpose string as
/// info, producing independent keys for different data classes.
/// The returned key is wrapped in [`Zeroizing`] for automatic wipe on drop.
///
/// # Errors
///
/// Returns [`crate::error::AppError::Crypto`] if `mnemonic` is not a valid
/// BIP-39 mnemonic. This can happen when the stored mnemonic is corrupted.
pub fn derive_key(mnemonic: &str, account_id: &str, info: &str) -> Result<Zeroizing<[u8; 32]>, crate::error::AppError> {
    let parsed =
        bip39::Mnemonic::parse_normalized(mnemonic).map_err(|e| crate::error::AppError::Crypto(format!("invalid mnemonic in derive_key: {e}")))?;
    // Wrap the 64-byte seed so it is wiped from the stack on drop.
    let seed = Zeroizing::new(parsed.to_seed(""));

    let hk = Hkdf::<Sha256>::new(Some(account_id.as_bytes()), seed.as_ref());
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), okm.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    Ok(okm)
}

/// Derives the drive-password encryption key for the given mnemonic and account.
///
/// # Errors
///
/// Returns [`crate::error::AppError::Crypto`] if `mnemonic` is not a valid BIP-39 mnemonic.
pub fn drive_password_key(mnemonic: &str, account_id: &str) -> Result<Zeroizing<[u8; 32]>, crate::error::AppError> {
    derive_key(mnemonic, account_id, INFO_DRIVE_PASSWORD)
}

/// Encrypts a plaintext string with ChaCha20-Poly1305.
///
/// Returns `base64(nonce[12] || ciphertext || tag[16])`.
/// A fresh random 12-byte nonce is generated for each call.
pub fn encrypt(key: &[u8; 32], plaintext: &str) -> Result<String, crate::error::AppError> {
    use base64::Engine;
    use chacha20poly1305::AeadCore;
    use chacha20poly1305::aead::OsRng;

    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| crate::error::AppError::Crypto(format!("encryption failed: {e}")))?;

    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&ciphertext);

    Ok(base64::engine::general_purpose::STANDARD.encode(&combined))
}

/// Decrypts a value previously encrypted by [`encrypt`].
///
/// Expects `base64(nonce[12] || ciphertext || tag[16])`.
/// Returns the plaintext wrapped in [`Zeroizing`] for automatic memory wipe.
pub fn decrypt(key: &[u8; 32], encoded: &str) -> Result<Zeroizing<String>, crate::error::AppError> {
    use base64::Engine;

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| crate::error::AppError::Crypto(format!("invalid base64: {e}")))?;

    if decoded.len() < MIN_DECODED_LEN {
        return Err(crate::error::AppError::Crypto(format!(
            "ciphertext too short: {} bytes (minimum {})",
            decoded.len(),
            MIN_DECODED_LEN
        )));
    }

    let (nonce_bytes, ciphertext) = decoded.split_at(12);
    let nonce = chacha20poly1305::Nonce::from_slice(nonce_bytes);
    let cipher = ChaCha20Poly1305::new(key.into());

    let plaintext_bytes = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| crate::error::AppError::Crypto("decryption failed — wrong key or corrupted data".into()))?;

    let plaintext =
        String::from_utf8(plaintext_bytes).map_err(|e| crate::error::AppError::Crypto(format!("decrypted data is not valid UTF-8: {e}")))?;

    Ok(Zeroizing::new(plaintext))
}

/// Encrypts all plaintext drive passwords for the given account.
///
/// Scans `hcfs_config` for rows where `encryption_version = 0`, encrypts the
/// `drive_password` in a single transaction, and sets `encryption_version = 1`.
/// Safe to call repeatedly — rows already at version 1 are skipped, and the key
/// derivation is performed only when there is at least one row to migrate.
///
/// NOTE: despite living next to the sub-account helpers, this migrates ONLY
/// `hcfs_config.drive_password`. It does NOT encrypt `sub_accounts` seed
/// phrases. If sub-account seed phrases need encryption-at-rest, that is a
/// separate, currently-unimplemented migration.
///
/// # Single-user assumption
///
/// This function selects ALL matching rows regardless of any parent-account
/// column. This is intentional: Hippius Desktop is a single-user application —
/// each SQLite database belongs to exactly one logged-in user. If multi-user
/// support is ever added, a `parent_account_id` column will need to be
/// introduced and this query scoped accordingly.
pub async fn migrate_if_needed(pool: &SqlitePool, mnemonic: &str, account_id: &str) -> Result<(), crate::error::AppError> {
    let mut tx = pool.begin().await?;

    // Fetch the unmigrated rows BEFORE deriving the key. derive_key runs BIP-39
    // PBKDF2-HMAC-SHA512 (2048 iterations), so deriving it unconditionally — as
    // the previous version did — paid that cost on EVERY login and boot even
    // though the steady state (everything already at encryption_version = 1) has
    // nothing to migrate. The key is derived only when a row needs it.
    let drive_rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, drive_password FROM hcfs_config WHERE encryption_version = 0 AND drive_password != ''")
            .fetch_all(&mut *tx)
            .await?;

    let drive_count = drive_rows.len();
    if !drive_rows.is_empty() {
        let drive_key = derive_key(mnemonic, account_id, INFO_DRIVE_PASSWORD)?;
        for (id, plaintext) in &drive_rows {
            if plaintext.trim().is_empty() {
                continue;
            }
            let ciphertext = encrypt(&drive_key, plaintext)?;
            sqlx::query("UPDATE hcfs_config SET drive_password = ?, encryption_version = 1 WHERE id = ?")
                .bind(&ciphertext)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }

    tx.commit().await?;

    if drive_count > 0 {
        info!("Encryption migration complete: {drive_count} drive password(s)");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const TEST_ACCOUNT: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    #[test]
    fn derive_key_is_deterministic() {
        let k1 = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "test-purpose").unwrap();
        let k2 = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "test-purpose").unwrap();
        assert_eq!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn derive_key_different_info_produces_different_key() {
        let k1 = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "purpose-a").unwrap();
        let k2 = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "purpose-b").unwrap();
        assert_ne!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn derive_key_different_account_produces_different_key() {
        let k1 = derive_key(TEST_MNEMONIC, "account-1", "same-purpose").unwrap();
        let k2 = derive_key(TEST_MNEMONIC, "account-2", "same-purpose").unwrap();
        assert_ne!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn derive_key_invalid_mnemonic_returns_error() {
        let result = derive_key("this is not a valid bip39 mnemonic phrase at all", TEST_ACCOUNT, "test");
        assert!(result.is_err(), "invalid mnemonic must return Err, not panic");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("invalid mnemonic"),
            "error message should mention 'invalid mnemonic', got: {err_msg}"
        );
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "test").unwrap();
        let plaintext = "my secret seed phrase";
        let ciphertext = encrypt(&key, plaintext).unwrap();
        let decrypted = decrypt(&key, &ciphertext).unwrap();
        assert_eq!(&*decrypted, plaintext);
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let key1 = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "purpose-1").unwrap();
        let key2 = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "purpose-2").unwrap();
        let ciphertext = encrypt(&key1, "secret").unwrap();
        assert!(decrypt(&key2, &ciphertext).is_err());
    }

    #[test]
    fn decrypt_corrupted_ciphertext_fails() {
        let key = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "test").unwrap();
        assert!(decrypt(&key, "not-valid-base64!!!").is_err());
        assert!(decrypt(&key, "dG9vc2hvcnQ=").is_err()); // valid base64 but too short
    }

    #[test]
    fn encrypt_produces_different_ciphertext_each_time() {
        let key = derive_key(TEST_MNEMONIC, TEST_ACCOUNT, "test").unwrap();
        let c1 = encrypt(&key, "same input").unwrap();
        let c2 = encrypt(&key, "same input").unwrap();
        assert_ne!(c1, c2, "random nonce should make ciphertext unique");
        assert_eq!(&*decrypt(&key, &c1).unwrap(), "same input");
        assert_eq!(&*decrypt(&key, &c2).unwrap(), "same input");
    }
}
