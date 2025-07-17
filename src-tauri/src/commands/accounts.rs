use crate::utils::accounts::{create_and_store_encryption_key};
use crate::DB_POOL;
use sqlx::Row;

#[tauri::command]
pub async fn create_encryption_key() -> Result<(), String> {
    create_and_store_encryption_key().await
}

#[derive(serde::Serialize)]
pub struct EncryptionKeyInfo {
    pub id: i64,
    pub key: String, // base64 encoded
}

#[tauri::command]
pub async fn get_encryption_keys() -> Result<Vec<EncryptionKeyInfo>, String> {
    if let Some(pool) = DB_POOL.get() {
        let rows = sqlx::query("SELECT id, key FROM encryption_keys ORDER BY id DESC")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("DB error (fetch keys): {}", e))?;
        let keys = rows.into_iter().map(|row| EncryptionKeyInfo {
            id: row.get("id"),
            key: base64::encode(row.get::<Vec<u8>, _>("key")),
        }).collect();
        Ok(keys)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}
