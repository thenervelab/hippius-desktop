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
use std::collections::HashSet;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use subxt::storage::StorageKeyValuePair;
use serde_json;
use sqlx::Row;
use std::str;

use sqlx::SqlitePool;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSizeBreakdown {
    pub public_size: i64,
    pub private_size: i64,
}

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
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileFileWithType {
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
    pub created_at: i64,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub type_: String,
}

/// Decode BoundedVec<u8> into a readable string
fn bounded_vec_to_string(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| hex::encode(bytes))
}

pub fn decode_file_hash(file_hash_bytes: &[u8]) -> Result<String, String> {
    let hex_str = String::from_utf8_lossy(file_hash_bytes).to_string();
    let clean_hex = hex_str.trim_start_matches("0x");
    let decoded_bytes = hex::decode(clean_hex)
        .map_err(|e| format!("Hex decode error: {}", e))?;
    let decoded_str = str::from_utf8(&decoded_bytes)
        .map_err(|e| format!("UTF-8 conversion error: {}", e))?;
    Ok(decoded_str.to_string())
}

/// Combined sync function for user profiles and storage requests
pub fn start_user_sync(account_id: &str) {
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
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|e| {
                eprintln!("[UserSync] Failed to build HTTP client: {}", e);
                Client::new()
            });
        let mut retry_count = 0;
        let max_retries = 5;

        // Initialize api outside the loop to allow refreshing
        let mut api = match get_substrate_client().await {
            Ok(api) => {
                println!("[UserSync] Successfully connected to substrate node");
                api
            }
            Err(e) => {
                eprintln!("[UserSync] Failed to get initial substrate client: {}", e);
                time::sleep(Duration::from_secs(120)).await;
                return; // Exit if initial connection fails
            }
        };

        loop {
            println!("[UserSync] Periodic check: scanning for unsynced data...");

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
                        retry_count = 0;
                        break storage;
                    }
                    Err(e) => {
                        retry_count += 1;
                        eprintln!("[UserSync] Failed to get latest storage (attempt {}/{}): {e}", retry_count, max_retries);
                        crate::substrate_client::clear_substrate_client();

                        // Refresh the client after clearing
                        match get_substrate_client().await {
                            Ok(new_api) => {
                                api = new_api; // Update api with the new client
                                println!("[UserSync] Successfully reconnected to substrate node");
                            }
                            Err(e) => {
                                eprintln!("[UserSync] Failed to reconnect to substrate client: {}", e);
                                if retry_count >= max_retries {
                                    eprintln!("[UserSync] Max retries reached, waiting 5 minutes before trying again");
                                    time::sleep(Duration::from_secs(300)).await;
                                    retry_count = 0;
                                    continue; // Continue to retry after long delay
                                } else {
                                    let wait_time = std::cmp::min(30 * retry_count, 300);
                                    eprintln!("[UserSync] Retrying in {} seconds...", wait_time);
                                    time::sleep(Duration::from_secs(wait_time as u64)).await;
                                }
                                continue; // Continue to retry getting storage
                            }
                        }
                    }
                }
            };

            let mut records_to_insert: Vec<UserProfileFile> = Vec::new();
            let mut seen_files: HashSet<(String, String)> = HashSet::new();

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
                                        let main_req_hash = file.get("main_req_hash")
                                            .and_then(|v| v.as_str())
                                            .map(|s| {
                                                // Try to decode hex to bytes, then bytes to string
                                                match hex::decode(s) {
                                                    Ok(bytes) => match String::from_utf8(bytes) {
                                                        Ok(decoded) => decoded,
                                                        Err(_) => s.to_string(), // fallback to original if not valid UTF-8
                                                    },
                                                    Err(_) => s.to_string(), // fallback to original if not valid hex
                                                }
                                            })
                                            .unwrap_or_default();
                                        let selected_validator = file.get("selected_validator").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                        let total_replicas = file.get("total_replicas").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let created_at = file.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
                                        let source_value = "Hippius".to_string();

                                        let miner_ids_json = if let Some(miner_ids) = file.get("miner_ids").and_then(|v| v.as_array()) {
                                            let ids: Vec<String> = miner_ids.iter().filter_map(|id| id.as_str().map(|s| s.to_string())).collect();
                                            serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
                                        } else {
                                            "[]".to_string()
                                        };

                                        let file_key = (file_hash.clone(), file_name.clone());
                                        if seen_files.insert(file_key) {
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
                                                created_at,
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
                                let file_hash_raw = bounded_vec_to_string(&storage_request.file_hash.0);
                                let decoded_hash = decode_file_hash(&storage_request.file_hash.0)
                                    .unwrap_or_else(|_| "Invalid file hash".to_string());
                                let mut file_hash = file_hash_raw.clone();
                                let mut file_size_in_bytes = 0;

                                if decoded_hash != "Invalid file hash" {
                                    let api_url = "http://127.0.0.1:5001";
                                    match crate::utils::ipfs::download_content_from_ipfs(&api_url, &decoded_hash).await {
                                        Ok(json_bytes) => {
                                            let json_str = match String::from_utf8(json_bytes) {
                                                Ok(s) => s,
                                                Err(e) => {
                                                    eprintln!("[UserSync] Failed to convert IPFS bytes to string for {}: {}", decoded_hash, e);
                                                    continue;
                                                }
                                            };
                                            let json_value: serde_json::Value = match serde_json::from_str(&json_str) {
                                                Ok(v) => v,
                                                Err(e) => {
                                                    eprintln!("[UserSync] Failed to parse JSON from IPFS for {}: {}", decoded_hash, e);
                                                    continue;
                                                }
                                            };
                                            let cid = match json_value.get(0)
                                                .and_then(|v| v.get("cid"))
                                                .and_then(|v| v.as_str()) {
                                                Some(cid) => cid,
                                                None => {
                                                    eprintln!("[UserSync] CID not found in JSON for decoded hash: {}", decoded_hash);
                                                    continue;
                                                }
                                            };
                                            match tokio::time::timeout(
                                                Duration::from_secs(30),
                                                crate::ipfs::get_ipfs_file_size(cid)
                                            ).await {
                                                Ok(Ok(size)) => {
                                                    file_hash = hex::encode(cid.as_bytes());
                                                    file_size_in_bytes = size as i64;
                                                }
                                                Ok(Err(e)) => {
                                                    eprintln!("[UserSync] Failed to fetch IPFS file size for {}: {}", cid, e);
                                                }
                                                Err(_) => {
                                                    eprintln!("[UserSync] Timeout fetching IPFS file size for {}", cid);
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            eprintln!("[UserSync] Failed to download from IPFS for {}: {}", decoded_hash, e);
                                        }
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
                                    records_to_insert.push(UserProfileFile {
                                        owner: owner_ss58,
                                        cid: file_hash.clone(),
                                        file_hash,
                                        file_name,
                                        file_size_in_bytes,
                                        is_assigned: storage_request.is_assigned,
                                        last_charged_at: storage_request.last_charged_at as i64,
                                        main_req_hash: decoded_hash,
                                        selected_validator: validator_ss58,
                                        total_replicas: storage_request.total_replicas as i64,
                                        block_number,
                                        profile_cid: "".to_string(),
                                        source: "Hippius".to_string(),
                                        miner_ids: Some(miner_ids_json),
                                        created_at: storage_request.created_at as i64,
                                    });
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[UserSync] Error decoding storage request entry: {:#?}", e);
                    }
                }
            }

            // Step 3: Clear the entire user_profiles table and insert records
            if let Some(pool) = DB_POOL.get() {
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
                for record in records_to_insert {
                    let insert_result = sqlx::query(
                        "INSERT INTO user_profiles (
                            owner, cid, file_hash, file_name, file_size_in_bytes,
                            is_assigned, last_charged_at, main_req_hash,
                            selected_validator, total_replicas, block_number, profile_cid, source, miner_ids, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
                    .bind(record.created_at)
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

            time::sleep(Duration::from_secs(120)).await;
        }
    });
}

#[tauri::command]
pub async fn get_user_synced_files(owner: String) -> Result<Vec<UserProfileFileWithType>, String> {
    if let Some(pool) = DB_POOL.get() {
        let user_profile_rows = sqlx::query(
            r#"
            SELECT owner, cid, file_hash, file_name,
                   file_size_in_bytes, is_assigned, last_charged_at,
                   main_req_hash, selected_validator,
                   total_replicas, block_number, profile_cid, source, miner_ids, created_at
              FROM user_profiles
             WHERE owner = ?
            "#
        )
        .bind(&owner)
        .fetch_all(pool)
        .await;

        // Get sync folder paths
        let public_sync_path = get_public_sync_path().await;
        let private_sync_path = get_private_sync_path().await;

        // Build a map of file_name -> (type, is_folder) from sync_folder_files
        let sync_file_infos = sqlx::query(
            "SELECT file_name, type, is_folder FROM sync_folder_files WHERE owner = ?"
        )
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map(|rows| {
            rows.into_iter().map(|row| {
                let file_name = row.get::<String, _>("file_name");
                let type_ = row.get::<String, _>("type");
                let is_folder = row.get::<bool, _>("is_folder");
                (file_name, (type_, is_folder))
            }).collect::<std::collections::HashMap<_, _>>()
        });

        match (user_profile_rows, sync_file_infos) {
            (Ok(user_rows), Ok(sync_map)) => {
                let mut files = Vec::new();
                for row in user_rows {
                    let file_name = row.get::<String, _>("file_name");
                    // Strip metadata suffixes when looking up in sync_folder_files
                    let lookup_name = if file_name.ends_with(".ec_metadata") {
                        file_name.trim_end_matches(".ec_metadata").to_string()
                    } else if file_name.ends_with(".folder_ec_metadata") {
                        file_name.trim_end_matches(".folder_ec_metadata").to_string()
                    } else {
                        file_name.clone()
                    };
                    let public_path = format!("{}/{}", public_sync_path, lookup_name);
                    let private_path = format!("{}/{}", private_sync_path, lookup_name);
                    // Default values
                    let mut type_ = "public".to_string();
                    let mut source = row.get::<String, _>("source");
                    let mut is_folder = false;
                    // If found in sync_folder_files, use its type and is_folder
                    if let Some((t, f)) = sync_map.get(&lookup_name) {
                        type_ = t.clone();
                        is_folder = *f;
                        if type_ == "public" {
                            source = public_path.clone();
                        } else if type_ == "private" {
                            source = private_path.clone();
                        }
                    } else {
                        // Fallback: check filesystem for type/source
                        if Path::new(&public_path).exists() {
                            type_ = "public".to_string();
                            source = public_path.clone();
                        } else if Path::new(&private_path).exists() {
                            type_ = "private".to_string();
                            source = private_path.clone();
                        }
                    }
                    files.push(UserProfileFileWithType {
                        owner: row.get("owner"),
                        cid: row.get("cid"),
                        file_hash: row.get("file_hash"),
                        file_name,
                        file_size_in_bytes: row.get("file_size_in_bytes"),
                        is_assigned: row.get("is_assigned"),
                        last_charged_at: row.get("last_charged_at"),
                        main_req_hash: row.get("main_req_hash"),
                        selected_validator: row.get("selected_validator"),
                        total_replicas: row.get("total_replicas"),
                        block_number: row.get("block_number"),
                        profile_cid: row.get("profile_cid"),
                        source,
                        miner_ids: row.get("miner_ids"),
                        created_at: row.get("created_at"),
                        is_folder,
                        type_,
                    });
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
pub async fn get_user_total_file_size(owner: String) -> Result<FileSizeBreakdown, String> {
    if let Some(pool) = DB_POOL.get() {
        // Get sync folder paths
        let public_sync_path = get_public_sync_path().await;
        let private_sync_path = get_private_sync_path().await;

        // Query user_profiles to get file sizes
        let user_profile_rows = sqlx::query(
            r#"
            SELECT file_name, file_size_in_bytes, source
            FROM user_profiles
            WHERE owner = ?
            "#
        )
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Database error: {}", e))?;

        // Build a map of file_name -> type from sync_folder_files
        let sync_file_infos = sqlx::query(
            "SELECT file_name, type FROM sync_folder_files WHERE owner = ?"
        )
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map(|rows| {
            rows.into_iter().map(|row| {
                let file_name = row.get::<String, _>("file_name");
                let type_ = row.get::<String, _>("type");
                (file_name, type_)
            }).collect::<std::collections::HashMap<_, _>>()
        })
        .map_err(|e| format!("Database error: {}", e))?;

        let mut public_size = 0;
        let mut private_size = 0;

        // Classify and sum file sizes using the same logic as get_user_synced_files
        for row in user_profile_rows {
            let file_name = row.get::<String, _>("file_name");
            let file_size = row.get::<i64, _>("file_size_in_bytes");
            let source = row.get::<String, _>("source");
            let public_path = format!("{}/{}", public_sync_path, file_name);
            let private_path = format!("{}/{}", private_sync_path, file_name);

            // Default to public
            let mut type_ = "public".to_string();

            // If found in sync_folder_files, use its type
            if let Some(t) = sync_file_infos.get(&file_name) {
                type_ = t.clone();
            } else {
                // Fallback: check filesystem for type
                if Path::new(&public_path).exists() {
                    type_ = "public".to_string();
                } else if Path::new(&private_path).exists() {
                    type_ = "private".to_string();
                }
            }

            if type_ == "public" {
                public_size += file_size;
            } else if type_ == "private" {
                private_size += file_size;
            }
        }

        println!(
            "[UserSync] Total file sizes for owner {}: public={} bytes, private={} bytes",
            owner, public_size, private_size
        );

        Ok(FileSizeBreakdown {
            public_size,
            private_size,
        })
    } else {
        Err("DB not initialized".to_string())
    }
}

#[tauri::command]
pub async fn start_user_profile_sync_tauri(account_id: String) {
    println!("[UserSync] Starting sync for account: {}", account_id);
    start_user_sync(&account_id);
}