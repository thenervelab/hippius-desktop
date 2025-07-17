use sha2::{Digest, Sha256};
use sodiumoxide::crypto::secretbox;
use crate::DB_POOL;
use sqlx::Row;
use crate::constants::ENCRYPTION_KEY_NAME;

/// Create a random encryption key and save it to the DB (if not already present)
pub async fn create_and_store_encryption_key() -> Result<(), String> {
    let key = secretbox::gen_key();
    let key_bytes = key.0.to_vec();
    if let Some(pool) = DB_POOL.get() {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS encryption_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key_name TEXT NOT NULL UNIQUE, key BLOB NOT NULL)"
        )
        .execute(pool)
        .await
        .map_err(|e| format!("DB error (create table): {}", e))?;
        sqlx::query(
            "INSERT OR IGNORE INTO encryption_keys (key_name, key) VALUES (?, ?)"
        )
        .bind(ENCRYPTION_KEY_NAME)
        .bind(&key_bytes)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error (insert key): {}", e))?;
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Fetch the encryption key from the DB
async fn get_encryption_key_from_db() -> Result<secretbox::Key, String> {
    if let Some(pool) = DB_POOL.get() {
        let row = sqlx::query("SELECT key FROM encryption_keys WHERE key_name = ? ORDER BY id DESC LIMIT 1")
            .bind(ENCRYPTION_KEY_NAME)
            .fetch_one(pool)
            .await
            .map_err(|e| format!("DB error (fetch key): {}", e))?;
        let key_bytes: Vec<u8> = row.get("key");
        secretbox::Key::from_slice(&key_bytes).ok_or("Invalid key length".to_string())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Encrypts file data using the key from the DB, prepending the nonce to the ciphertext.
pub async fn encrypt_file(file_data: &[u8]) -> Result<Vec<u8>, String> {
    let key = get_encryption_key_from_db().await?;
    let nonce = secretbox::gen_nonce();
    let encrypted_data = secretbox::seal(file_data, &nonce, &key);
    let mut result = nonce.0.to_vec();
    result.extend_from_slice(&encrypted_data);
    Ok(result)
}

/// Decrypts file data using the key from the DB, extracting the nonce.
pub async fn decrypt_file(encrypted_data: &[u8]) -> Result<Vec<u8>, String> {
    if encrypted_data.len() < secretbox::NONCEBYTES {
        return Err("Encrypted data too short".to_string());
    }
    let (nonce_bytes, ciphertext) = encrypted_data.split_at(secretbox::NONCEBYTES);
    let key = get_encryption_key_from_db().await?;
    let nonce = secretbox::Nonce::from_slice(nonce_bytes).ok_or("Invalid nonce")?;
    secretbox::open(ciphertext, &nonce, &key).map_err(|_| "Decryption failed".to_string())
}