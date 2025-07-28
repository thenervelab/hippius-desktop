use sodiumoxide::crypto::secretbox;
use crate::DB_POOL;
use sqlx::Row;
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;

/// Generate a random key name
fn generate_key_name() -> String {
    let mut rng = thread_rng();
    let random_string: String = (0..8)
        .map(|_| rng.sample(Alphanumeric) as char)
        .collect();
    format!("key_{}", random_string)
}

/// Create a random encryption key and save it to the DB with a random name
pub async fn create_and_store_encryption_key() -> Result<(), String> {
    let key = secretbox::gen_key();
    let key_bytes = key.0.to_vec();
    let key_name = generate_key_name();

    if let Some(pool) = DB_POOL.get() {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS encryption_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key_name TEXT NOT NULL UNIQUE, key BLOB NOT NULL)"
        )
        .execute(pool)
        .await
        .map_err(|e| format!("DB error (create table): {}", e))?;
        
        sqlx::query(
            "INSERT INTO encryption_keys (key_name, key) VALUES (?, ?)"
        )
        .bind(&key_name)
        .bind(&key_bytes)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error (insert key): {}", e))?;
        
        println!("Created new encryption key: {}", key_name);
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Import an existing encryption key into the DB
pub async fn import_encryption_key(key_bytes: Vec<u8>) -> Result<String, String> {
    // Validate key length
    if key_bytes.len() != secretbox::KEYBYTES {
        return Err(format!("Invalid key length. Expected {} bytes", secretbox::KEYBYTES));
    }

    if let Some(pool) = DB_POOL.get() {
        // Generate random name for imported key
        let key_name = generate_key_name();
        
        sqlx::query(
            "INSERT INTO encryption_keys (key_name, key) VALUES (?, ?)"
        )
        .bind(&key_name)
        .bind(&key_bytes)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error (insert imported key): {}", e))?;
        
        Ok(key_name)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Fetch the encryption key from the DB
async fn get_latest_encryption_key_from_db() -> Result<secretbox::Key, String> {
    if let Some(pool) = DB_POOL.get() {
        let row = sqlx::query("SELECT key FROM encryption_keys ORDER BY id DESC LIMIT 1")
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
pub async fn encrypt_file(file_data: &[u8], encryption_key: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let key = match encryption_key {
        Some(key_bytes) => {
            secretbox::Key::from_slice(&key_bytes).ok_or("Invalid key length".to_string())?
        },
        None => get_latest_encryption_key_from_db().await?
    };
    let nonce = secretbox::gen_nonce();
    let encrypted_data = secretbox::seal(file_data, &nonce, &key);
    let mut result = nonce.0.to_vec();
    result.extend_from_slice(&encrypted_data);
    Ok(result)
}

/// Decrypts file data using the key from the DB, extracting the nonce.
pub async fn decrypt_file(encrypted_data: &[u8], encryption_key: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    if encrypted_data.len() < secretbox::NONCEBYTES {
        return Err("Encrypted data too short".to_string());
    }
    let (nonce_bytes, ciphertext) = encrypted_data.split_at(secretbox::NONCEBYTES);
    let key = match encryption_key {
        Some(key_bytes) => {
            secretbox::Key::from_slice(&key_bytes).ok_or("Invalid key length".to_string())?
        },
        None => get_latest_encryption_key_from_db().await?
    };
    let nonce = secretbox::Nonce::from_slice(nonce_bytes).ok_or("Invalid nonce")?;
    secretbox::open(ciphertext, &nonce, &key).map_err(|_| "Decryption failed".to_string())
}

/// List all encryption keys in the DB (returns base64-encoded key values and their IDs)
pub async fn list_encryption_keys() -> Result<Vec<(String, i64)>, String> {
    if let Some(pool) = DB_POOL.get() {
        let rows = sqlx::query("SELECT key, id FROM encryption_keys ORDER BY id DESC")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("DB error (fetch keys): {}", e))?;
            
        Ok(rows.iter().map(|row| {
            let key_bytes: Vec<u8> = row.get("key");
            let key_b64 = base64::encode(&key_bytes);
            (key_b64, row.get::<i64, _>("id"))
        }).collect())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}
