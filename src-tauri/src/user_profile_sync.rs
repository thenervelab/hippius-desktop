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
}

/// Decode BoundedVec<u8> into a readable string
fn decode_bounded_vec_to_string(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| hex::encode(bytes))
}

pub fn start_user_profile_sync(account_id: &str) {
    let account_id = account_id.to_string();
    tokio::spawn(async move {
        let client = Client::new();
        loop {
            // sync profile after every 40 secs
            time::sleep(Duration::from_secs(40)).await;

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
                                        let file_hash = file.get("file_hash").and_then(|v| v.as_str()).unwrap_or_default();
                                        let file_name = file.get("file_name").and_then(|v| v.as_str()).unwrap_or_default();
                                        let file_size_in_bytes = file.get("file_size_in_bytes").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let is_assigned = file.get("is_assigned").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let last_charged_at = file.get("last_charged_at").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let main_req_hash = file.get("main_req_hash").and_then(|v| v.as_str()).unwrap_or_default();
                                        let selected_validator = file.get("selected_validator").and_then(|v| v.as_str()).unwrap_or_default();
                                        let total_replicas = file.get("total_replicas").and_then(|v| v.as_i64()).unwrap_or(0);

                                        let insert_result = sqlx::query(
                                            "INSERT INTO user_profiles (
                                                owner, cid, file_hash, file_name, file_size_in_bytes, 
                                                is_assigned, last_charged_at, main_req_hash, 
                                                selected_validator, total_replicas, block_number, profile_cid
                                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
                                        .execute(pool)
                                        .await;

                                        match insert_result {
                                            Ok(_) => println!("[UserProfileSync] Inserted file '{}' for owner '{}'", file_name, account_id),
                                            Err(e) => eprintln!("[UserProfileSync] Failed to insert file '{}' for owner '{}': {e}", file_name, account_id),
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
                   total_replicas, block_number, profile_cid
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
