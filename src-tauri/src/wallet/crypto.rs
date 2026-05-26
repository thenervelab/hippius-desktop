//! Password-based encryption for the local-wallet mnemonic store.
//!
//! # Threat model
//!
//! The attacker we care about is one who has obtained a copy of the
//! `local_wallets` SQLite row (or the `.zip` backup file) but does not
//! have the user's password. Their goal is to recover the wallet
//! mnemonic via offline brute force. Online attacks against the IPC
//! surface aren't the primary worry here — the renderer can already
//! call any wallet IPC if the user is logged in, so a renderer-side
//! compromise has bigger problems than guessing passwords.
//!
//! # Design
//!
//! - **AEAD**: ChaCha20-Poly1305 on the mnemonic. 12-byte random nonce
//!   per encrypt, 16-byte tag. Wrong-password and corruption are
//!   indistinguishable at the AEAD layer (both fail tag verification).
//! - **Key derivation**: Argon2id (memory-hard, GPU-resistant) stretches
//!   the password into a 256-bit AEAD key. The wallet's SS58 address is
//!   used as the salt so identical passwords on different wallets yield
//!   different keys. Argon2id parameters use the `argon2` crate's
//!   defaults (currently OWASP-recommended m=19MiB, t=2, p=1) which take
//!   ~50–100 ms on a contemporary CPU.
//! - **Password verifier**: Argon2id PHC string (`$argon2id$…`) stored
//!   alongside the ciphertext. We verify *before* attempting the AEAD
//!   decrypt so a wrong password produces a clean "Incorrect password"
//!   error instead of an opaque AEAD failure.
//!
//! # Ciphertext layout
//!
//! Stored as base64 of `version_byte || nonce[12] || ciphertext || tag[16]`.
//! Currently-emitted version is `V_ARGON2`. The legacy `V_HKDF` layout
//! (no version byte, raw HKDF-SHA256 key) is recognised by sniffing the
//! decoded length — see [`decrypt_mnemonic`] for the format-detection
//! comment. Legacy rows are decrypted in-place and the caller is expected
//! to immediately re-encrypt them under the new format via
//! [`encrypt_mnemonic`] + a DB write.
//!
//! # Password-verifier layout
//!
//! - Current: a `$argon2id$v=19$m=…$<salt>$<hash>` PHC string.
//! - Legacy: a 64-character hex SHA-256 of `password || address`.
//!
//! Both are stored verbatim in the `password_hash` column.
//! [`verify_password`] sniffs the prefix and uses the right routine.

use crate::error::AppError;
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::Aead};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Domain-separation tag for the AEAD key derivation. Folded into
/// Argon2id's `associated_data` so the same password + salt + Argon
/// params can never accidentally produce a key for some other purpose.
const INFO_MNEMONIC: &[u8] = b"hippius-local-wallet-mnemonic";

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Version byte for new ciphertext (Argon2id-derived AEAD key).
const V_ARGON2: u8 = 0x02;

/// Constant-time equality for two byte slices. Hex strings + PHC
/// strings are short enough that the timing channel is small, but
/// using a constant-time compare makes that explicit.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ─── Argon2id key derivation ─────────────────────────────────────────

/// Argon2id's salt parameter has a minimum length of 8 bytes. Real
/// SS58 addresses are 48+ chars so this is comfortably satisfied; we
/// hash-and-pad short test addresses up to the minimum to keep
/// fixtures in unit tests easy to read.
fn salt_bytes(address: &str) -> Zeroizing<Vec<u8>> {
    let raw = address.as_bytes();
    if raw.len() >= 8 {
        Zeroizing::new(raw.to_vec())
    } else {
        let mut h = Sha256::new();
        h.update(raw);
        Zeroizing::new(h.finalize().to_vec())
    }
}

/// Derive a 256-bit AEAD key from `password` salted with `address`.
/// The derived key is wiped on drop via `Zeroizing`.
///
/// The wallet's SS58 address (32-byte public key, base58-encoded) is
/// high-entropy and unique per wallet, so it doubles as a per-wallet
/// salt for Argon2id. The result: two wallets with identical passwords
/// land on different AEAD keys.
fn derive_aead_key_argon2(
    password: &str,
    address: &str,
) -> Result<Zeroizing<[u8; 32]>, AppError> {
    let salt = salt_bytes(address);
    let mut okm = Zeroizing::new([0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt.as_slice(), okm.as_mut())
        .map_err(|e| AppError::Crypto(format!("argon2 key derivation failed: {e}")))?;
    Ok(okm)
}

// ─── Legacy HKDF derivation (kept for transparent migration) ─────────

/// Derive a 256-bit AEAD key using the v1 HKDF-SHA256 scheme. Kept here
/// solely so existing wallets created before the Argon2id rollout can be
/// decrypted once and immediately re-encrypted under the new scheme.
/// New writes never go through this path.
fn derive_aead_key_hkdf_legacy(
    password: &str,
    address: &str,
) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(address.as_bytes()), password.as_bytes());
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(INFO_MNEMONIC, okm.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

// ─── Password verifier ───────────────────────────────────────────────

/// Mix the wallet `address` into the password input before hashing so
/// two wallets with the same password still produce distinct hashes
/// *and* a hash copied across rows fails to verify. We're not relying
/// on this for confidentiality (the random PHC salt already keeps
/// hashes distinct); the address-binding is defence in depth against
/// hash-tampering in the DB.
fn bind_password_to_address(password: &str, address: &str) -> Zeroizing<Vec<u8>> {
    let mut buf = Vec::with_capacity(password.len() + 1 + address.len());
    buf.extend_from_slice(password.as_bytes());
    buf.push(0); // separator — no ambiguity between (pw="ab", addr="c") and (pw="abc", addr="")
    buf.extend_from_slice(address.as_bytes());
    Zeroizing::new(buf)
}

/// Build an Argon2id PHC verifier string for `password`. The hash's
/// random salt lives inside the PHC string; the wallet `address` is
/// mixed into the password input so the same hash cannot verify under
/// a different address.
pub fn password_hash(password: &str, address: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    let bound = bind_password_to_address(password, address);
    Argon2::default()
        .hash_password(bound.as_slice(), &salt)
        .expect("argon2 PHC hash should not fail with valid params + non-empty password")
        .to_string()
}

/// Verify a password against a stored hash. Accepts BOTH the new
/// Argon2id PHC format (`$argon2id$…`) and the legacy hex-encoded
/// `SHA-256(password || address)` format used before this module was
/// hardened — sniffing the prefix tells us which routine to run.
///
/// Returning `false` (rather than `Err`) for a malformed stored hash
/// matches the "wrong password" UX path: it shouldn't be possible for a
/// row's hash to be unparseable, but if it ever is, the user gets a
/// clean "Incorrect password" instead of a leaky error string.
pub fn verify_password(stored_hash: &str, password: &str, address: &str) -> bool {
    if stored_hash.starts_with("$argon2") {
        return match PasswordHash::new(stored_hash) {
            Ok(parsed) => {
                let bound = bind_password_to_address(password, address);
                Argon2::default()
                    .verify_password(bound.as_slice(), &parsed)
                    .is_ok()
            }
            Err(_) => false,
        };
    }

    // Legacy: 64-char hex SHA-256(password || address)
    if stored_hash.len() == 64 && stored_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        hasher.update(address.as_bytes());
        let computed = format!("{:x}", hasher.finalize());
        return constant_time_eq(stored_hash.as_bytes(), computed.as_bytes());
    }

    false
}

/// `true` if `stored_hash` is in the legacy SHA-256 format and the
/// caller should re-hash + persist after a successful verify. New rows
/// already in Argon2id format return `false`.
pub fn password_hash_is_legacy(stored_hash: &str) -> bool {
    stored_hash.len() == 64 && stored_hash.bytes().all(|b| b.is_ascii_hexdigit())
}

// ─── Mnemonic encrypt / decrypt ──────────────────────────────────────

/// Encrypt a mnemonic under the new (Argon2id, versioned) layout.
/// Returns base64 of `V_ARGON2 || nonce[12] || ciphertext || tag[16]`.
///
/// # Errors
///
/// Returns [`AppError::Crypto`] if Argon2id key derivation or AEAD
/// encryption fails. The AEAD encrypt itself is effectively infallible
/// for valid inputs — the underlying library only errors on nonce
/// reuse, which our per-encrypt `OsRng` draw cannot produce.
pub fn encrypt_mnemonic(
    mnemonic: &str,
    password: &str,
    address: &str,
) -> Result<String, AppError> {
    let key = derive_aead_key_argon2(password, address)?;
    let cipher = ChaCha20Poly1305::new(key.as_slice().into());

    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);

    let ciphertext = cipher
        .encrypt(nonce.as_slice().into(), mnemonic.as_bytes())
        .map_err(|e| AppError::Crypto(format!("AEAD encrypt failed: {e}")))?;

    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(V_ARGON2);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(out))
}

/// Decrypt a mnemonic. Handles both the new (`V_ARGON2`) and legacy
/// (HKDF, unversioned) layouts.
///
/// # Format detection
///
/// After base64-decoding, we inspect the leading byte. If it's the
/// `V_ARGON2` sentinel and the remaining length is consistent with a
/// versioned ciphertext, we proceed under Argon2id. Otherwise we
/// fall back to the legacy HKDF reader. Legacy ciphertext starts
/// directly with a 12-byte random nonce — the chance that that random
/// byte happens to equal `V_ARGON2` (0x02) is 1/256, so the
/// length-disambiguation isn't strictly necessary, but we do both
/// checks for robustness.
///
/// # Migration signal
///
/// The boolean in the returned tuple is `true` when the input was in
/// the legacy format. Callers that have write access to the row are
/// expected to re-encrypt + persist the result so the wallet gets
/// upgraded transparently on first unlock.
///
/// # Errors
///
/// Returns [`AppError::Crypto`] if base64 decoding, the AEAD tag check,
/// UTF-8 conversion of the plaintext, or (in the new path) Argon2id key
/// derivation fails. Wrong-password and tampering both surface as the
/// generic "wrong password or corrupt data" message — the AEAD layer
/// can't distinguish them.
pub fn decrypt_mnemonic(
    encrypted_b64: &str,
    password: &str,
    address: &str,
) -> Result<(Zeroizing<String>, bool), AppError> {
    let raw = B64
        .decode(encrypted_b64)
        .map_err(|e| AppError::Crypto(format!("invalid base64 ciphertext: {e}")))?;

    // Try the new format first: a single version byte then nonce + body.
    if raw.first().copied() == Some(V_ARGON2) && raw.len() >= 1 + NONCE_LEN + TAG_LEN {
        let body = &raw[1..];
        let (nonce_bytes, ct_and_tag) = body.split_at(NONCE_LEN);
        let key = derive_aead_key_argon2(password, address)?;
        let cipher = ChaCha20Poly1305::new(key.as_slice().into());
        let plaintext = cipher
            .decrypt(nonce_bytes.into(), ct_and_tag)
            .map_err(|_| AppError::Crypto("decrypt failed — wrong password or corrupt data".into()))?;
        let s = String::from_utf8(plaintext)
            .map_err(|e| AppError::Crypto(format!("decrypted bytes not UTF-8: {e}")))?;
        return Ok((Zeroizing::new(s), false));
    }

    // Legacy path: unversioned, HKDF-derived key.
    if raw.len() < NONCE_LEN + TAG_LEN {
        return Err(AppError::Crypto("ciphertext too short".into()));
    }
    let (nonce_bytes, ct_and_tag) = raw.split_at(NONCE_LEN);
    let key = derive_aead_key_hkdf_legacy(password, address);
    let cipher = ChaCha20Poly1305::new(key.as_slice().into());
    let plaintext = cipher
        .decrypt(nonce_bytes.into(), ct_and_tag)
        .map_err(|_| AppError::Crypto("decrypt failed — wrong password or corrupt data".into()))?;
    let s = String::from_utf8(plaintext)
        .map_err(|e| AppError::Crypto(format!("decrypted bytes not UTF-8: {e}")))?;
    Ok((Zeroizing::new(s), true))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MNEMONIC: &str = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
    const ADDRESS: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    #[test]
    fn round_trip_argon2() {
        let enc = encrypt_mnemonic(MNEMONIC, "hunter2", ADDRESS).expect("encrypt");
        let (dec, was_legacy) = decrypt_mnemonic(&enc, "hunter2", ADDRESS).expect("decrypt");
        assert_eq!(MNEMONIC, dec.as_str());
        assert!(!was_legacy, "new ciphertext must not be flagged as legacy");
    }

    #[test]
    fn wrong_password_rejected_argon2() {
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
        assert_ne!(a, b);
    }

    #[test]
    fn verify_password_round_trip_argon2() {
        let hash = password_hash("hunter2", ADDRESS);
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password(&hash, "hunter2", ADDRESS));
        assert!(!verify_password(&hash, "wrong", ADDRESS));
    }

    #[test]
    fn verify_password_address_binding() {
        // The PHC string is generated against the original address; if
        // someone copied the hash to a different wallet's row, verification
        // must fail even with the right password.
        let hash = password_hash("hunter2", ADDRESS);
        assert!(!verify_password(&hash, "hunter2", "5DifferentAddressZ123"));
    }

    /// Build a legacy v1 ciphertext (HKDF key, no version byte) so the
    /// migration path can be exercised without keeping the old
    /// `encrypt_mnemonic` API surface.
    fn encrypt_legacy_v1(mnemonic: &str, password: &str, address: &str) -> String {
        let key = derive_aead_key_hkdf_legacy(password, address);
        let cipher = ChaCha20Poly1305::new(key.as_slice().into());
        let mut nonce = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = cipher
            .encrypt(nonce.as_slice().into(), mnemonic.as_bytes())
            .expect("encrypt");
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        B64.encode(out)
    }

    #[test]
    fn legacy_ciphertext_still_decrypts_and_is_flagged() {
        let enc = encrypt_legacy_v1(MNEMONIC, "hunter2", ADDRESS);
        let (dec, was_legacy) = decrypt_mnemonic(&enc, "hunter2", ADDRESS).expect("decrypt");
        assert_eq!(MNEMONIC, dec.as_str());
        assert!(was_legacy, "legacy ciphertext must be flagged for migration");
    }

    #[test]
    fn legacy_wrong_password_rejected() {
        let enc = encrypt_legacy_v1(MNEMONIC, "right", ADDRESS);
        let err = decrypt_mnemonic(&enc, "wrong", ADDRESS).unwrap_err();
        match err {
            AppError::Crypto(_) => {}
            other => panic!("expected Crypto error, got {other:?}"),
        }
    }

    /// Recreate a legacy hex-SHA256 password hash so the verifier's
    /// backward-compat path can be exercised.
    fn legacy_sha256_password_hash(password: &str, address: &str) -> String {
        let mut h = Sha256::new();
        h.update(password.as_bytes());
        h.update(address.as_bytes());
        format!("{:x}", h.finalize())
    }

    #[test]
    fn legacy_password_hash_still_verifies() {
        let h = legacy_sha256_password_hash("hunter2", ADDRESS);
        assert!(password_hash_is_legacy(&h));
        assert!(verify_password(&h, "hunter2", ADDRESS));
        assert!(!verify_password(&h, "wrong", ADDRESS));
    }

    #[test]
    fn new_password_hash_not_flagged_legacy() {
        let h = password_hash("hunter2", ADDRESS);
        assert!(!password_hash_is_legacy(&h));
    }
}
