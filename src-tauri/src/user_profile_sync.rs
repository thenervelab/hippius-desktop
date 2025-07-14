use std::time::Duration;
use tokio::time;
use crate::substrate_client::get_substrate_client;
use subxt::utils::AccountId32;
use reqwest::Client;
use crate::DB_POOL;
use crate::commands::substrate_tx::custom_runtime;
use hex;
use serde::Serialize;
use sqlx::FromRow;
use sqlx::Row;
use std::collections::HashSet;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use std::path::Path;
use crate::constants::substrate::{SYNC_PATH};

// Track which accounts are already syncing to prevent duplicates
static SYNCING_ACCOUNTS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileFile {
  pub owner: String,
  pub cid: String,
  pub file_hash: String,
  pub file_name: String,
  pub file_size_in_bytes: i64,
  pub is_assigned: bool,
  pub last_charged_at: i64,
  pub main_req_hash: String,
  pub selected_validator: String,
  pub total_replicas: i64,
  pub block_number: i64,
  pub profile_cid: String,
  pub source: String,
}

/// Decode BoundedVec<u8> into a readable string
fn decode_bounded_vec_to_string(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| hex::encode(bytes))
}

pub fn start_user_profile_sync(_account_id: &str) {
    let account_id = "5CRyFwmSHJC7EeGLGbU1G8ycuoxu8sQxExhfBhkwNPtQU5n2";
    // Check if this account is already syncing
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(account_id) {
            println!("[UserProfileSync] Account {} is already syncing, skipping.", account_id);
            return;
        }
        syncing_accounts.insert(account_id.to_string());
    }
    
    let account_id = account_id.to_string();
    tokio::spawn(async move {
        let client = Client::new();
        loop {
            // (2) Wait 2 minutes before the next sync
            time::sleep(Duration::from_secs(120)).await;
            println!("[ProfileSync] Periodic check: scanning for unsynced files...");

            let api = match get_substrate_client().await {
                Ok(api) => api,
                Err(e) => {
                    eprintln!("[UserProfileSync] Failed to get substrate client: {e}");
                    continue;
                }
            };

            let account: AccountId32 = match account_id.parse() {
                Ok(acc) => acc,
                Err(e) => {
                    eprintln!("[UserProfileSync] Invalid account id: {e}");
                    continue;
                }
            };

            // 🔍 Use generated storage accessor for the UserProfile map
            let storage = match api.storage().at_latest().await {
                Ok(storage) => storage,
                Err(e) => {
                    eprintln!("[UserProfileSync] Failed to get latest storage: {e}");
                    continue;
                }
            };
            
            let res = match storage.fetch(&custom_runtime::storage().ipfs_pallet().user_profile(&account)).await {
                Ok(val) => val,
                Err(e) => {
                    eprintln!("[UserProfileSync] Error fetching UserProfile: {e}");
                    continue;
                }
            };
                        
            let cid = match res {
                Some(bounded_vec) => {
                    // bounded_vec is BoundedVec<u8>, so extract inner Vec<u8>
                    decode_bounded_vec_to_string(&bounded_vec.0)
                }
                None => {
                    if let Some(pool) = DB_POOL.get() {
                        let _ = sqlx::query("DELETE FROM user_profiles WHERE owner = ?")
                            .bind(&account_id)
                            .execute(pool)
                            .await;
                    }
                    continue;
                }
            };

            let ipfs_url = format!("https://get.hippius.network/ipfs/{}", cid);

            match client.get(&ipfs_url).send().await {
                Ok(resp) => {
                    if let Ok(data) = resp.text().await {
                        if let Ok(profile_data) = serde_json::from_str::<serde_json::Value>(&data) {
                            if let Some(pool) = DB_POOL.get() {
                                let _clear_result = sqlx::query("DELETE FROM user_profiles WHERE owner = ?")
                                    .bind(&account_id)
                                    .execute(pool)
                                    .await;

                                if let Some(files) = profile_data.as_array() {
                                    for file in files {
                                        let file_hash = if let Some(v) = file.get("file_hash") {
                                            if let Some(s) = v.as_str() {
                                                s.to_string()
                                            } else if let Some(arr) = v.as_array() {
                                                let bytes: Vec<u8> = arr.iter().filter_map(|n| n.as_u64().map(|u| u as u8)).collect();
                                                hex::encode(bytes)
                                            } else {
                                                "".to_string()
                                            }
                                        } else {
                                            "".to_string()
                                        };
                                        let file_name = file.get("file_name").and_then(|v| v.as_str()).unwrap_or_default();
                                        let file_size_in_bytes = file.get("file_size_in_bytes").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let is_assigned = file.get("is_assigned").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let last_charged_at = file.get("last_charged_at").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let main_req_hash = file.get("main_req_hash").and_then(|v| v.as_str()).unwrap_or_default();
                                        let selected_validator = file.get("selected_validator").and_then(|v| v.as_str()).unwrap_or_default();
                                        let total_replicas = file.get("total_replicas").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let sync_folder_path = SYNC_PATH; 
                                        let file_in_sync_folder = std::path::Path::new(sync_folder_path).join(file_name);
                                        let source_value = if file_in_sync_folder.exists() {
                                            sync_folder_path
                                        } else {
                                            "Hippius"
                                        };

                                        let miner_ids_json = if let Some(miner_ids) = file.get("miner_ids").and_then(|v| v.as_array()) {
                                            let ids: Vec<String> = miner_ids.iter().filter_map(|id| id.as_str().map(|s| s.to_string())).collect();
                                            serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
                                        } else {
                                            "[]".to_string()
                                        };

                                        if let Some(pool) = DB_POOL.get() {
                                            // Delete any unassigned record for this file
                                            let _ = sqlx::query(
                                                "DELETE FROM user_profiles WHERE owner = ? AND file_name = ? AND is_assigned = ?"
                                            )
                                            .bind(&account_id)
                                            .bind(file_name)
                                            .bind(false)
                                            .execute(pool)
                                            .await;

                                        let insert_result = sqlx::query(
                                            "INSERT INTO user_profiles (
                                                owner, cid, file_hash, file_name, file_size_in_bytes, 
                                                is_assigned, last_charged_at, main_req_hash, 
                                                selected_validator, total_replicas, block_number, profile_cid, source, miner_ids
                                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                                        )
                                        .bind(&account_id)
                                        .bind(&cid)
                                        .bind(file_hash)
                                        .bind(file_name)
                                        .bind(file_size_in_bytes)
                                        .bind(is_assigned)
                                        .bind(last_charged_at)
                                        .bind(main_req_hash)
                                        .bind(selected_validator)
                                        .bind(total_replicas)
                                        .bind(0)
                                        .bind("")
                                        .bind(source_value)
                                        .bind(&miner_ids_json)
                                        .execute(pool)
                                        .await;

                                        match insert_result {
                                            Ok(_) => {},
                                            Err(e) => eprintln!("[UserProfileSync] Failed to insert file '{}' for owner '{}': {e}", file_name, account_id),
                                            }
                                        }
                                    }
                                } else {
                                    println!("[UserProfileSync] No files array found in profile data for CID: {}", cid);
                                }
                            }
                        } else {
                            eprintln!("[UserProfileSync] Invalid JSON for CID {}: {}", cid, data);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[UserProfileSync] Failed to fetch from IPFS: {e}");
                }
            }
        }
    });
}

#[tauri::command]
pub async fn start_user_profile_sync_tauri(account_id: String) {
    println!("starting profile sync {:?}", account_id);
    start_user_profile_sync(&account_id);
}

#[tauri::command]
pub async fn get_user_synced_files(owner: String) -> Result<Vec<UserProfileFile>, String> {
    if let Some(pool) = DB_POOL.get() {
        // Use dynamic query instead of compile-time checked macro
        let query = sqlx::query(
            r#"
            SELECT owner, cid, file_hash, file_name,
                   file_size_in_bytes, is_assigned, last_charged_at,
                   main_req_hash, selected_validator,
                   total_replicas, block_number, profile_cid, source
              FROM user_profiles
             WHERE owner = ?
            "#
        )
        .bind(owner);
        
        match query.fetch_all(pool).await {
            Ok(rows) => {
                let mut files = Vec::new();
                for row in rows {
                    files.push(UserProfileFile {
                        owner: row.get("owner"),
                        cid: row.get("cid"),
                        file_hash: row.get("file_hash"),
                        file_name: row.get("file_name"),
                        file_size_in_bytes: row.get("file_size_in_bytes"),
                        is_assigned: row.get("is_assigned"),
                        last_charged_at: row.get("last_charged_at"),
                        main_req_hash: row.get("main_req_hash"),
                        selected_validator: row.get("selected_validator"),
                        total_replicas: row.get("total_replicas"),
                        block_number: row.get("block_number"),
                        profile_cid: row.get("profile_cid"),
                        source: row.get("source"),
                    });
                }
                Ok(files)
            },
            Err(e) => Err(format!("Database error: {}", e)),
        }
    } else {
        Err("DB not initialized".to_string())
    }
}