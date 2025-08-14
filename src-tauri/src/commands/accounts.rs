use crate::constants::substrate::WSS_ENDPOINT;
use crate::private_folder_sync;
use crate::public_folder_sync;
use crate::utils::accounts::{
    create_and_store_encryption_key, import_encryption_key, list_encryption_keys,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use sqlx::Row;

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
    Ok(keys
        .into_iter()
        .map(|(key, id)| EncryptionKeyInfo { id, key })
        .collect())
}

#[tauri::command]
pub async fn import_key(key_base64: String) -> Result<String, String> {
    // Decode the base64 key
    let key_bytes =
        base64::decode(key_base64).map_err(|e| format!("Invalid base64 encoding: {}", e))?;

    // Import the key and get its generated name
    import_encryption_key(key_bytes).await
}

#[derive(serde::Serialize)]
pub struct ExportDataResult {
    pub public_sync_path: Option<String>,
    pub private_sync_path: Option<String>,
    pub encryption_keys: Vec<String>, // base64 encoded keys
}

#[derive(serde::Deserialize)]
pub struct ImportDataParams {
    pub public_sync_path: Option<String>,
    pub private_sync_path: Option<String>,
    pub encryption_keys: Vec<String>, // base64 encoded keys
}

#[tauri::command]
pub async fn import_app_data(params: ImportDataParams) -> Result<String, String> {
    println!("[Import] Starting app data import...");

    let pool = match crate::DB_POOL.get() {
        Some(p) => p,
        None => return Err("Database pool not initialized".to_string()),
    };

    let mut imported_items = Vec::new();
    let timestamp = Utc::now().timestamp();

    // Import sync paths
    if let Some(public_path) = params.public_sync_path {
        if !public_path.trim().is_empty() {
            println!("[Import] Importing public sync path: {}", public_path);
            let result = sqlx::query(
                "INSERT INTO sync_paths (path, type, timestamp) VALUES (?, ?, ?)
                ON CONFLICT(type) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp",
            )
            .bind(&public_path)
            .bind("public")
            .bind(timestamp)
            .execute(pool)
            .await;

            match result {
                Ok(_) => {
                    imported_items.push("public sync path".to_string());
                    println!("[Import] Public sync path imported successfully");
                }
                Err(e) => {
                    eprintln!("[Import] Failed to import public sync path: {}", e);
                    return Err(format!("Failed to import public sync path: {}", e));
                }
            }
        }
    }

    if let Some(private_path) = params.private_sync_path {
        if !private_path.trim().is_empty() {
            println!("[Import] Importing private sync path: {}", private_path);
            let result = sqlx::query(
                "INSERT INTO sync_paths (path, type, timestamp) VALUES (?, ?, ?)
                ON CONFLICT(type) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp",
            )
            .bind(&private_path)
            .bind("private")
            .bind(timestamp)
            .execute(pool)
            .await;

            match result {
                Ok(_) => {
                    imported_items.push("private sync path".to_string());
                    println!("[Import] Private sync path imported successfully");
                }
                Err(e) => {
                    eprintln!("[Import] Failed to import private sync path: {}", e);
                    return Err(format!("Failed to import private sync path: {}", e));
                }
            }
        }
    }

    // Import encryption keys
    let mut key_count = 0;
    for key_base64 in params.encryption_keys {
        if !key_base64.trim().is_empty() {
            println!("[Import] Importing encryption key...");

            // Decode the base64 key
            let key_bytes = match base64::decode(key_base64) {
                Ok(bytes) => bytes,
                Err(e) => {
                    eprintln!("[Import] Invalid base64 encoding for encryption key: {}", e);
                    continue; // Skip this key and continue with others
                }
            };

            // Import the key
            match import_encryption_key(key_bytes).await {
                Ok(key_name) => {
                    key_count += 1;
                    println!(
                        "[Import] Encryption key imported successfully: {}",
                        key_name
                    );
                }
                Err(e) => {
                    eprintln!("[Import] Failed to import encryption key: {}", e);
                    // Continue with other keys instead of failing completely
                }
            }
        }
    }

    if key_count > 0 {
        imported_items.push(format!("{} encryption key(s)", key_count));
    }

    if imported_items.is_empty() {
        return Err("No data was imported. Please check your input data.".to_string());
    }

    let success_message = format!("Successfully imported: {}", imported_items.join(", "));
    println!("[Import] {}", success_message);
    Ok(success_message)
}

#[tauri::command]
pub async fn export_app_data() -> Result<ExportDataResult, String> {
    println!("[Export] Starting app data export...");

    let pool = match crate::DB_POOL.get() {
        Some(p) => p,
        None => return Err("Database pool not initialized".to_string()),
    };

    // Get sync paths
    let public_sync_path = sqlx::query("SELECT path FROM sync_paths WHERE type = ?")
        .bind("public")
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to fetch public sync path: {}", e))?
        .map(|row| row.get::<String, _>("path"));

    let private_sync_path = sqlx::query("SELECT path FROM sync_paths WHERE type = ?")
        .bind("private")
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to fetch private sync path: {}", e))?
        .map(|row| row.get::<String, _>("path"));

    // Get encryption keys
    let keys = list_encryption_keys()
        .await
        .map_err(|e| format!("Failed to fetch encryption keys: {}", e))?;

    let encryption_keys: Vec<String> = keys.into_iter().map(|(key, _id)| key).collect();

    println!(
        "[Export] Exported {} encryption keys, public path: {:?}, private path: {:?}",
        encryption_keys.len(),
        public_sync_path,
        private_sync_path
    );

    Ok(ExportDataResult {
        public_sync_path,
        private_sync_path,
        encryption_keys,
    })
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
        if let Err(e) = sqlx::query(&format!("DELETE FROM {}", table))
            .execute(pool)
            .await
        {
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
    if let Ok(mut uploading) = private_folder_sync::UPLOADING_FILES.lock() {
        uploading.clear();
        println!("[Reset App] Cleared private UPLOADING_FILES.");
    }
    if let Ok(mut recently) = private_folder_sync::RECENTLY_UPLOADED.lock() {
        recently.clear();
        println!("[Reset App] Cleared private RECENTLY_UPLOADED.");
    }

    println!("[Reset App] Restoring default WSS endpoint...");
    if let Err(e) = sqlx::query("INSERT OR REPLACE INTO wss_endpoint (id, endpoint) VALUES (1, ?)")
        .bind(WSS_ENDPOINT)
        .execute(pool)
        .await
    {
        eprintln!("[Reset App] Failed to restore default WSS endpoint: {}", e);
    }

    println!("[Reset App] Creating new initial encryption key...");
    if let Err(e) = crate::utils::accounts::create_and_store_encryption_key().await {
        eprintln!("[Reset App] Failed to create initial encryption key: {}", e);
    } else {
        println!("[Reset App] Initial encryption key created successfully.");
    }

    println!("[Reset App] App reset completed.");
    Ok(())
}
