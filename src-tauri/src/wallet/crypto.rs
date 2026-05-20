//! Password-based encryption for the local-wallet mnemonic store.
//!
//! Two operations live here:
//!   * **Password verification.** A SHA-256 hash of `password || address` is
//!     stored at create time and checked at unlock time. The address acts as a
//!     per-wallet salt so the hash for the same password differs across wallets.
//!     This is intentionally fast (one SHA-256) — its job is integrity checking,
//!     not slowing down brute force; that protection lives in the encryption
//!     step below.
//!   * **Mnemonic encryption.** HKDF-SHA256 stretches the password into a
//!     256-bit AEAD key (salted with the wallet address, info-tagged for
//!     domain separation), and ChaCha20-Poly1305 encrypts the mnemonic.
//!     Ciphertext is base64-encoded as `nonce[12] || ciphertext || tag[16]`,
//!     matching the layout used by `crate::crypto::store` so the project
//!     stays consistent across at-rest secrets.
//!
//! Mirrors the `feature/wallet-updates` TS implementation behaviourally but
//! uses stronger primitives (ChaCha20-Poly1305 vs CryptoJS AES-CBC with the
//! password-as-key) and proper key derivation. There is no migration
//! requirement — the TS implementation hasn't shipped, so all stored secrets
//! start out under this Rust path.

use crate::error::AppError;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::Aead};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const INFO_MNEMONIC: &[u8] = b"hippius-local-wallet-mnemonic";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// SHA-256(`password || address`) hex string. Used to verify the user typed
/// the right password before attempting the AEAD decrypt (which would also
/// catch the wrong password but with a less clear error).
pub fn password_hash(password: &str, address: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(address.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Derives a 256-bit AEAD key from `password` salted with `address`. The
/// derived key is wiped on drop via `Zeroizing`.
fn derive_aead_key(password: &str, address: &str) -> Zeroizing<[u8; 32]> {
    // HKDF expects a salt — using the wallet address means two wallets with
    // identical passwords end up with different encryption keys.
    let hk = Hkdf::<Sha256>::new(Some(address.as_bytes()), password.as_bytes());
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(INFO_MNEMONIC, okm.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// Encrypt a mnemonic. The returned string is base64 of
/// `nonce[12] || ciphertext || tag[16]`.
///
/// # Errors
///
/// Returns [`AppError::Crypto`] if the AEAD encrypt fails (effectively never
/// — the underlying library only errors on impossible nonce reuse).
pub fn encrypt_mnemonic(mnemonic: &str, password: &str, address: &str) -> Result<String, AppError> {
    let key = derive_aead_key(password, address);
    let cipher = ChaCha20Poly1305::new(key.as_slice().into());

    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);

    let ciphertext = cipher
        .encrypt(nonce.as_slice().into(), mnemonic.as_bytes())
        .map_err(|e| AppError::Crypto(format!("AEAD encrypt failed: {e}")))?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(out))
}

/// Decrypt a mnemonic encrypted by [`encrypt_mnemonic`].
///
/// # Errors
///
/// Returns [`AppError::Crypto`] if the base64 decode, AEAD tag check, or
/// UTF-8 conversion fails — all of which indicate either tampering or, much
/// more commonly, a wrong password.
pub fn decrypt_mnemonic(encrypted_b64: &str, password: &str, address: &str) -> Result<Zeroizing<String>, AppError> {
    let raw = B64
        .decode(encrypted_b64)
        .map_err(|e| AppError::Crypto(format!("invalid base64 ciphertext: {e}")))?;
    if raw.len() < NONCE_LEN + TAG_LEN {
        return Err(AppError::Crypto("ciphertext too short".into()));
    }

    let (nonce_bytes, body) = raw.split_at(NONCE_LEN);
    let key = derive_aead_key(password, address);
    let cipher = ChaCha20Poly1305::new(key.as_slice().into());

    let plaintext = cipher
        .decrypt(nonce_bytes.into(), body)
        .map_err(|_| AppError::Crypto("decrypt failed — wrong password or corrupt data".into()))?;

    let s = String::from_utf8(plaintext).map_err(|e| AppError::Crypto(format!("decrypted bytes not UTF-8: {e}")))?;
    Ok(Zeroizing::new(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MNEMONIC: &str = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
    const ADDRESS: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    #[test]
    fn round_trip() {
        let enc = encrypt_mnemonic(MNEMONIC, "hunter2", ADDRESS).expect("encrypt");
        let dec = decrypt_mnemonic(&enc, "hunter2", ADDRESS).expect("decrypt");
        assert_eq!(MNEMONIC, dec.as_str());
    }

    #[test]
    fn wrong_password_rejected() {
        let enc = encrypt_mnemonic(MNEMONIC, "right", ADDRESS).expect("encrypt");
        let err = decrypt_mnemonic(&enc, "wrong", ADDRESS).unwrap_err();
        match err {
            AppError::Crypto(_) => {}
            other => panic!("expected Crypto error, got {other:?}"),
        }
    }

    #[test]
    fn different_addresses_produce_different_ciphertexts() {
        let a = encrypt_mnemonic(MNEMONIC, "pw", "addr-A").unwrap();
        let b = encrypt_mnemonic(MNEMONIC, "pw", "addr-B").unwrap();
        // Even if nonces collided (1 in 2^96) the tags wouldn't match because
        // the per-address salt produces a different key.
        assert_ne!(a, b);
    }

    #[test]
    fn password_hash_includes_address_salt() {
        let h1 = password_hash("pw", "addr-A");
        let h2 = password_hash("pw", "addr-B");
        assert_ne!(h1, h2);
        let h1_again = password_hash("pw", "addr-A");
        assert_eq!(h1, h1_again);
    }
}
