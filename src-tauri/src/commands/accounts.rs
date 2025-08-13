use crate::utils::accounts::{create_and_store_encryption_key, list_encryption_keys, import_encryption_key};
use base64;
use crate::folder_sync;
use crate::public_folder_sync;

#[tauri::command]
pub async fn create_encryption_key() -> Result<(), String> {
    create_and_store_encryption_key().await
}

#[derive(serde::Serialize)]
pub struct EncryptionKeyInfo {
    pub id: i64,
    pub key: String,
}

#[tauri::command]
pub async fn get_encryption_keys() -> Result<Vec<EncryptionKeyInfo>, String> {
    let keys = list_encryption_keys().await?;
    println!("keys : {:?}", keys);
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


#[tauri::command]
pub async fn reset_app() -> Result<(), String> {
    println!("[Reset App] Starting app reset...");

    let pool = match crate::DB_POOL.get() {
        Some(p) => p,
        None => return Err("Database pool not initialized".to_string()),
    };

    let tables_to_clear = vec![
        "user_profiles",
        "sync_folder_files",
        "file_paths",
        "encryption_keys",
        "sync_paths",
        "wss_endpoint",
    ];

    for table in tables_to_clear {
        println!("[Reset App] Clearing table: {}", table);
        if let Err(e) = sqlx::query(&format!("DELETE FROM {}", table)).execute(pool).await {
            let error_message = format!("Failed to clear table {}: {}", table, e);
            eprintln!("[Reset App] {}", error_message);
            // Continue to next table even if one fails, to attempt a partial reset.
        }
    }
    
    println!("[Reset App] All tables cleared.");

    // Clear in-memory state for public sync
    if let Ok(mut uploading) = public_folder_sync::UPLOADING_FILES.lock() {
        uploading.clear();
        println!("[Reset App] Cleared public UPLOADING_FILES.");
    }
    if let Ok(mut recently) = public_folder_sync::RECENTLY_UPLOADED.lock() {
        recently.clear();
        println!("[Reset App] Cleared public RECENTLY_UPLOADED.");
    }

    // Clear in-memory state for private sync
    if let Ok(mut uploading) = folder_sync::UPLOADING_FILES.lock() {
        uploading.clear();
        println!("[Reset App] Cleared private UPLOADING_FILES.");
    }
    if let Ok(mut recently) = folder_sync::RECENTLY_UPLOADED.lock() {
        recently.clear();
        println!("[Reset App] Cleared private RECENTLY_UPLOADED.");
    }

    println!("[Reset App] App reset completed. Please restart the application.");
    Ok(())
}