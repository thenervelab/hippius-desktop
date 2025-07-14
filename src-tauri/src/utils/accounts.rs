use sha2::{Digest, Sha256};
use sodiumoxide::crypto::secretbox;

pub fn deterministic_key_for_account(account_id: &str) -> secretbox::Key {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let hash = hasher.finalize();
    let mut key_bytes = [0u8; secretbox::KEYBYTES];
    key_bytes.copy_from_slice(&hash[..secretbox::KEYBYTES]);
    secretbox::Key(key_bytes)
}

/// Encrypts file data for an account, prepending the nonce to the ciphertext.
pub fn encrypt_file_for_account(account_id: &str, file_data: &[u8]) -> Result<Vec<u8>, String> {
    let key = deterministic_key_for_account(account_id);
    let nonce = secretbox::gen_nonce();
    let encrypted_data = secretbox::seal(file_data, &nonce, &key);
    let mut result = nonce.0.to_vec();
    result.extend_from_slice(&encrypted_data);
    Ok(result)
}

/// Decrypts file data for an account, extracting the nonce and using the deterministic key.
pub fn decrypt_file_for_account(
    account_id: &str,
    encrypted_data: &[u8],
) -> Result<Vec<u8>, String> {
    if encrypted_data.len() < secretbox::NONCEBYTES {
        return Err("Encrypted data too short".to_string());
    }
    let (nonce_bytes, ciphertext) = encrypted_data.split_at(secretbox::NONCEBYTES);
    let key = deterministic_key_for_account(account_id);
    let nonce = secretbox::Nonce::from_slice(nonce_bytes).ok_or("Invalid nonce")?;
    secretbox::open(ciphertext, &nonce, &key).map_err(|_| "Decryption failed".to_string())
}
