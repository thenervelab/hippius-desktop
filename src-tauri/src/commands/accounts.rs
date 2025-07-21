use crate::utils::accounts::{create_and_store_encryption_key, list_encryption_keys, import_encryption_key};
use crate::DB_POOL;
use base64;
use sqlx::Row;

#[tauri::command]
pub async fn create_encryption_key() -> Result<(), String> {
    create_and_store_encryption_key().await
}

#[derive(serde::Serialize)]
pub struct EncryptionKeyInfo {
    pub id: i64,
    pub key: String, // base64 encoded key value
}

#[tauri::command]
pub async fn get_encryption_keys() -> Result<Vec<EncryptionKeyInfo>, String> {
    let keys = crate::utils::accounts::list_encryption_keys().await?;
    Ok(keys.into_iter().map(|(key, id)| EncryptionKeyInfo {
        id,
        key,
    }).collect())
}

#[tauri::command]
pub async fn import_key(key_base64: String) -> Result<String, String> {
    // Decode the base64 key
    let key_bytes = base64::decode(key_base64)
        .map_err(|e| format!("Invalid base64 encoding: {}", e))?;
    
    // Import the key and get its generated name
    import_encryption_key(key_bytes).await
}