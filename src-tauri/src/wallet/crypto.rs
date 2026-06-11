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
//! Currently-emitted version is `V_ARGON2_AAD` (Argon2id key, address-bound
//! AAD); `V_ARGON2` (no AAD) and the legacy unversioned HKDF-SHA256 layout
//! are still decrypted — see [`decrypt_mnemonic`] for the format-detection
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
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Domain-separation tag for the AEAD key derivation.
///
/// Used ONLY by the legacy HKDF derivation (`derive_aead_key_hkdf_legacy` via
/// `hk.expand(INFO_MNEMONIC, ..)`). The current Argon2id path does NOT consume
/// it — `Argon2::default().hash_password_into(password, salt, out)` takes no
/// associated data — so domain separation for current ciphertext rests on the
/// per-wallet address salt plus this key being single-purpose, not on an
/// Argon2 AD binding. (The earlier doc claimed it was folded into Argon2id's
/// `associated_data`, which the code never did.)
const INFO_MNEMONIC: &[u8] = b"hippius-local-wallet-mnemonic";

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Version byte for the previous ciphertext layout: Argon2id-derived AEAD key,
/// **no** associated data. Still decrypted (never re-encrypted under the old
/// format), so pre-R-33 wallets keep working unchanged.
const V_ARGON2: u8 = 0x02;

/// Version byte for current ciphertext: Argon2id-derived AEAD key **with** an
/// AAD of `version_byte || address` (audit R-33). The AAD authenticates (but
/// does not encrypt) the address, binding the ciphertext to its wallet
/// independently of the address-salted key — so integrity holds even if a
/// future key-derivation change weakened the salt binding.
const V_ARGON2_AAD: u8 = 0x03;

/// Associated data for [`V_ARGON2_AAD`] ciphertext: the version byte followed
/// by the wallet's SS58 address bytes.
fn aad_bytes(address: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(1 + address.len());
    aad.push(V_ARGON2_AAD);
    aad.extend_from_slice(address.as_bytes());
    aad
}

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
fn derive_aead_key_argon2(password: &str, address: &str) -> Result<Zeroizing<[u8; 32]>, AppError> {
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
fn derive_aead_key_hkdf_legacy(password: &str, address: &str) -> Zeroizing<[u8; 32]> {
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
                Argon2::default().verify_password(bound.as_slice(), &parsed).is_ok()
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

/// Encrypt a mnemonic under the new (Argon2id, versioned, AAD-bound) layout.
/// Returns base64 of `V_ARGON2_AAD || nonce[12] || ciphertext || tag[16]`.
///
/// # Errors
///
/// Returns [`AppError::Crypto`] if Argon2id key derivation or AEAD
/// encryption fails. The AEAD encrypt itself is effectively infallible
/// for valid inputs — the underlying library only errors on nonce
/// reuse, which our per-encrypt `OsRng` draw cannot produce.
pub fn encrypt_mnemonic(mnemonic: &str, password: &str, address: &str) -> Result<String, AppError> {
    // Locally scoped so chacha's `OsRng` doesn't collide with the argon2
    // `OsRng` imported at module level. Mirrors `crypto::store::encrypt`.
    use chacha20poly1305::{AeadCore, aead::OsRng};

    let key = derive_aead_key_argon2(password, address)?;
    let cipher = ChaCha20Poly1305::new(key.as_slice().into());

    // Fresh per-encrypt 12-byte nonce from the OS CSPRNG.
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);

    // Bind the address into the AEAD as associated data (audit R-33).
    let aad = aad_bytes(address);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            chacha20poly1305::aead::Payload {
                msg: mnemonic.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|e| AppError::Crypto(format!("AEAD encrypt failed: {e}")))?;

    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(V_ARGON2_AAD);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(out))
}

/// Decrypt a mnemonic. Handles all three layouts: `V_ARGON2_AAD`
/// (current), `V_ARGON2` (pre-R-33, no AAD), and the legacy
/// unversioned HKDF layout.
///
/// # Format detection
///
/// After base64-decoding, we inspect the leading byte. If it matches a
/// version sentinel (and the length is consistent with a versioned
/// ciphertext) we ATTEMPT that format — but a tag failure there falls
/// through to the legacy HKDF reader rather than returning an error.
/// Legacy ciphertext starts directly with a 12-byte random nonce, so
/// its first byte aliases a sentinel with probability 1/256 per wallet
/// per sentinel; returning early on the versioned attempt permanently
/// locked those wallets out ("wrong password" with the correct
/// password). Trying the next format is safe — each attempt is still
/// gated by its own Poly1305 tag, so a wrong password fails every
/// format and the right one succeeds in exactly one.
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
pub fn decrypt_mnemonic(encrypted_b64: &str, password: &str, address: &str) -> Result<(Zeroizing<String>, bool), AppError> {
    let raw = B64
        .decode(encrypted_b64)
        .map_err(|e| AppError::Crypto(format!("invalid base64 ciphertext: {e}")))?;

    // Current format: `V_ARGON2_AAD` then nonce + body, decrypted with the
    // address-bound AAD (audit R-33). A tag failure here is NOT returned:
    // the blob may be a legacy ciphertext whose random first nonce byte
    // aliases the sentinel, so we fall through to the older formats (see
    // the format-detection doc above).
    if raw.first().copied() == Some(V_ARGON2_AAD) && raw.len() >= 1 + NONCE_LEN + TAG_LEN {
        let body = &raw[1..];
        let (nonce_bytes, ct_and_tag) = body.split_at(NONCE_LEN);
        let key = derive_aead_key_argon2(password, address)?;
        let cipher = ChaCha20Poly1305::new(key.as_slice().into());
        let aad = aad_bytes(address);
        if let Ok(plaintext) = cipher.decrypt(nonce_bytes.into(), chacha20poly1305::aead::Payload { msg: ct_and_tag, aad: &aad }) {
            // Tag verified ⇒ right key ⇒ a UTF-8 failure is genuine corruption.
            let s = String::from_utf8(plaintext).map_err(|e| AppError::Crypto(format!("decrypted bytes not UTF-8: {e}")))?;
            return Ok((Zeroizing::new(s), false));
        }
    }

    // Previous format (`V_ARGON2`, no AAD) — still decrypted unchanged so
    // pre-R-33 wallets keep working. Same fall-through rule as above.
    if raw.first().copied() == Some(V_ARGON2) && raw.len() >= 1 + NONCE_LEN + TAG_LEN {
        let body = &raw[1..];
        let (nonce_bytes, ct_and_tag) = body.split_at(NONCE_LEN);
        let key = derive_aead_key_argon2(password, address)?;
        let cipher = ChaCha20Poly1305::new(key.as_slice().into());
        if let Ok(plaintext) = cipher.decrypt(nonce_bytes.into(), ct_and_tag) {
            let s = String::from_utf8(plaintext).map_err(|e| AppError::Crypto(format!("decrypted bytes not UTF-8: {e}")))?;
            return Ok((Zeroizing::new(s), false));
        }
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
    let s = String::from_utf8(plaintext).map_err(|e| AppError::Crypto(format!("decrypted bytes not UTF-8: {e}")))?;
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

    /// New ciphertext is emitted under the AAD-bound version byte (audit R-33).
    #[test]
    fn new_ciphertext_uses_aad_version() {
        let enc = encrypt_mnemonic(MNEMONIC, "pw", ADDRESS).expect("encrypt");
        let raw = B64.decode(&enc).expect("b64");
        assert_eq!(raw.first().copied(), Some(V_ARGON2_AAD));
    }

    /// Backward compatibility: a pre-R-33 `V_ARGON2` (no-AAD) ciphertext MUST
    /// still decrypt — the version byte routes it to the no-AAD path, so
    /// existing wallets are untouched.
    #[test]
    fn decrypts_pre_r33_v_argon2_without_aad() {
        // Reproduce the old encrypt: `V_ARGON2 || nonce || AEAD(empty AAD)`.
        let enc = {
            use chacha20poly1305::{AeadCore, aead::OsRng};
            let key = derive_aead_key_argon2("pw", ADDRESS).unwrap();
            let cipher = ChaCha20Poly1305::new(key.as_slice().into());
            let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
            let ct = cipher.encrypt(&nonce, MNEMONIC.as_bytes()).unwrap();
            let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
            out.push(V_ARGON2);
            out.extend_from_slice(nonce.as_slice());
            out.extend_from_slice(&ct);
            B64.encode(out)
        };
        let (dec, was_legacy) = decrypt_mnemonic(&enc, "pw", ADDRESS).expect("decrypt old format");
        assert_eq!(MNEMONIC, dec.as_str());
        assert!(!was_legacy);
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
        use chacha20poly1305::{AeadCore, aead::OsRng};
        let key = derive_aead_key_hkdf_legacy(password, address);
        let cipher = ChaCha20Poly1305::new(key.as_slice().into());
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ct = cipher.encrypt(&nonce, mnemonic.as_bytes()).expect("encrypt");
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(nonce.as_slice());
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

    /// Build a legacy v1 ciphertext whose RANDOM first nonce byte is forced to
    /// a chosen value, to exercise the 1/256 sentinel-alias case: a legacy
    /// blob whose nonce starts with `V_ARGON2_AAD`/`V_ARGON2` must still
    /// decrypt via fall-through, not die in the versioned branch.
    fn encrypt_legacy_v1_with_first_byte(mnemonic: &str, password: &str, address: &str, first: u8) -> String {
        use chacha20poly1305::{AeadCore, aead::OsRng};
        let key = derive_aead_key_hkdf_legacy(password, address);
        let cipher = ChaCha20Poly1305::new(key.as_slice().into());
        let mut nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        nonce[0] = first;
        let ct = cipher.encrypt(&nonce, mnemonic.as_bytes()).expect("encrypt");
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(nonce.as_slice());
        out.extend_from_slice(&ct);
        B64.encode(out)
    }

    #[test]
    fn legacy_ciphertext_with_aad_sentinel_first_byte_still_decrypts() {
        let enc = encrypt_legacy_v1_with_first_byte(MNEMONIC, "hunter2", ADDRESS, V_ARGON2_AAD);
        let (dec, was_legacy) = decrypt_mnemonic(&enc, "hunter2", ADDRESS)
            .expect("legacy blob aliasing V_ARGON2_AAD must fall through and decrypt");
        assert_eq!(MNEMONIC, dec.as_str());
        assert!(was_legacy, "fall-through decrypt must still flag for migration");
    }

    #[test]
    fn legacy_ciphertext_with_argon2_sentinel_first_byte_still_decrypts() {
        let enc = encrypt_legacy_v1_with_first_byte(MNEMONIC, "hunter2", ADDRESS, V_ARGON2);
        let (dec, was_legacy) = decrypt_mnemonic(&enc, "hunter2", ADDRESS)
            .expect("legacy blob aliasing V_ARGON2 must fall through and decrypt");
        assert_eq!(MNEMONIC, dec.as_str());
        assert!(was_legacy, "fall-through decrypt must still flag for migration");
    }

    /// The fall-through must not weaken rejection: a wrong password fails the
    /// tag in EVERY attempted format and surfaces the same generic error.
    #[test]
    fn wrong_password_rejected_after_fallthrough() {
        for first in [V_ARGON2_AAD, V_ARGON2] {
            let enc = encrypt_legacy_v1_with_first_byte(MNEMONIC, "right", ADDRESS, first);
            let err = decrypt_mnemonic(&enc, "wrong", ADDRESS).unwrap_err();
            match err {
                AppError::Crypto(_) => {}
                other => panic!("expected Crypto error, got {other:?}"),
            }
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
