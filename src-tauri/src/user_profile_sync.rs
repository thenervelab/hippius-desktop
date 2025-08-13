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
use tauri::{AppHandle, Manager};
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
struct AppEvent {
    event_type: String, // e.g., "error", "status_update"
    message: String,
    details: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSizeBreakdown {
    pub public_size: i64,
    pub private_size: i64,
}

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
    pub file_type: String,
    pub is_folder: bool,
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

pub fn start_user_sync(app_handle: AppHandle, account_id: &str) {
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(account_id) {
            println!("[UserSync] Account {} is already syncing, skipping.", account_id);
            return;
        }
        syncing_accounts.insert(account_id.to_string());
    }

    let app_handle_clone = app_handle.clone();
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

        let mut api = match get_substrate_client().await {
            Ok(api) => {
                println!("[UserSync] Successfully connected to substrate node");
                api
            }
            Err(e) => {
                eprintln!("[UserSync] Failed to get initial substrate client: {}", e);
                time::sleep(Duration::from_secs(120)).await;
                return;
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

                        match get_substrate_client().await {
                            Ok(new_api) => {
                                api = new_api;
                                println!("[UserSync] Successfully reconnected to substrate node");
                            }
                            Err(e) => {
                                eprintln!("[UserSync] Failed to reconnect to substrate client: {}", e);
                                if retry_count >= max_retries {
                                    eprintln!("[UserSync] Max retries reached, waiting 5 minutes before trying again");
                                    time::sleep(Duration::from_secs(300)).await;
                                    retry_count = 0;
                                    continue;
                                } else {
                                    let wait_time = std::cmp::min(30 * retry_count, 300);
                                    eprintln!("[UserSync] Retrying in {} seconds...", wait_time);
                                    time::sleep(Duration::from_secs(wait_time as u64)).await;
                                }
                                continue;
                            }
                        }
                    }
                }
            };

            let mut records_to_insert: Vec<UserProfileFile> = Vec::new();
            let mut seen_files: HashSet<(String, String)> = HashSet::new();
            let mut profile_parsed_successfully = false;

            let public_sync_path = get_public_sync_path().await.ok();
            let private_sync_path = get_private_sync_path().await.ok();

            // Step 1: Fetch and parse user profile data
            let profile_res = storage
                .fetch(&custom_runtime::storage().ipfs_pallet().user_profile(&account))
                .await;

            let profile_cid = match profile_res {
                Ok(Some(bounded_vec)) => bounded_vec_to_string(&bounded_vec.0),
                Ok(None) => {
                    println!("[UserSync] No user profile found for account: {}", account_id);
                    let _ = app_handle_clone.emit("app-event", AppEvent {
                        event_type: "error".to_string(),
                        message: "User profile not available".to_string(),
                        details: Some(format!("No profile found on-chain for account: {}", account_id)),
                    });
                    profile_parsed_successfully = true;
                    String::new()
                }
                Err(e) => {
                    eprintln!("[UserSync] Error fetching UserProfile: {e}");
                    let _ = app_handle_clone.emit("app-event", AppEvent {
                        event_type: "error".to_string(),
                        message: "Failed to fetch user profile".to_string(),
                        details: Some(e.to_string()),
                    });
                    time::sleep(Duration::from_secs(120)).await;
                    continue;
                }
            };

            println!("[UserSync] Profile CID: {}", profile_cid);

            if !profile_cid.is_empty() {
                let ipfs_url = format!("https://get.hippius.network/ipfs/{}", profile_cid);
                let max_ipfs_retries = 3;
                let mut ipfs_retry_count = 0;
                let mut profile_fetched = false;

                while ipfs_retry_count < max_ipfs_retries && !profile_fetched {
                    match client.get(&ipfs_url).send().await {
                        Ok(resp) => {

                            if resp.status().is_success() {
                                match resp.text().await {
                                    Ok(data) => {
                                        match serde_json::from_str::<serde_json::Value>(&data) {
                                            Ok(profile_data) => {
                                                profile_parsed_successfully = true;
                                                profile_fetched = true;
                                                if let Some(files) = profile_data.as_array() {
                                                    for file in files {
                                                        let file_name = file.get("file_name").and_then(|v| v.as_str()).unwrap_or_default().to_string();

                                                        // Skip files ending with .ff.ec_metadata, .ff, or .ec
                                                        if file_name.ends_with(".ff.ec_metadata")
                                                            || file_name.ends_with(".ff")
                                                            || file_name.ends_with(".ec") 
                                                            || file_name.ends_with(".s.folder")
                                                            || file_name.ends_with(".s.folder.ec_metadata"){
                                                            continue;
                                                        }

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

                                                        let file_size_in_bytes = file.get("file_size_in_bytes").and_then(|v| v.as_i64()).unwrap_or(0);
                                                        let is_assigned = file.get("is_assigned").and_then(|v| v.as_bool()).unwrap_or(false);
                                                        let last_charged_at = file.get("last_charged_at").and_then(|v| v.as_i64()).unwrap_or(0);
                                                        let main_req_hash = file.get("main_req_hash")
                                                            .and_then(|v| v.as_str())
                                                            .map(|s| {
                                                                match hex::decode(s) {
                                                                    Ok(bytes) => match String::from_utf8(bytes) {
                                                                        Ok(decoded) => decoded,
                                                                        Err(_) => s.to_string(),
                                                                    },
                                                                    Err(_) => s.to_string(),
                                                                }
                                                            })
                                                            .unwrap_or_default();
                                                        let selected_validator = file.get("selected_validator").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                                        let total_replicas = file.get("total_replicas").and_then(|v| v.as_i64()).unwrap_or(0);
                                                        let created_at = file.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
                                                        let mut source = "Hippius".to_string();
                                                        let miner_ids_json = if let Some(miner_ids) = file.get("miner_ids").and_then(|v| v.as_array()) {
                                                            let ids: Vec<String> = miner_ids.iter().filter_map(|id| id.as_str().map(|s| s.to_string())).collect();
                                                            serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
                                                        } else {
                                                            "[]".to_string()
                                                        };

                                                        let is_folder = file_name.ends_with("-folder")
                                                            || file_name.ends_with(".folder")
                                                            || file_name.ends_with(".folder.ec_metadata")
                                                            || file_name.ends_with("-folder.ec_metadata");

                                                        let mut file_type = if file_name.ends_with(".ec_metadata")
                                                            || file_name.ends_with(".folder.ec_metadata")
                                                            || file_name.ends_with("-folder.ec_metadata") {
                                                            "private".to_string()
                                                        } else {
                                                            "public".to_string()
                                                        };

                                                        let mut actual_file_size = file_size_in_bytes;

                                                        let base_file_name = {
                                                            let mut name = file_name.clone();
                                                            if name.ends_with(".folder.ec_metadata") {
                                                                name = name.trim_end_matches(".folder.ec_metadata").to_string();
                                                            } else if name.ends_with("-folder.ec_metadata") {
                                                                name = name.trim_end_matches("-folder.ec_metadata").to_string();
                                                            } else if name.ends_with(".ec_metadata") {
                                                                name = name.trim_end_matches(".ec_metadata").to_string();
                                                            } else if name.ends_with(".folder") {
                                                                name = name.trim_end_matches(".folder").to_string();
                                                            } else if name.ends_with("-folder") {
                                                                name = name.trim_end_matches("-folder").to_string();
                                                            }
                                                            name
                                                        };
                                    
                                                        if file_name.ends_with(".ec_metadata") && !file_name.ends_with(".folder.ec_metadata") && !file_name.ends_with("-folder.ec_metadata") {
                                                            let decoded_hash = decode_file_hash(&file_hash.as_bytes())
                                                                .unwrap_or_else(|_| "Invalid file hash".to_string());
                                                            let ipfs_url = format!("https://get.hippius.network/ipfs/{}", decoded_hash);
                                                            match client.get(&ipfs_url).send().await {
                                                                Ok(resp) => {
                                                                    if let Ok(data) = resp.text().await {
                                                                        if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(&data) {
                                                                            if let Some(original_file) = metadata.get("original_file") {
                                                                                if let Some(size) = original_file.get("size").and_then(|v| v.as_i64()) {
                                                                                    actual_file_size = size;
                                                                                }
                                                                            }
                                                                            if let Some(erasure_coding) = metadata.get("erasure_coding") {
                                                                                if let Some(encrypted) = erasure_coding.get("encrypted").and_then(|v| v.as_bool()) {
                                                                                    if !encrypted {
                                                                                        file_type = "public".to_string();
                                                                                    }
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                                Err(e) => {
                                                                    let error_message = format!("[UserSync] Failed to fetch metadata for {}: {}", file_hash, e);
                                                                    eprintln!("[UserSync] Failed to fetch metadata for {}: {}", file_hash, e);
                                                                    let _ = app_handle_clone.emit("app-event", AppEvent {
                                                                        event_type: "error".to_string(),
                                                                        message: "Failed to fetch metadata".to_string(),
                                                                        details: Some(format!("File: {}, Error: {}", file_hash, e)),
                                                                    });
                                                                }
                                                            }
                                                        } else if is_folder {
                                                            let decoded_hash = decode_file_hash(&file_hash.as_bytes())
                                                                .unwrap_or_else(|_| "Invalid file hash".to_string());
                                                            let ipfs_url = format!("https://get.hippius.network/ipfs/{}", decoded_hash);
                                                            match client.get(&ipfs_url).send().await {
                                                                Ok(resp) => {
                                                                    if let Ok(data) = resp.text().await {
                                                                        if let Ok(folder_data) = serde_json::from_str::<serde_json::Value>(&data) {
                                                                            if let Some(files) = folder_data.as_array() {
                                                                                let total_size: i64 = files.iter()
                                                                                    .filter_map(|file| file.get("file_size"))
                                                                                    .filter_map(|size| size.as_i64())
                                                                                    .sum();
                                                                                actual_file_size = total_size;
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                                Err(e) => {
                                                                    let error_message = format!("[UserSync] Failed to fetch folder content for {}: {}", file_hash, e);
                                                                    eprintln!("[UserSync] Failed to fetch folder content for {}: {}", file_hash, e);
                                                                    let _ = app_handle_clone.emit("app-event", AppEvent {
                                                                        event_type: "error".to_string(),
                                                                        message: "Failed to fetch folder content".to_string(),
                                                                        details: Some(format!("File: {}, Error: {}", file_hash, e)),
                                                                    });
                                                                }
                                                            }
                                                        }

                                                        if file_type == "public" && public_sync_path.is_some() {
                                                            let public_path = format!("{}/{}", public_sync_path.as_ref().unwrap(), base_file_name);
                                                            if Path::new(&public_path).exists() {
                                                                source = public_path;
                                                            }
                                                        } else if file_type == "private" && private_sync_path.is_some() {
                                                            let private_path = format!("{}/{}", private_sync_path.as_ref().unwrap(), base_file_name);
                                                            if Path::new(&private_path).exists() {
                                                                source = private_path;
                                                            }
                                                        }

                                                        let file_key = (file_hash.clone(), file_name.clone());
                                                        if seen_files.insert(file_key) {
                                                            records_to_insert.push(UserProfileFile {
                                                                owner: account_id.clone(),
                                                                cid: profile_cid.clone(),
                                                                file_hash,
                                                                file_name: file_name.clone(),
                                                                file_size_in_bytes: actual_file_size,
                                                                is_assigned,
                                                                last_charged_at,
                                                                main_req_hash,
                                                                selected_validator,
                                                                total_replicas,
                                                                block_number: 0,
                                                                profile_cid: profile_cid.clone(),
                                                                source,
                                                                miner_ids: Some(miner_ids_json),
                                                                created_at,
                                                                file_type,
                                                                is_folder,
                                                            });
                                                        }
                                                    }
                                                } else {
                                                    println!("[UserSync] No files array found in profile data for CID: {}", profile_cid);
                                                }
                                            }
                                            Err(e) => {
                                                let error_message = format!("[UserSync] Invalid JSON for CID {}: {}. Error: {}", profile_cid, data, e);
                                                eprintln!("[UserSync] Invalid JSON for CID {}: {}. Error: {}", profile_cid, data, e);
                                                let _ = app_handle_clone.emit("app-event", AppEvent {
                                                    event_type: "error".to_string(),
                                                    message: "Invalid JSON in profile data".to_string(),
                                                    details: Some(format!("CID: {}, Error: {}", profile_cid, e)),
                                                });
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        let error_message = format!("[UserSync] Failed to get text from IPFS response for CID {}: {}", profile_cid, e);
                                        eprintln!("[UserSync] Failed to get text from IPFS response for CID {}: {}", profile_cid, e);
                                        let _ = app_handle_clone.emit("app-event", AppEvent {
                                            event_type: "error".to_string(),
                                            message: "Failed to parse IPFS response".to_string(),
                                            details: Some(format!("CID: {}, Error: {}", profile_cid, e)),
                                        });
                                        ipfs_retry_count += 1;
                                        if ipfs_retry_count < max_ipfs_retries {
                                            let wait_time = 5 * ipfs_retry_count;
                                            eprintln!("[UserSync] Retrying IPFS fetch in {} seconds...", wait_time);
                                            time::sleep(Duration::from_secs(wait_time as u64)).await;
                                        }
                                    }
                                }
                            } else {
                                let error_message = format!("[UserSync] IPFS request failed for CID {}: Status {}", profile_cid, resp.status());
                                eprintln!("[UserSync] IPFS request failed for CID {}: Status {}", profile_cid, resp.status());
                                let _ = app_handle_clone.emit("app-event", AppEvent {
                                    event_type: "error".to_string(),
                                    message: "Failed to fetch from IPFS".to_string(),
                                    details: Some(format!("CID: {}, Status: {}", profile_cid, resp.status())),
                                });
                                ipfs_retry_count += 1;
                                if ipfs_retry_count < max_ipfs_retries {
                                    let wait_time = 5 * ipfs_retry_count;
                                    eprintln!("[UserSync] Retrying IPFS fetch in {} seconds...", wait_time);
                                    time::sleep(Duration::from_secs(wait_time as u64)).await;
                                }
                            }
                        }
                        Err(e) => {
                            let error_message = format!("[UserSync] Failed to fetch from IPFS for CID {}: {}", profile_cid, e);
                            eprintln!("[UserSync] Failed to fetch from IPFS for CID {}: {}", profile_cid, e);
                            let _ = app_handle_clone.emit("app-event", AppEvent {
                                event_type: "error".to_string(),
                                message: "Failed to fetch from IPFS".to_string(),
                                details: Some(format!("CID: {}, Error: {}", profile_cid, e)),
                            });
                            ipfs_retry_count += 1;
                            if ipfs_retry_count < max_ipfs_retries {
                                let wait_time = 5 * ipfs_retry_count;
                                eprintln!("[UserSync] Retrying IPFS fetch in {} seconds...", wait_time);
                                time::sleep(Duration::from_secs(wait_time as u64)).await;
                            }
                        }
                    }
                }

                if !profile_fetched {
                    let error_message = format!("[UserSync] Failed to fetch profile for CID {} after {} retries, continuing with storage requests", profile_cid, max_ipfs_retries);
                    eprintln!("[UserSync] Failed to fetch profile for CID {} after {} retries, continuing with storage requests", profile_cid, max_ipfs_retries);
                    let _ = app_handle_clone.emit("app-event", AppEvent {
                        event_type: "error".to_string(),
                        message: "Failed to fetch profile from IPFS".to_string(),
                        details: Some(format!("CID: {}, Retries: {}", profile_cid, max_ipfs_retries)),
                    });
                }
            } else {
                println!("[UserSync] Profile CID is empty, proceeding with storage requests");
            }

            // Step 2: Fetch and parse storage requests
            let mut iter = match storage.iter(custom_runtime::storage().ipfs_pallet().user_storage_requests_iter()).await {
                Ok(i) => i,
                Err(e) => {
                    let error_message = format!("[UserSync] Error fetching storage requests iterator: {e}");
                    eprintln!("[UserSync] Error fetching storage requests iterator: {e}");
                    let _ = app_handle_clone.emit("app-event", AppEvent {
                        event_type: "error".to_string(),
                        message: "Failed to fetch storage requests".to_string(),
                        details: Some(e.to_string()),
                    });
                    time::sleep(Duration::from_secs(120)).await;
                    continue;
                }
            };

            let mut storage_retry_count = 0;
            let max_storage_retries = 5;

            while let Some(result) = iter.next().await {
                match result {
                    Ok(StorageKeyValuePair { value, .. }) => {
                        if let Some(storage_request) = value {
                            if storage_request.owner == account {
                                println!("[UserSync] Found storage request for account: {}", account);
                                let file_name = bounded_vec_to_string(&storage_request.file_name.0);

                                // Skip files ending with .ff.ec_metadata, .ff, or .ec
                                if file_name.ends_with(".ff.ec_metadata")
                                    || file_name.ends_with(".ff")
                                    || file_name.ends_with(".ec") 
                                    || file_name.ends_with(".s.folder")
                                    || file_name.ends_with(".s.folder.ec_metadata"){
                                    continue;
                                }

                                let file_hash_raw = bounded_vec_to_string(&storage_request.file_hash.0);
                                let decoded_hash = decode_file_hash(&storage_request.file_hash.0)
                                    .unwrap_or_else(|_| "Invalid file hash".to_string());
                                let mut file_hash = file_hash_raw.clone();
                                let mut file_size_in_bytes = 0;

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

                                let is_folder = file_name.ends_with("-folder")
                                    || file_name.ends_with(".folder")
                                    || file_name.ends_with(".folder.ec_metadata")
                                    || file_name.ends_with("-folder.ec_metadata");

                                let mut file_type = if file_name.ends_with(".ec_metadata")
                                    || file_name.ends_with(".folder.ec_metadata")
                                    || file_name.ends_with("-folder.ec_metadata") {
                                    "private".to_string()
                                } else {
                                    "public".to_string()
                                };

                                let base_file_name = {
                                    let mut name = file_name.clone();
                                    if name.ends_with(".folder.ec_metadata") {
                                        name = name.trim_end_matches(".folder.ec_metadata").to_string();
                                    } else if name.ends_with("-folder.ec_metadata") {
                                        name = name.trim_end_matches("-folder.ec_metadata").to_string();
                                    } else if name.ends_with(".ec_metadata") {
                                        name = name.trim_end_matches(".ec_metadata").to_string();
                                    } else if name.ends_with(".folder") {
                                        name = name.trim_end_matches(".folder").to_string();
                                    } else if name.ends_with("-folder") {
                                        name = name.trim_end_matches("-folder").to_string();
                                    }
                                    name
                                };

                                let ipfs_api_url = "http://127.00.1:5001";
                                // Handle IPFS content fetching for non-folder files
                                if !file_name.ends_with("-folder") && !file_name.ends_with(".folder")
                                    && !file_name.ends_with(".folder.ec_metadata") && !file_name.ends_with("-folder.ec_metadata") && !file_name.ends_with(".ec_metadata"){
                                    if decoded_hash != "Invalid file hash" {
                                        match crate::utils::ipfs::download_content_from_ipfs(&ipfs_api_url, &decoded_hash).await {
                                            Ok(json_bytes) => {
                                                match String::from_utf8(json_bytes) {
                                                    Ok(json_str) => {
                                                        match serde_json::from_str::<serde_json::Value>(&json_str) {
                                                            Ok(json_value) => {
                                                                if let Some(array) = json_value.as_array() {
                                                                    if let Some(file_obj) = array.get(0) {
                                                                        if let Some(cid) = file_obj.get("cid").and_then(|v| v.as_str()) {
                                                                            let cid_vec = cid.to_string().as_bytes().to_vec();
                                                                            file_hash = hex::encode(cid_vec);
                                                                        } else {
                                                                            let error_message = format!("[UserSync] CID not found in JSON for decoded hash: {}", decoded_hash);
                                                                            eprintln!("[UserSync] CID not found in JSON for decoded hash: {}", decoded_hash);
                                                                            let _ = app_handle_clone.emit("app-event", AppEvent {
                                                                                event_type: "error".to_string(),
                                                                                message: "CID not found in IPFS data".to_string(),
                                                                                details: Some(format!("File: {}, Error: {}", decoded_hash, error_message)),
                                                                            });
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                            Err(e) => {
                                                                let error_message = format!("[UserSync] Failed to parse JSON from IPFS for {}: {}", decoded_hash, e);
                                                                eprintln!("[UserSync] Failed to parse JSON from IPFS for {}: {}", decoded_hash, e);
                                                                let _ = app_handle_clone.emit("app-event", AppEvent {
                                                                    event_type: "error".to_string(),
                                                                    message: "Failed to parse IPFS content".to_string(),
                                                                    details: Some(format!("File: {}, Error: {}", decoded_hash, e)),
                                                                });
                                                            }
                                                        }
                                                    }
                                                    Err(e) => {
                                                        let error_message = format!("[UserSync] Failed to convert IPFS bytes to string for {}: {}", decoded_hash, e);
                                                        eprintln!("[UserSync] Failed to convert IPFS bytes to string for {}: {}", decoded_hash, e);
                                                        let _ = app_handle_clone.emit("app-event", AppEvent {
                                                            event_type: "error".to_string(),
                                                            message: "Invalid IPFS content format".to_string(),
                                                            details: Some(format!("File: {}, Error: {}", decoded_hash, e)),
                                                        });
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                let error_message = format!("[UserSync] Failed to download IPFS content for {}: {}", decoded_hash, e);
                                                eprintln!("[UserSync] Failed to download IPFS content for {}: {}", decoded_hash, e);
                                                let _ = app_handle_clone.emit("app-event", AppEvent {
                                                    event_type: "error".to_string(),
                                                    message: "Failed to download from IPFS".to_string(),
                                                    details: Some(format!("File: {}, Error: {}", decoded_hash, e)),
                                                });
                                            }
                                        }
                                    }
                                } else {
                                    // Handle folder or folder metadata
                                    if decoded_hash != "Invalid file hash" {
                                        match crate::utils::ipfs::download_content_from_ipfs(&ipfs_api_url, &decoded_hash).await {
                                            Ok(json_bytes) => {
                                                match String::from_utf8(json_bytes) {
                                                    Ok(json_str) => {
                                                        match serde_json::from_str::<serde_json::Value>(&json_str) {
                                                            Ok(json_value) => {
                                                                if let Some(files) = json_value.as_array() {
                                                                    let target_extensions = if file_name.ends_with(".folder.ec_metadata") {
                                                                        vec![".folder.ec_metadata"]
                                                                    } else if file_name.ends_with("-folder.ec_metadata") {
                                                                        vec!["-folder.ec_metadata"]
                                                                    } else if file_name.ends_with(".folder") {
                                                                        // Only allow .folder and .ec.folder (EXCLUDE .s.folder and .s.ec.folder)
                                                                        vec![".folder", ".ec.folder", "-folder"]
                                                                    } else if file_name.ends_with("-folder") {
                                                                        vec!["-folder", ".folder", ".ec.folder"]
                                                                    } else {
                                                                        vec![]
                                                                    };
                                                                    
                                                                    if !target_extensions.is_empty() {
                                                                        'extension_loop: for target_extension in target_extensions {
                                                                            for file in files {
                                                                                if let Some(filename) = file.get("filename").and_then(|v| v.as_str()) {
                                                                                    // Ensure we don't match .s.folder or .s.ec.folder
                                                                                    if filename.ends_with(target_extension) && 
                                                                                       !filename.contains(".s.folder") && 
                                                                                       !filename.contains(".s.ec.folder") 
                                                                                    {
                                                                                        if let Some(cid) = file.get("cid").and_then(|v| v.as_str()) {
                                                                                            let cid_vec = cid.to_string().as_bytes().to_vec();
                                                                                            file_hash = hex::encode(cid_vec);
                                                                                            break 'extension_loop;
                                                                                        }
                                                                                    }
                                                                                }
                                                                            }
                                                                        }
                                                                    }else {
                                                                        // Handle .ec_metadata case when none of the target extensions matched
                                                                        for file in files {
                                                                            if let Some(filename) = file.get("filename").and_then(|v| v.as_str()) {
                                                                                if filename.ends_with(".ec_metadata") {
                                                                                    if let Some(cid) = file.get("cid").and_then(|v| v.as_str()) {
                                                                                        let cid_vec = cid.to_string().as_bytes().to_vec();
                                                                                        file_hash = hex::encode(cid_vec);
                                                                                        // Download the .ec_metadata content
                                                                                        match crate::utils::ipfs::download_content_from_ipfs(&ipfs_api_url, cid).await {
                                                                                            Ok(metadata_bytes) => {
                                                                                                if let Ok(metadata_str) = String::from_utf8(metadata_bytes) {
                                                                                                    if let Ok(metadata_json) = serde_json::from_str::<serde_json::Value>(&metadata_str) {
                                                                                                        // Check if erasure_coding.encrypted exists and is false
                                                                                                        if let Some(erasure_coding) = metadata_json.get("erasure_coding") {
                                                                                                            if let Some(encrypted) = erasure_coding.get("encrypted") {
                                                                                                                if encrypted == false {
                                                                                                                    file_type = "public".to_string();
                                                                                                                }
                                                                                                            }
                                                                                                        }
                                                                                                    }
                                                                                                }
                                                                                            }
                                                                                            Err(e) => {
                                                                                                let error_message = format!("[UserSync] Failed to download .ec_metadata IPFS content for {}: {}", cid, e);
                                                                                                eprintln!("[UserSync] Failed to download .ec_metadata IPFS content for {}: {}", cid, e);
                                                                                                let _ = app_handle_clone.emit("app-event", AppEvent {
                                                                                                    event_type: "error".to_string(),
                                                                                                    message: "Failed to download metadata from IPFS".to_string(),
                                                                                                    details: Some(format!("File: {}, Error: {}", cid, e)),
                                                                                                });
                                                                                            }
                                                                                        }
                                                                                        break;
                                                                                    }
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                            Err(e) => {
                                                                let error_message = format!("[UserSync] Failed to parse folder JSON from IPFS for {}: {}", decoded_hash, e);
                                                                eprintln!("[UserSync] Failed to parse folder JSON from IPFS for {}: {}", decoded_hash, e);
                                                                let _ = app_handle_clone.emit("app-event", AppEvent {
                                                                    event_type: "error".to_string(),
                                                                    message: "Failed to parse folder data from IPFS".to_string(),
                                                                    details: Some(format!("File: {}, Error: {}", decoded_hash, e)),
                                                                });
                                                            }
                                                        }
                                                    }
                                                    Err(e) => {
                                                        let error_message = format!("[UserSync] Failed to convert folder IPFS bytes to string for {}: {}", decoded_hash, e);
                                                        eprintln!("[UserSync] Failed to convert folder IPFS bytes to string for {}: {}", decoded_hash, e);
                                                        let _ = app_handle_clone.emit("app-event", AppEvent {
                                                            event_type: "error".to_string(),
                                                            message: "Invalid folder data from IPFS".to_string(),
                                                            details: Some(format!("File: {}, Error: {}", decoded_hash, e)),
                                                        });
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                let error_message = format!("[UserSync] Failed to download folder IPFS content for {}: {}", decoded_hash, e);
                                                eprintln!("[UserSync] Failed to download folder IPFS content for {}: {}", decoded_hash, e);
                                                let _ = app_handle_clone.emit("app-event", AppEvent {
                                                    event_type: "error".to_string(),
                                                    message: "Failed to download folder from IPFS".to_string(),
                                                    details: Some(format!("File: {}, Error: {}", decoded_hash, e)),
                                                });
                                            }
                                        }
                                    }
                                }

                                let mut source = "Hippius".to_string();
                                if file_type == "public" && public_sync_path.is_some() {
                                    let public_path = format!("{}/{}", public_sync_path.as_ref().unwrap(), base_file_name);
                                    if Path::new(&public_path).exists() {
                                        source = public_path;
                                    }
                                } else if file_type == "private" && private_sync_path.is_some() {
                                    let private_path = format!("{}/{}", private_sync_path.as_ref().unwrap(), base_file_name);
                                    if Path::new(&private_path).exists() {
                                        source = private_path;
                                    }
                                }
                                println!("[UserSync] File hash for storage request : {}, main req hash is : {}", file_hash, decoded_hash);
                                let file_key = (file_hash.clone(), file_name.clone());
                                if seen_files.insert(file_key) {
                                    records_to_insert.push(UserProfileFile {
                                        owner: owner_ss58,
                                        cid: file_hash.clone(),
                                        file_hash,
                                        file_name: file_name.clone(),
                                        file_size_in_bytes,
                                        is_assigned: storage_request.is_assigned,
                                        last_charged_at: storage_request.last_charged_at as i64,
                                        main_req_hash: decoded_hash,
                                        selected_validator: validator_ss58,
                                        total_replicas: storage_request.total_replicas as i64,
                                        block_number,
                                        profile_cid: "".to_string(),
                                        source,
                                        miner_ids: Some(miner_ids_json),
                                        created_at: storage_request.created_at as i64,
                                        is_folder,
                                        file_type,
                                    });
                                }
                            }
                            storage_retry_count = 0; // Reset retry count on successful iteration
                        }
                    }
                    Err(e) => {
                        if format!("{e}").contains("RestartNeeded") {
                            storage_retry_count += 1;
                            let error_message = format!(
                                "[UserSync] Connection reset during storage iteration (attempt {}/{}): {e}",
                                storage_retry_count, max_storage_retries
                            );
                            eprintln!("[UserSync] Connection reset during storage iteration (attempt {}/{}): {e}", storage_retry_count, max_storage_retries);
                            let _ = app_handle_clone.emit("app-event", AppEvent {
                                event_type: "error".to_string(),
                                message: "Connection to node was reset".to_string(),
                                details: Some(error_message),
                            });
                            crate::substrate_client::clear_substrate_client();
                            match get_substrate_client().await {
                                Ok(new_api) => {
                                    api = new_api;
                                    println!("[UserSync] Successfully reconnected to substrate node");
                                    // Reinitialize the iterator after reconnection
                                    let new_storage_query = custom_runtime::storage()
                                        .ipfs_pallet()
                                        .user_storage_requests_iter();
                                    match api.storage().at_latest().await {
                                        Ok(new_storage) => {
                                            iter = match new_storage.iter(new_storage_query).await {
                                                Ok(i) => i,
                                                Err(e) => {
                                                    let error_message = format!("[UserSync] Failed to reinitialize storage iterator: {e}");
                                                    eprintln!("[UserSync] Failed to reinitialize storage iterator: {e}");
                                                    let _ = app_handle_clone.emit("app-event", AppEvent {
                                                        event_type: "error".to_string(),
                                                        message: "Failed to restart sync after node reset".to_string(),
                                                        details: Some(error_message),
                                                    });
                                                    time::sleep(Duration::from_secs(120)).await;
                                                    continue;
                                                }
                                            };
                                        }
                                        Err(e) => {
                                            let error_message = format!("[UserSync] Failed to get latest storage after reconnect: {e}");
                                            eprintln!("[UserSync] Failed to get latest storage after reconnect: {e}");
                                            let _ = app_handle_clone.emit("app-event", AppEvent {
                                                event_type: "error".to_string(),
                                                message: "Failed to reconnect to node".to_string(),
                                                details: Some(error_message),
                                            });
                                            if storage_retry_count >= max_storage_retries {
                                                eprintln!("[UserSync] Max storage retries reached, waiting 5 minutes");
                                                time::sleep(Duration::from_secs(300)).await;
                                                storage_retry_count = 0;
                                            } else {
                                                let wait_time = std::cmp::min(30 * storage_retry_count, 300);
                                                eprintln!("[UserSync] Retrying storage fetch in {} seconds...", wait_time);
                                                time::sleep(Duration::from_secs(wait_time as u64)).await;
                                            }
                                            continue;
                                        }
                                    }
                                }
                                Err(e) => {
                                    let error_message = format!("[UserSync] Failed to reconnect to substrate client: {e}");
                                    eprintln!("[UserSync] Failed to reconnect to substrate client: {e}");
                                    let _ = app_handle_clone.emit("app-event", AppEvent {
                                        event_type: "error".to_string(),
                                        message: "Failed to reconnect to node client".to_string(),
                                        details: Some(error_message),
                                    });
                                    if storage_retry_count >= max_storage_retries {
                                        eprintln!("[UserSync] Max storage retries reached, waiting 5 minutes");
                                        time::sleep(Duration::from_secs(300)).await;
                                        storage_retry_count = 0;
                                    } else {
                                        let wait_time = std::cmp::min(30 * storage_retry_count, 300);
                                        eprintln!("[UserSync] Retrying storage fetch in {} seconds...", wait_time);
                                        time::sleep(Duration::from_secs(wait_time as u64)).await;
                                    }
                                    continue;
                                }
                            }
                        } else {
                            let error_message = format!("[UserSync] Error decoding storage request entry: {e}");
                            eprintln!("[UserSync] Error decoding storage request entry: {e}");
                            let _ = app_handle_clone.emit("app-event", AppEvent {
                                event_type: "error".to_string(),
                                message: "Failed to read on-chain data".to_string(),
                                details: Some(error_message),
                            });
                            storage_retry_count += 1;
                            if storage_retry_count >= max_storage_retries {
                                eprintln!("[UserSync] Max storage retries reached, waiting 5 minutes");
                                time::sleep(Duration::from_secs(300)).await;
                                storage_retry_count = 0;
                            } else {
                                let wait_time = std::cmp::min(30 * storage_retry_count, 300);
                                eprintln!("[UserSync] Retrying storage fetch in {} seconds...", wait_time);
                                time::sleep(Duration::from_secs(wait_time as u64)).await;
                            }
                            continue;
                        }
                    }
                }
            }

            // Step 3: Clear and insert into user_profiles table
            if let Some(pool) = DB_POOL.get() {
                if records_to_insert.len() > 0 || profile_parsed_successfully {
                    match sqlx::query("DELETE FROM user_profiles")
                        .execute(pool)
                        .await
                    {
                        Ok(_) => println!("[UserSync] Cleared user_profiles table"),
                        Err(e) => {
                            let error_message = format!("[UserSync] Failed to clear user_profiles table: {e}");
                            eprintln!("[UserSync] Failed to clear user_profiles table: {e}");
                            let _ = app_handle_clone.emit("app-event", AppEvent {
                                event_type: "error".to_string(),
                                message: "Failed to clear user profiles table".to_string(),
                                details: Some(e.to_string()),
                            });
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
                                selected_validator, total_replicas, block_number, profile_cid, source,
                                miner_ids, created_at, type, is_folder
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
                        .bind(&record.file_type)
                        .bind(record.is_folder)
                        .execute(pool)
                        .await;

                        if let Err(e) = insert_result {
                            let error_message = format!("[UserSync] Failed to insert record for file '{}': {e}", record.file_name);
                            eprintln!("[UserSync] Failed to insert record for file '{}': {e}", record.file_name);
                            let _ = app_handle_clone.emit("app-event", AppEvent {
                                event_type: "error".to_string(),
                                message: "Failed to insert record into user profiles table".to_string(),
                                details: Some(format!("File: {}, Error: {}", record.file_name, e)),
                            });
                        }
                    }
                } else {
                    println!("[UserSync] Skipping user_profiles table clear: profile_parsed_successfully={}, records_to_insert.len()={}",
                        profile_parsed_successfully, records_to_insert.len());
                }
            }

            time::sleep(Duration::from_secs(120)).await;
        }
    });
}

#[tauri::command]
pub async fn get_user_synced_files(owner: String) -> Result<Vec<UserProfileFileWithType>, String> {
    if let Some(pool) = DB_POOL.get() {
        let public_sync_path = match get_public_sync_path().await {
            Ok(path) => Some(path),
            Err(_) => None,
        };
        let private_sync_path = match get_private_sync_path().await {
            Ok(path) => Some(path),
            Err(_) => None,
        };

        let user_profile_rows = sqlx::query(
            r#"
            SELECT owner, cid, file_hash, file_name,
                   file_size_in_bytes, is_assigned, last_charged_at,
                   main_req_hash, selected_validator,
                   total_replicas, block_number, profile_cid, source, miner_ids, created_at,
                   type, is_folder
            FROM user_profiles
            WHERE owner = ?
            "#
        )
        .bind(&owner)
        .fetch_all(pool)
        .await;

        match user_profile_rows {
            Ok(user_rows) => {
                let mut files = Vec::new();
                for row in user_rows {
                    let file_name = row.get::<String, _>("file_name");
                    let type_ = row.get::<String, _>("type");
                    let is_folder = row.get::<bool, _>("is_folder");

                    // Use the full file_name for both files and folders, adjusting for folder suffixes if needed
                    let base_name = {
                        let mut name = file_name.clone();
                        if name.ends_with(".folder.ec_metadata") {
                            name = name.trim_end_matches(".folder.ec_metadata").to_string();
                        } else if name.ends_with("-folder.ec_metadata") {
                            name = name.trim_end_matches("-folder.ec_metadata").to_string();
                        } else if name.ends_with(".ec_metadata") {
                            name = name.trim_end_matches(".ec_metadata").to_string();
                        } else if name.ends_with(".folder") {
                            name = name.trim_end_matches(".folder").to_string();
                        } else if name.ends_with("-folder") {
                            name = name.trim_end_matches("-folder").to_string();
                        }
                        name
                    };
                    let mut source = "Hippius".to_string();

                    if type_ == "public" && public_sync_path.is_some() {
                        let full_path = if is_folder {
                            // For folders, use the base_name directly as the folder name
                            format!("{}/{}", public_sync_path.as_ref().unwrap(), base_name)
                        } else {
                            // For files, use the base_name as the file name
                            format!("{}/{}", public_sync_path.as_ref().unwrap(), base_name)
                        };
                        if Path::new(&full_path).exists() {
                            source = full_path;
                        }
                    } else if type_ == "private" && private_sync_path.is_some() {
                        let full_path = if is_folder {
                            // For folders, use the base_name directly as the folder name
                            format!("{}/{}", private_sync_path.as_ref().unwrap(), base_name)
                        } else {
                            // For files, use the base_name as the file name
                            format!("{}/{}", private_sync_path.as_ref().unwrap(), base_name)
                        };
                        if Path::new(&full_path).exists() {
                            source = full_path;
                        }
                    }

                    // If source is still "Hippius", check file_paths table
                    if source == "Hippius" {
                        if let Ok(path_record) = sqlx::query_as::<_, (String,)>(
                            "SELECT path FROM file_paths WHERE file_name = ? LIMIT 1"
                        )
                        .bind(&file_name)
                        .fetch_optional(pool)
                        .await
                        {
                            if let Some((path,)) = path_record {
                                source = path;
                            }
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
                Ok(files)
            }
            Err(e) => Err(format!("Database error: {}", e)),
        }
    } else {
        Err("DB not initialized".to_string())
    }
}

#[tauri::command]
pub async fn get_user_total_file_size(owner: String) -> Result<FileSizeBreakdown, String> {
    if let Some(pool) = DB_POOL.get() {
        let user_profile_rows = sqlx::query(
            r#"
            SELECT file_name, file_size_in_bytes, type
            FROM user_profiles
            WHERE owner = ?
            "#
        )
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Database error: {}", e))?;

        let mut public_size = 0;
        let mut private_size = 0;

        for row in user_profile_rows {
            let file_size = row.get::<i64, _>("file_size_in_bytes");
            let type_ = row.get::<String, _>("type");

            match type_.as_str() {
                "public" => public_size += file_size,
                "private" => private_size += file_size,
                _ => {}
            }
        }

        Ok(FileSizeBreakdown {
            public_size,
            private_size,
        })
    } else {
        Err("DB not initialized".to_string())
    }
}

#[tauri::command]
pub async fn start_user_profile_sync_tauri(app_handle: AppHandle, account_id: String) {
    println!("[UserSync] Received request to start sync for account: {}", account_id);
    start_user_sync(app_handle, &account_id);
}