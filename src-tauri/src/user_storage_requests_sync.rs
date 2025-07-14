use crate::commands::substrate_tx::custom_runtime;
use crate::substrate_client::get_substrate_client;
use crate::DB_POOL;
use hex;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::Serialize;
use serde_json;
use sqlx::FromRow;
use sqlx::Row;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use subxt::storage::StorageKeyValuePair;
use subxt::utils::AccountId32;
use tokio::time;

static SYNCING_ACCOUNTS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UserStorageRequest {
    pub owner: String,
    pub file_hash: String,
    pub file_name: String,
    pub total_replicas: i64,
    pub last_charged_at: i64,
    pub created_at: i64,
    pub selected_validator: String,
    pub is_assigned: bool,
    pub miner_ids: Option<String>,
    pub block_number: i64,
    pub source: String,
}

fn decode_bounded_vec_to_string(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| hex::encode(bytes))
}

// Helper to extract the file_hash from raw storage key
fn extract_file_hash(key: &[u8]) -> Vec<u8> {
    key[key.len() - 32..].to_vec()
}

pub fn start_user_storage_requests_sync(account_id: &str) {
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(account_id) {
            return;
        }
        syncing_accounts.insert(account_id.to_string());
    }

    let account_id = account_id.to_string();
    tokio::spawn(async move {
        let client = Client::new();
        loop {
            println!("[StorageRequestsSync] Periodic check: scanning for storage requests...");

            let api = match get_substrate_client().await {
                Ok(api) => api,
                Err(e) => {
                    eprintln!("[StorageRequestsSync] Failed to get substrate client: {e}");
                    continue;
                }
            };

            let account: AccountId32 = match account_id.parse() {
                Ok(acc) => acc,
                Err(e) => {
                    eprintln!("[StorageRequestsSync] Invalid account id: {e}");
                    continue;
                }
            };

            let storage = match api.storage().at_latest().await {
                Ok(storage) => storage,
                Err(e) => {
                    eprintln!("[StorageRequestsSync] Failed to get latest storage: {e}");
                    continue;
                }
            };

            let storage_query = custom_runtime::storage()
                .ipfs_pallet()
                .user_storage_requests_iter();

            let mut iter = match storage.iter(storage_query).await {
                Ok(i) => i,
                Err(e) => {
                    eprintln!("[StorageRequestsSync] Error fetching iterator: {e}");
                    continue;
                }
            };

            let mut storage_requests = Vec::new();
            let mut total_entries = 0;
            while let Some(result) = iter.next().await {
                total_entries += 1;
                match result {
                    Ok(StorageKeyValuePair {
                        key_bytes, value, ..
                    }) => {
                        // Log raw key bytes and value for debugging
                        if let Some(storage_request) = value {
                            if storage_request.owner == account {
                                let file_hash_str =
                                    decode_bounded_vec_to_string(&storage_request.file_hash.0);
                                let decoded_hash = hex::decode(&file_hash_str.as_bytes().to_vec())
                                    .unwrap_or_else(|_| Vec::new());
                                let hash_str =
                                    std::str::from_utf8(&decoded_hash).unwrap_or_else(|_| "");
                                let hash_string = hash_str.to_string();
                                storage_requests.push((hash_string, storage_request));
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[StorageRequestsSync] Entry #{} - Error decoding entry for account {}: {e}", total_entries, account_id);
                    }
                }
            }

            if let Some(pool) = DB_POOL.get() {
                let _ =
                    sqlx::query("DELETE FROM user_profiles WHERE owner = ? AND is_assigned = ?")
                        .bind(&account_id)
                        .bind(false)
                        .execute(pool)
                        .await;

                for (file_hash_str, storage_request) in &storage_requests {
                    let file_name = decode_bounded_vec_to_string(&storage_request.file_name.0);
                    let owner_ss58 = format!("{}", storage_request.owner);
                    let validator_ss58 = format!("{}", storage_request.selected_validator);
                    let block_number = storage_request.last_charged_at as i64;

                    let miner_ids_json = if let Some(miner_ids) = &storage_request.miner_ids {
                        let miner_ids_vec: Vec<String> = miner_ids
                            .0
                            .iter()
                            .map(|id| decode_bounded_vec_to_string(&id.0))
                            .collect();
                        serde_json::to_string(&miner_ids_vec).unwrap_or_else(|_| "[]".to_string())
                    } else {
                        "[]".to_string() // Always return a JSON array string
                    };

                    let insert_result = sqlx::query(
                        "INSERT INTO user_profiles (
                            owner, file_hash, file_name, total_replicas, 
                            last_charged_at, selected_validator, 
                            is_assigned, main_req_hash, source, cid, profile_cid, block_number, miner_ids
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(&owner_ss58)
                    .bind(&file_hash_str)
                    .bind(&file_name)
                    .bind(storage_request.total_replicas as i64)
                    .bind(storage_request.last_charged_at as i64)
                    .bind(&validator_ss58)
                    .bind(storage_request.is_assigned)
                    .bind(&file_hash_str)
                    .bind("Hippius")
                    .bind(&file_hash_str)
                    .bind("") // profile_cid as empty string
                    .bind(block_number)
                    .bind(&miner_ids_json) // <-- new binding
                    .execute(pool)
                    .await;

                    match insert_result {
                        Ok(_) => {}
                        Err(e) => eprintln!(
                            "[StorageRequestsSync] Failed to insert storage request '{}': {e}",
                            file_name
                        ),
                    }
                }
            }
            time::sleep(Duration::from_secs(120)).await;
        }
    });
}

#[tauri::command]
pub async fn start_user_storage_requests_sync_tauri(account_id: String) {
    start_user_storage_requests_sync(&account_id);
}

#[tauri::command]
pub async fn get_user_storage_requests(owner: String) -> Result<Vec<UserStorageRequest>, String> {
    if let Some(pool) = DB_POOL.get() {
        let query = sqlx::query(
            r#"
            SELECT owner, file_hash, file_name, total_replicas,
                   last_charged_at, selected_validator,
                   is_assigned, main_req_hash, source
              FROM user_profiles
             WHERE owner = ? AND is_assigned = ?
            "#,
        )
        .bind(&owner)
        .bind(false);

        match query.fetch_all(pool).await {
            Ok(rows) => {
                let mut storage_requests = Vec::new();
                for row in rows {
                    storage_requests.push(UserStorageRequest {
                        owner: row.get("owner"),
                        file_hash: row.get("file_hash"),
                        file_name: row.get("file_name"),
                        total_replicas: row.get("total_replicas"),
                        last_charged_at: row.get("last_charged_at"),
                        created_at: 0,
                        selected_validator: row.get("selected_validator"),
                        is_assigned: row.get("is_assigned"),
                        miner_ids: row.get("main_req_hash"),
                        block_number: 0,
                        source: row.get("source"),
                    });
                }
                Ok(storage_requests)
            }
            Err(e) => Err(format!("Database error: {}", e)),
        }
    } else {
        Err("DB not initialized".to_string())
    }
}
