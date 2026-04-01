//! Tests for authentication crypto operations.
//!
//! Tests key derivation, passcode hashing, mnemonic validation,
//! and CryptoJS-compatible AES encryption/decryption.
//! No live server needed — just crypto unit tests.

use sha2::{Digest, Sha256};

/// Matches the Rust `hash_passcode` function and frontend's CryptoJS.SHA256.
fn hash_passcode(passcode: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(passcode.as_bytes());
    hex::encode(hasher.finalize())
}

/// CryptoJS-compatible key derivation (EVP_BytesToKey with MD5).
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

fn encrypt_mnemonic(mnemonic: &str, passcode: &str) -> String {
    use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
    use base64::Engine;

    let salt: [u8; 8] = rand::random();
    let (key, iv) = crypto_js_derive_key_iv(passcode.as_bytes(), &salt);

    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
    let encryptor = Aes256CbcEnc::new(&key.into(), &iv.into());

    let plaintext = mnemonic.as_bytes();
    let mut buf = vec![0u8; plaintext.len() + 16];
    buf[..plaintext.len()].copy_from_slice(plaintext);
    let ciphertext = encryptor.encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len()).unwrap();

    let mut output = Vec::with_capacity(16 + ciphertext.len());
    output.extend_from_slice(b"Salted__");
    output.extend_from_slice(&salt);
    output.extend_from_slice(ciphertext);
    base64::engine::general_purpose::STANDARD.encode(&output)
}

fn decrypt_mnemonic(encrypted: &str, passcode: &str) -> Result<String, String> {
    use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    use base64::Engine;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(encrypted)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

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
        .map_err(|_| "Decryption failed".to_string())?;

    String::from_utf8(plaintext.to_vec()).map_err(|e| format!("Invalid UTF-8: {e}"))
}

#[test]
fn test_passcode_hash_deterministic() {
    let hash1 = hash_passcode("mypasscode123");
    let hash2 = hash_passcode("mypasscode123");
    assert_eq!(hash1, hash2);
    assert_eq!(hash1.len(), 64); // SHA-256 hex = 64 chars
}

#[test]
fn test_passcode_hash_different_inputs() {
    let hash1 = hash_passcode("password1");
    let hash2 = hash_passcode("password2");
    assert_ne!(hash1, hash2);
}

#[test]
fn test_mnemonic_validation_valid() {
    // Standard BIP-39 test mnemonic
    let valid = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    assert!(bip39::Mnemonic::parse_in_normalized(bip39::Language::English, valid).is_ok());
}

#[test]
fn test_mnemonic_validation_invalid() {
    assert!(bip39::Mnemonic::parse_in_normalized(bip39::Language::English, "not a valid mnemonic").is_err());
    assert!(bip39::Mnemonic::parse_in_normalized(bip39::Language::English, "").is_err());
}

#[test]
fn test_key_derivation() {
    use sp_core::Pair as _;
    use sp_core::crypto::Ss58Codec;

    let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    // Derive sr25519 keypair
    let (pair, _) = sp_core::sr25519::Pair::from_phrase(mnemonic, None).unwrap();
    let substrate_address = pair.public().to_ss58check();

    // Should produce a valid SS58 address
    assert!(substrate_address.starts_with('5'));
    assert!(substrate_address.len() > 40);

    // Derive Ethereum keypair
    use alloy_signer_local::MnemonicBuilder;
    use alloy_signer_local::coins_bip39::English;

    let eth_signer: alloy_signer_local::PrivateKeySigner = MnemonicBuilder::<English>::default().phrase(mnemonic).index(0).unwrap().build().unwrap();
    let eth_address = format!("{}", eth_signer.address());

    // Should produce a valid Ethereum address
    assert!(eth_address.starts_with("0x"));
    assert_eq!(eth_address.len(), 42);
}

#[test]
fn test_key_derivation_deterministic() {
    use sp_core::Pair as _;
    use sp_core::crypto::Ss58Codec;

    let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    let (pair1, _) = sp_core::sr25519::Pair::from_phrase(mnemonic, None).unwrap();
    let (pair2, _) = sp_core::sr25519::Pair::from_phrase(mnemonic, None).unwrap();

    assert_eq!(pair1.public().to_ss58check(), pair2.public().to_ss58check());
}

#[test]
fn test_aes_encrypt_decrypt_roundtrip() {
    let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let passcode = "my-secure-passcode";

    let encrypted = encrypt_mnemonic(mnemonic, passcode);
    let decrypted = decrypt_mnemonic(&encrypted, passcode).unwrap();

    assert_eq!(decrypted, mnemonic);
}

#[test]
fn test_aes_decrypt_wrong_passcode_fails() {
    let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let passcode = "correct-passcode";

    let encrypted = encrypt_mnemonic(mnemonic, passcode);
    let result = decrypt_mnemonic(&encrypted, "wrong-passcode");

    assert!(result.is_err());
}

#[test]
fn test_aes_different_encryptions_differ() {
    let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let passcode = "my-passcode";

    // Each encryption should use a different random salt
    let enc1 = encrypt_mnemonic(mnemonic, passcode);
    let enc2 = encrypt_mnemonic(mnemonic, passcode);

    assert_ne!(enc1, enc2, "Different salts should produce different ciphertexts");

    // But both should decrypt to the same value
    assert_eq!(decrypt_mnemonic(&enc1, passcode).unwrap(), mnemonic);
    assert_eq!(decrypt_mnemonic(&enc2, passcode).unwrap(), mnemonic);
}

#[test]
fn test_evp_bytes_to_key_produces_correct_length() {
    let passphrase = b"test-passphrase";
    let salt = [1u8; 8];
    let (key, iv) = crypto_js_derive_key_iv(passphrase, &salt);
    assert_eq!(key.len(), 32);
    assert_eq!(iv.len(), 16);
}

#[test]
fn test_evp_bytes_to_key_deterministic() {
    let passphrase = b"test-passphrase";
    let salt = [42u8; 8];
    let (key1, iv1) = crypto_js_derive_key_iv(passphrase, &salt);
    let (key2, iv2) = crypto_js_derive_key_iv(passphrase, &salt);
    assert_eq!(key1, key2);
    assert_eq!(iv1, iv2);
}
