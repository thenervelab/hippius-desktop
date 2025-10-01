use crate::commands::syncing::{decrypt_phrase, load_encryption_key};
use crate::constants::substrate::WSS_ENDPOINT;
use crate::utils::accounts::{
    create_and_store_encryption_key, import_encryption_key, list_encryption_keys,
};
use chrono::Utc;
use sp_core::crypto::Ss58Codec;
use sp_core::sr25519;
use sp_core::Pair;
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
#[allow(deprecated)]
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
    pub encryption_keys: Vec<String>,
    pub sub_accounts: Vec<SubAccountExport>,
}

#[derive(serde::Deserialize)]
pub struct ImportDataParams {
    pub public_sync_path: Option<String>,
    pub private_sync_path: Option<String>,
    pub encryption_keys: Vec<String>,
    pub sub_accounts: Option<Vec<SubAccountExport>>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubAccountExport {
    pub account_id: String,
    pub sub_account_seed_phrase: String,
    pub created_at: Option<String>,
}

use sha2::{Digest, Sha256};
pub fn generate_key_fingerprint(key_bytes: &[u8]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(key_bytes);
    let result = hasher.finalize();
    Ok(hex::encode(result))
}

#[tauri::command]
#[allow(deprecated)]
pub async fn import_app_data(params: ImportDataParams) -> Result<String, String> {
    println!("[Import] Starting app data import...");

    let pool = match crate::DB_POOL.get() {
        Some(p) => p,
        None => return Err("Database pool not initialized".to_string()),
    };

    let mut imported_items = Vec::new();
    let mut skipped_items = Vec::new();
    let timestamp = Utc::now().timestamp();

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    // Import public sync path
    if let Some(public_path) = params.public_sync_path {
        if !public_path.trim().is_empty() {
            println!("[Import] Importing public sync path: {}", public_path);
            let existing_path: Option<(String,)> =
                sqlx::query_as("SELECT path FROM sync_paths WHERE type = ?")
                    .bind("public")
                    .fetch_optional(&mut *tx) // Fix: Dereference tx
                    .await
                    .map_err(|e| format!("Failed to check existing public sync path: {}", e))?;

            if existing_path.map(|p| p.0) != Some(public_path.clone()) {
                let result = sqlx::query(
                    "INSERT INTO sync_paths (path, type, timestamp) VALUES (?, ?, ?)
                     ON CONFLICT(type) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp",
                )
                .bind(&public_path)
                .bind("public")
                .bind(timestamp)
                .execute(&mut *tx) // Fix: Dereference tx
                .await
                .map_err(|e| format!("Failed to import public sync path: {}", e))?;

                imported_items.push("public sync path".to_string());
                println!("[Import] Public sync path imported successfully");
            } else {
                skipped_items.push("public sync path (duplicate)".to_string());
                println!("[Import] Public sync path already exists, skipping");
            }
        }
    }

    // Import private sync path
    if let Some(private_path) = params.private_sync_path {
        if !private_path.trim().is_empty() {
            println!("[Import] Importing private sync path: {}", private_path);
            let existing_path: Option<(String,)> =
                sqlx::query_as("SELECT path FROM sync_paths WHERE type = ?")
                    .bind("private")
                    .fetch_optional(&mut *tx) // Fix: Dereference tx
                    .await
                    .map_err(|e| format!("Failed to check existing private sync path: {}", e))?;

            if existing_path.map(|p| p.0) != Some(private_path.clone()) {
                let result = sqlx::query(
                    "INSERT INTO sync_paths (path, type, timestamp) VALUES (?, ?, ?)
                     ON CONFLICT(type) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp",
                )
                .bind(&private_path)
                .bind("private")
                .bind(timestamp)
                .execute(&mut *tx) // Fix: Dereference tx
                .await
                .map_err(|e| format!("Failed to import private sync path: {}", e))?;

                imported_items.push("private sync path".to_string());
                println!("[Import] Private sync path imported successfully");
            } else {
                skipped_items.push("private sync path (duplicate)".to_string());
                println!("[Import] Private sync path already exists, skipping");
            }
        }
    }

    // Import encryption keys with deduplication
    let mut key_count = 0;
    for key_base64 in params.encryption_keys {
        if !key_base64.trim().is_empty() {
            println!("[Import] Processing encryption key...");

            // Decode and validate the base64 key
            let key_bytes = match base64::decode(&key_base64) {
                Ok(bytes) => {
                    if bytes.len() != 32 {
                        // Adjust length as needed
                        eprintln!("[Import] Invalid encryption key length: {}", bytes.len());
                        skipped_items.push("encryption key (invalid length)".to_string());
                        continue;
                    }
                    bytes
                }
                Err(e) => {
                    eprintln!("[Import] Invalid base64 encoding for encryption key: {}", e);
                    skipped_items.push("encryption key (invalid base64)".to_string());
                    continue;
                }
            };

            // Generate the key fingerprint
            let key_fingerprint = match generate_key_fingerprint(&key_bytes) {
                Ok(fp) => fp,
                Err(e) => {
                    eprintln!("[Import] Failed to generate key fingerprint: {}", e);
                    skipped_items.push("encryption key (fingerprint error)".to_string());
                    continue;
                }
            };

            // Check if key with this fingerprint already exists
            let key_exists: Option<(i64,)> =
                sqlx::query_as("SELECT 1 FROM encryption_keys WHERE fingerprint = ?")
                    .bind(&key_fingerprint)
                    .fetch_optional(&mut *tx) // Fix: Dereference tx
                    .await
                    .map_err(|e| format!("Failed to check for existing key: {}", e))?;

            if key_exists.is_some() {
                println!("[Import] Encryption key already exists, skipping");
                skipped_items.push("encryption key (duplicate)".to_string());
                continue;
            }

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
                    skipped_items.push("encryption key (import failed)".to_string());
                    continue;
                }
            }
        }
    }

    if key_count > 0 {
        imported_items.push(format!("{} encryption key(s)", key_count));
    }

    // Import sub-accounts with deduplication
    if let Some(sub_accounts) = params.sub_accounts {
        let mut imported_count = 0;
        for account in sub_accounts {
            // First, delete all existing sub-accounts
            sqlx::query("DELETE FROM sub_accounts")
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("Failed to clear existing sub-accounts: {}", e))?;

            println!("[Import] Cleared all existing sub-accounts from database");

            let mut imported_count = 0;
            // Validate sub-account seed phrase
            if account.sub_account_seed_phrase.trim().is_empty() {
                eprintln!(
                    "[Import] Invalid empty seed phrase for account ID: {}",
                    account.account_id
                );
                skipped_items.push(format!("sub-account {} (empty seed)", account.account_id));
                continue;
            }

            // Check if sub-account already exists
            let exists: Option<(i64,)> =
                sqlx::query_as("SELECT 1 FROM sub_accounts WHERE account_id = ?")
                    .bind(&account.account_id)
                    .fetch_optional(&mut *tx) // Fix: Dereference tx
                    .await
                    .map_err(|e| format!("Failed to check for existing sub-account: {}", e))?;

            if exists.is_some() {
                println!(
                    "[Import] Sub-account already exists, skipping: {}",
                    account.account_id
                );
                skipped_items.push(format!("sub-account {} (duplicate)", account.account_id));
                continue;
            }

            let result = sqlx::query(
                "INSERT INTO sub_accounts (account_id, sub_account_seed_phrase, created_at) 
                 VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP))",
            )
            .bind(&account.account_id)
            .bind(&account.sub_account_seed_phrase)
            .bind(account.created_at)
            .execute(&mut *tx) // Fix: Dereference tx
            .await
            .map_err(|e| {
                format!(
                    "Failed to import sub-account for account ID {}: {}",
                    account.account_id, e
                )
            })?;

            imported_count += 1;
            println!(
                "[Import] Imported sub-account for account ID: {}",
                account.account_id
            );
        }

        if imported_count > 0 {
            imported_items.push(format!("{} sub-account(s)", imported_count));
        }
    }

    // Commit the transaction
    tx.commit()
        .await
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    // Construct success message
    let mut message_parts = Vec::new();
    if !imported_items.is_empty() {
        message_parts.push(format!(
            "Successfully imported {}",
            imported_items.join(", ")
        ));
    }
    if !skipped_items.is_empty() {
        message_parts.push(format!("Skipped {}", skipped_items.join(", ")));
    }
    let success_message = if message_parts.is_empty() {
        "No new data was imported. All items already exist.".to_string()
    } else {
        message_parts.join("; ")
    };
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

    // Get sub-accounts
    let sub_accounts_rows =
        sqlx::query("SELECT account_id, sub_account_seed_phrase, created_at FROM sub_accounts")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("Failed to fetch sub-accounts: {}", e))?;

    let sub_accounts = sub_accounts_rows
        .into_iter()
        .map(|row| {
            let account_id: String = row.get("account_id");
            let sub_account_seed_phrase: String = row.get("sub_account_seed_phrase");
            let created_at: Option<String> = row.get("created_at");

            SubAccountExport {
                account_id,
                sub_account_seed_phrase,
                created_at,
            }
        })
        .collect::<Vec<_>>();
    println!(
        "[Export] Exported {} encryption keys, {} sub-accounts, public path: {:?}, private path: {:?}",
        encryption_keys.len(),
        sub_accounts.len(),
        public_sync_path,
        private_sync_path
    );

    Ok(ExportDataResult {
        public_sync_path,
        private_sync_path,
        encryption_keys,
        sub_accounts,
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
        "sub_accounts",
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

#[tauri::command]
pub async fn get_all_subaccount_addresses() -> Result<Vec<(String, String)>, String> {
    let pool = match crate::DB_POOL.get() {
        Some(pool) => pool,
        None => return Err("Database pool not available".to_string()),
    };

    // Get all sub-account seed phrases
    let sub_accounts = match sqlx::query_as::<_, (String, String)>(
        "SELECT account_id, sub_account_seed_phrase FROM sub_accounts",
    )
    .fetch_all(pool)
    .await
    {
        Ok(accounts) => accounts,
        Err(e) => return Err(format!("Failed to fetch sub-accounts: {}", e)),
    };

    let mut result = Vec::new();

    // Try to load encryption key for decryption
    let maybe_key = load_encryption_key(pool).await;

    for (account_id, encrypted_phrase) in sub_accounts {
        // Try to decrypt if we have a key, otherwise use as-is
        let phrase = if let Some(key) = &maybe_key {
            decrypt_phrase(&encrypted_phrase, key).unwrap_or_else(|| encrypted_phrase.clone())
        } else {
            encrypted_phrase
        };

        // Convert mnemonic to keypair and get SS58 address
        if let Ok((pair, _seed)) = sr25519::Pair::from_phrase(&phrase, None) {
            let ss58 = pair.public().to_ss58check();
            result.push((account_id, ss58));
        } else {
            eprintln!(
                "Failed to create keypair from phrase for account_id: {}",
                account_id
            );
        }
    }

    Ok(result)
}
