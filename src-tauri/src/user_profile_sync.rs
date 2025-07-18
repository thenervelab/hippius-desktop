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
use std::path::Path;
use std::collections::{HashSet, HashMap};
use std::sync::Mutex;
use once_cell::sync::Lazy;
use crate::utils::sync::get_private_sync_path;
use subxt::storage::StorageKeyValuePair;
use serde_json;
use sqlx::Row;
use std::str;

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
    pub miner_ids: Option<String>,
}

/// Decode BoundedVec<u8> into a readable string
fn bounded_vec_to_string(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| hex::encode(bytes))
}

pub fn decode_file_hash(file_hash_bytes: &[u8]) -> Result<String, String> {
    // Convert the byte slice to a hex string
    let hex_str = String::from_utf8_lossy(file_hash_bytes).to_string();

    // Remove "0x" prefix if present
    let clean_hex = hex_str.trim_start_matches("0x");

    // Decode the hex string into bytes
    let decoded_bytes = hex::decode(clean_hex)
        .map_err(|e| format!("Hex decode error: {}", e))?;

    // Convert bytes to UTF-8 string
    let decoded_str = str::from_utf8(&decoded_bytes)
        .map_err(|e| format!("UTF-8 conversion error: {}", e))?;

    Ok(decoded_str.to_string())
}

/// Combined sync function for user profiles and storage requests
pub fn start_user_sync(account_id: &str) {
    // Check if this account is already syncing
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(account_id) {
            println!("[UserSync] Account {} is already syncing, skipping.", account_id);
            return;
        }
        syncing_accounts.insert(account_id.to_string());
    }

    let account_id = account_id.to_string();
    tokio::spawn(async move {
        let client = Client::new();
        let mut retry_count = 0;
        let max_retries = 5;
        
        loop {
            println!("[UserSync] Periodic check: scanning for unsynced data...");

            // Get substrate client with retry mechanism
            let api = loop {
                match get_substrate_client().await {
                    Ok(api) => {
                        println!("[UserSync] Successfully connected to substrate node");
                        retry_count = 0; // Reset retry count on successful connection
                        break api;
                    }
                    Err(e) => {
                        retry_count += 1;
                        let wait_time = std::cmp::min(30 * retry_count, 300); // Max 5 minutes
                        eprintln!("[UserSync] Failed to get substrate client (attempt {}/{}): {e}", retry_count, max_retries);
                        
                        if retry_count >= max_retries {
                            eprintln!("[UserSync] Max retries reached, waiting 5 minutes before trying again");
                            time::sleep(Duration::from_secs(300)).await;
                            retry_count = 0; // Reset for next cycle
                        } else {
                            eprintln!("[UserSync] Retrying in {} seconds...", wait_time);
                            time::sleep(Duration::from_secs(wait_time as u64)).await;
                        }
                    }
                }
            };

            let account: AccountId32 = match account_id.parse() {
                Ok(acc) => acc,
                Err(e) => {
                    eprintln!("[UserSync] Invalid account id: {e}");
                    time::sleep(Duration::from_secs(120)).await;
                    continue;
                }
            };

            // Get storage with retry mechanism
            let storage = loop {
                match api.storage().at_latest().await {
                    Ok(storage) => {
                        println!("[UserSync] Successfully got latest storage");
                        break storage;
                    }
                    Err(e) => {
                        eprintln!("[UserSync] Failed to get latest storage: {e}");
                        if e.to_string().contains("background task closed") || e.to_string().contains("Operation timed out") {
                            crate::substrate_client::clear_substrate_client();
                        }
                        eprintln!("[UserSync] This might be a connection issue, retrying in 30 seconds...");
                        time::sleep(Duration::from_secs(30)).await;
                    }
                }
            };

            // Collect all records to insert, ensuring no duplicates
            let mut records_to_insert: Vec<UserProfileFile> = Vec::new();
            let mut seen_files: HashSet<(String, String)> = HashSet::new(); // Track (file_hash, file_name)

            // Step 1: Fetch and parse user profile data
            let profile_res = storage
                .fetch(&custom_runtime::storage().ipfs_pallet().user_profile(&account))
                .await;

            let profile_cid = match profile_res {
                Ok(Some(bounded_vec)) => bounded_vec_to_string(&bounded_vec.0),
                Ok(None) => {
                    println!("[UserSync] No user profile found for account: {}", account_id);
                    String::new()
                }
                Err(e) => {
                    eprintln!("[UserSync] Error fetching UserProfile: {e}");
                    time::sleep(Duration::from_secs(120)).await;
                    continue;
                }
            };

            if !profile_cid.is_empty() {
                let ipfs_url = format!("https://get.hippius.network/ipfs/{}", profile_cid);
                match client.get(&ipfs_url).send().await {
                    Ok(resp) => {
                        if let Ok(data) = resp.text().await {
                            if let Ok(profile_data) = serde_json::from_str::<serde_json::Value>(&data) {
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
                                        let file_name = file.get("file_name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                        let file_size_in_bytes = file.get("file_size_in_bytes").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let is_assigned = file.get("is_assigned").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let last_charged_at = file.get("last_charged_at").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let main_req_hash = file.get("main_req_hash").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                        let selected_validator = file.get("selected_validator").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                        let total_replicas = file.get("total_replicas").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let file_in_sync_folder = Path::new(&get_private_sync_path().await).join(&file_name);
                                        let source_value = if file_in_sync_folder.exists() {
                                            format!("{}/{}", &get_private_sync_path().await, file_name)                                            
                                        } else {
                                            "Hippius".to_string()
                                        };

                                        let miner_ids_json = if let Some(miner_ids) = file.get("miner_ids").and_then(|v| v.as_array()) {
                                            let ids: Vec<String> = miner_ids.iter().filter_map(|id| id.as_str().map(|s| s.to_string())).collect();
                                            serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
                                        } else {
                                            "[]".to_string()
                                        };

                                        let file_key = (file_hash.clone(), file_name.clone());
                                        if seen_files.insert(file_key) {
                                            println!("[UserSync] Adding user profile file: {}", file_hash);
                                            records_to_insert.push(UserProfileFile {
                                                owner: account_id.clone(),
                                                cid: profile_cid.clone(),
                                                file_hash,
                                                file_name,
                                                file_size_in_bytes,
                                                is_assigned,
                                                last_charged_at,
                                                main_req_hash,
                                                selected_validator,
                                                total_replicas,
                                                block_number: 0,
                                                profile_cid: profile_cid.clone(),
                                                source: source_value,
                                                miner_ids: Some(miner_ids_json),
                                            });
                                        }
                                    }
                                } else {
                                    println!("[UserSync] No files array found in profile data for CID: {}", profile_cid);
                                }
                            } else {
                                eprintln!("[UserSync] Invalid JSON for CID {}: {}", profile_cid, data);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[UserSync] Failed to fetch from IPFS: {e}");
                    }
                }
            }

            // Step 2: Fetch and parse storage requests
            let storage_query = custom_runtime::storage()
                .ipfs_pallet()
                .user_storage_requests_iter();
            let mut iter = match storage.iter(storage_query).await {
                Ok(i) => i,
                Err(e) => {
                    eprintln!("[UserSync] Error fetching storage requests iterator: {e}");
                    time::sleep(Duration::from_secs(120)).await;
                    continue;
                }
            };

            while let Some(result) = iter.next().await {
                match result {
                    Ok(StorageKeyValuePair { value, .. }) => {
                        if let Some(storage_request) = value {
                            if storage_request.owner == account {
                                let file_hash = bounded_vec_to_string(&storage_request.file_hash.0);
                                let decoded_hash = decode_file_hash(&storage_request.file_hash.0)
                                    .unwrap_or_else(|_| "Invalid file hash".to_string());
                                let mut file_size_in_bytes = 0;
                                if decoded_hash != "Invalid file hash" {
                                    match crate::ipfs::get_ipfs_file_size(&decoded_hash).await {
                                        Ok(size) => {
                                            println!("[UserSync] IPFS file size for {}: {} bytes", decoded_hash, size);
                                            file_size_in_bytes = size as i64; // Safe conversion since u64 to i64 for reasonable file sizes
                                        },
                                        Err(e) => eprintln!("[UserSync] Failed to fetch IPFS file size for {}: {}", decoded_hash, e),
                                    }
                                }
                                let file_name = bounded_vec_to_string(&storage_request.file_name.0);
                                let owner_ss58 = format!("{}", storage_request.owner);
                                let validator_ss58 = format!("{}", storage_request.selected_validator);
                                let block_number = storage_request.last_charged_at as i64;

                                let miner_ids_json = if let Some(miner_ids) = &storage_request.miner_ids {
                                    let miner_ids_vec: Vec<String> = miner_ids.0.iter()
                                        .map(|id| bounded_vec_to_string(&id.0))
                                        .collect();
                                    serde_json::to_string(&miner_ids_vec).unwrap_or_else(|_| "[]".to_string())
                                } else {
                                    "[]".to_string()
                                };

                                let file_key = (file_hash.clone(), file_name.clone());
                                if seen_files.insert(file_key) {
                                    println!("[UserSync] Adding storage request file: {}", file_hash.clone());
                                    records_to_insert.push(UserProfileFile {
                                        owner: owner_ss58,
                                        cid: file_hash.clone(),
                                        file_hash: file_hash.clone(),
                                        file_name,
                                        file_size_in_bytes,
                                        is_assigned: storage_request.is_assigned,
                                        last_charged_at: storage_request.last_charged_at as i64,
                                        main_req_hash: file_hash,
                                        selected_validator: validator_ss58,
                                        total_replicas: storage_request.total_replicas as i64,
                                        block_number,
                                        profile_cid: "".to_string(),
                                        source: "Hippius".to_string(),
                                        miner_ids: Some(miner_ids_json),
                                    });
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[UserSync] Error decoding storage request entry: {e}");
                    }
                }
            }

            // Step 3: Clear the entire user_profiles table and insert records
            if let Some(pool) = DB_POOL.get() {
                // Clear all records from user_profiles
                match sqlx::query("DELETE FROM user_profiles")
                    .execute(pool)
                    .await
                {
                    Ok(_) => println!("[UserSync] Cleared user_profiles table"),
                    Err(e) => {
                        eprintln!("[UserSync] Failed to clear user_profiles table: {e}");
                        time::sleep(Duration::from_secs(120)).await;
                        continue;
                    }
                }

                println!("[UserSync] Total records inserted: {}", records_to_insert.len());
                // Insert all collected records
                for record in records_to_insert {
                    let insert_result = sqlx::query(
                        "INSERT INTO user_profiles (
                            owner, cid, file_hash, file_name, file_size_in_bytes,
                            is_assigned, last_charged_at, main_req_hash,
                            selected_validator, total_replicas, block_number, profile_cid, source, miner_ids
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(&record.owner)
                    .bind(&record.cid)
                    .bind(&record.file_hash)
                    .bind(&record.file_name)
                    .bind(record.file_size_in_bytes)
                    .bind(record.is_assigned)
                    .bind(record.last_charged_at)
                    .bind(&record.main_req_hash)
                    .bind(&record.selected_validator)
                    .bind(record.total_replicas)
                    .bind(record.block_number)
                    .bind(&record.profile_cid)
                    .bind(&record.source)
                    .bind(&record.miner_ids)
                    .execute(pool)
                    .await;

                    if let Err(e) = insert_result {
                        eprintln!(
                            "[UserSync] Failed to insert record for file '{}': {e}",
                            record.file_name
                        );
                    }
                }

            }

            // Wait 2 minutes before the next sync
            time::sleep(Duration::from_secs(120)).await;
        }
    });
}

#[tauri::command]
pub async fn get_user_synced_files(owner: String) -> Result<Vec<UserProfileFile>, String> {
    if let Some(pool) = DB_POOL.get() {
        // Fetch all user_profiles records for the owner
        let user_profile_rows = sqlx::query(
            r#"
            SELECT owner, cid, file_hash, file_name,
                   file_size_in_bytes, is_assigned, last_charged_at,
                   main_req_hash, selected_validator,
                   total_replicas, block_number, profile_cid, source, miner_ids
              FROM user_profiles
             WHERE owner = ?
            "#
        )
        .bind(&owner)
        .fetch_all(pool)
        .await;

        // Fetch all file_names from sync_folder_files for this owner
        let sync_file_names = sqlx::query(
            "SELECT file_name FROM sync_folder_files WHERE owner = ?"
        )
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map(|rows| rows.into_iter().map(|row| row.get::<String, _>("file_name")).collect::<HashSet<_>>());

        match (user_profile_rows, sync_file_names) {
            (Ok(user_rows), Ok(sync_names)) => {
                let sync_names_set: HashSet<_> = sync_names;
                let mut files = Vec::new();
                for row in user_rows {
                    let mut file = UserProfileFile {
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
                        miner_ids: row.get("miner_ids"),
                    };
                    if sync_names_set.contains(&file.file_name) {
                        file.source = format!("{}/{}", &get_private_sync_path().await, file.file_name);
                    }
                    files.push(file);
                }
                println!("[UserSync] Returning {} files for owner: {}", files.len(), owner);
                Ok(files)
            }
            (Err(e), _) | (_, Err(e)) => Err(format!("Database error: {}", e)),
        }
    } else {
        Err("DB not initialized".to_string())
    }
}


#[tauri::command]
pub async fn start_user_profile_sync_tauri(account_id: String) {
    println!("[UserSync] Starting sync for account: {}", account_id);
    start_user_sync(&account_id);
}