use subxt::tx::PairSigner;
use sp_core::{Pair, sr25519};
use crate::substrate_client::{get_substrate_client, get_current_wss_endpoint, update_wss_endpoint, test_wss_endpoint};
use serde::Deserialize;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;
use crate::DB_POOL;
use chrono::Utc;
use serde::Serialize;
use sqlx::Row;
use crate::utils::ipfs::{pin_json_to_ipfs_local, download_content_from_ipfs};
use serde_json::{json, Value};
use hex;
use crate::{start_public_folder_sync_tauri, start_private_folder_sync_tauri};
use crate::commands::syncing::ensure_aws_env;

#[subxt::subxt(runtime_metadata_path = "metadata.scale")]
pub mod custom_runtime {}
use custom_runtime::runtime_types::ipfs_pallet::types::FileInput;
use custom_runtime::marketplace::calls::types::storage_unpin_request::FileHash;
use custom_runtime::runtime_types::bounded_collections::bounded_vec::BoundedVec;

#[derive(Deserialize, Debug)]
pub struct FileInputWrapper {
    pub file_hash: Vec<u8>,
    pub file_name: Vec<u8>,
}

#[derive(Deserialize, Debug)]
pub struct FileHashWrapper {
    pub file_hash: Vec<u8>,
}

impl TryFrom<FileHashWrapper> for FileHash {
    type Error = String;

    fn try_from(wrapper: FileHashWrapper) -> Result<Self, Self::Error> {
        // Check if the file_hash length exceeds the maximum allowed length
        if wrapper.file_hash.len() > 350u32 as usize {
            return Err(format!(
                "File hash length {} exceeds maximum allowed length {}",
                wrapper.file_hash.len(),
                350u32
            ));
        }
        // Convert Vec<u8> to BoundedVec<u8, ConstU32<MAX_FILE_HASH_LENGTH>>
        Ok(BoundedVec(wrapper.file_hash))
    }
}

impl From<FileInputWrapper> for FileInput {
    fn from(wrapper: FileInputWrapper) -> Self {
        FileInput {
            file_hash: wrapper.file_hash,
            file_name: wrapper.file_name,
        }
    }
}

#[derive(serde::Deserialize)]
pub struct SetSyncPathParams {
    pub path: String,
    pub is_public: bool,
    pub account_id: String,
    pub mnemonic: String,
}

#[derive(Serialize, Debug)]
pub struct SyncPathResult {
    pub path: String,
    pub is_public: bool,
}

pub static SUBSTRATE_TX_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn collect_folder_files_recursively<'a>(
    ipfs_api_url: &'a str,
    cid: &'a str,
    file_name: &'a str,
    files_to_unpin: &'a mut Vec<Value>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        // Add the current folder/file itself to the list.
        files_to_unpin.push(json!({
            "cid": cid,
            "filename": file_name
        }));

        if file_name.trim().ends_with(".folder") || file_name.trim().ends_with(".folder.ec_metadata") {
            // It's a folder, so process its contents recursively.
            let content_bytes = download_content_from_ipfs(ipfs_api_url, cid).await?;
            let folder_contents: Vec<Value> = serde_json::from_slice(&content_bytes)
                .map_err(|e| format!("Failed to parse folder JSON for {}: {}", cid, e))?;

            for item in folder_contents {
                if let (Some(item_cid), Some(item_filename)) = (
                    item["cid"].as_str(),
                    item["file_name"].as_str(),
                ) {
                    collect_folder_files_recursively(
                        ipfs_api_url,
                        item_cid,
                        item_filename,
                        files_to_unpin,
                    )
                    .await?;
                }
            }
        } else if file_name.trim().ends_with(".ec_metadata") {
            // It's a metadata file, so process its chunks.
            let content_bytes = download_content_from_ipfs(ipfs_api_url, cid).await?;
            let metadata: Value = serde_json::from_slice(&content_bytes)
                .map_err(|e| format!("Failed to parse metadata JSON: {}", e))?;

            if let Some(chunks) = metadata["chunks"].as_array() {
                for chunk in chunks {
                    if let (Some(chunk_cid), Some(chunk_filename)) = (
                        chunk["cid"]["cid"].as_str(),
                        chunk["cid"]["filename"].as_str(),
                    ) {
                        files_to_unpin.push(json!({
                            "cid": chunk_cid,
                            "filename": chunk_filename
                        }));
                    }
                }
            }
        }

        Ok(())
    })
}

#[tauri::command]
pub async fn set_sync_path(
    app_handle: tauri::AppHandle,
    params: SetSyncPathParams
) -> Result<String, String> {
    let path_type = if params.is_public { "public" } else { "private" };
    let timestamp = Utc::now().timestamp();

    if let Some(pool) = DB_POOL.get() {
        // Detect if this is the first time setting this type of path
        let existing_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_paths"
        )
        .fetch_one(pool)
        .await
        .unwrap_or(0);
        let is_first_time = existing_count == 0;

        // If this is the first time enabling this sync type, ensure AWS env is configured
        if is_first_time {
            let account_for_env = params.account_id.clone();
            let mnemonic_for_env = params.mnemonic.clone();
            tokio::spawn(async move {
                ensure_aws_env(account_for_env, mnemonic_for_env).await;
            });
        }

        // Detect if this is the first time setting this type of path
        let existing_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_paths WHERE type = ?"
        )
        .bind(path_type)
        .fetch_one(pool)
        .await
        .unwrap_or(0);
        let is_first_time_for_type = existing_count == 0;

        let res = sqlx::query(
            "INSERT INTO sync_paths (path, type, timestamp) VALUES (?, ?, ?)
             ON CONFLICT(type) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp"
        )
        .bind(&params.path)
        .bind(path_type)
        .bind(timestamp)
        .execute(pool)
        .await;

        match res {
            Ok(_) => {
                println!("[set_sync_path] Sync path for '{}' set successfully in DB.", path_type);

                // Now spawn the appropriate sync task depending on type
                if params.is_public {
                    let app_handle_public = app_handle.clone();
                    let account = params.account_id.clone();
                    let mnemonic = params.mnemonic.clone();

                    if is_first_time_for_type {
                        let handle = tokio::spawn(async move {
                            println!("[set_sync_path] Starting PUBLIC sync task...");
                            start_public_folder_sync_tauri(app_handle_public, account.clone(), mnemonic).await;
                        });
                        crate::commands::syncing::register_task(app_handle.clone(), handle).await;
    
                        // Start PUBLIC S3 listing cron (every 30 seconds)
                        if let Some(pool) = crate::DB_POOL.get() {
                            let pool_pub = pool.clone();
                            let account_for_cron_pub = params.account_id.clone();
                            let handle = tokio::spawn(async move {
                                let interval = 30u64; // 30 seconds
                                loop {
                                    match crate::sync_shared::list_bucket_contents(account_for_cron_pub.clone(), "public".to_string()).await {
                                        Ok(items) => {
                                            if let Err(e) = crate::sync_shared::store_bucket_listing_in_db(&pool_pub, &account_for_cron_pub, "public", &items).await {
                                                eprintln!("[set_sync_path][S3InventoryCron][public] Failed storing listing: {}", e);
                                            } else {
                                                println!("[set_sync_path][S3InventoryCron][public] Stored {} items for {}", items.len(), account_for_cron_pub);
                                            }
                                        }
                                        Err(e) => eprintln!("[set_sync_path][S3InventoryCron][public] List failed: {}", e),
                                    }

                                    tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                                }
                            });
                            crate::commands::syncing::register_task(app_handle.clone(), handle).await;
                        } else {
                            eprintln!("[set_sync_path][S3InventoryCron] DB pool unavailable; skipping PUBLIC inventory cron start");
                        }
                    }

                } else {
                    let app_handle_private = app_handle.clone();
                    let account = params.account_id.clone();
                    let mnemonic = params.mnemonic.clone();

                    if is_first_time_for_type {
                        let handle = tokio::spawn(async move {
                            println!("[set_sync_path] Starting PRIVATE sync task...");
                            start_private_folder_sync_tauri(app_handle_private, account.clone(), mnemonic).await;
                        });
                        crate::commands::syncing::register_task(app_handle.clone(), handle).await;
    
                        // Start PRIVATE S3 listing cron (every 30 seconds)
                        if let Some(pool) = crate::DB_POOL.get() {
                            let pool_priv = pool.clone();
                            let account_for_cron_priv = params.account_id.clone();
                            let handle = tokio::spawn(async move {
                                let interval = 30u64; // 30 seconds
                                loop {
                                    match crate::sync_shared::list_bucket_contents(account_for_cron_priv.clone(), "private".to_string()).await {
                                        Ok(items) => {
                                            if let Err(e) = crate::sync_shared::store_bucket_listing_in_db(&pool_priv, &account_for_cron_priv, "private", &items).await {
                                                eprintln!("[S3InventoryCron][private] Failed storing listing: {}", e);
                                            } else {
                                                println!("[S3InventoryCron][private] Stored {} items for {}", items.len(), account_for_cron_priv);
                                            }
                                        }
                                        Err(e) => eprintln!("[S3InventoryCron][private] List failed: {}", e),
                                    }

                                    tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                                }
                            });
                            crate::commands::syncing::register_task(app_handle.clone(), handle).await;
                        } else {
                            eprintln!("[set_sync_path][S3InventoryCron] DB pool unavailable; skipping PRIVATE inventory cron start");
                        }   
                    }
                }

                Ok(format!("Sync path for '{}' set successfully.", path_type))
            }
            Err(e) => Err(format!("Failed to set sync path: {}", e)),
        }
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

#[tauri::command]
pub async fn transfer_balance_tauri(
    sender_seed: String,
    recipient_address: String,
    amount: String,
) -> Result<String, String> {
    use subxt::tx::PairSigner;
    use sp_core::{Pair, sr25519, crypto::Ss58Codec};
    use crate::substrate_client::get_substrate_client;

    // Parse the string to u128
    let amount: u128 = amount.parse().map_err(|e| format!("Invalid amount: {}", e))?;

    // Create signer from sender's seed
    let pair = sr25519::Pair::from_string(&sender_seed, None)
        .map_err(|e| format!("Failed to create signer pair: {e:?}"))?;
    let signer = PairSigner::new(pair);

    // Parse recipient address
    let recipient = sp_core::crypto::AccountId32::from_ss58check(&recipient_address)
        .map_err(|e| format!("Invalid recipient address: {e:?}"))?;

    // Get API client
    let api = get_substrate_client()
        .await
        .map_err(|e| format!("Failed to connect to Substrate node: {e}"))?;

    // Use the generated call for transfer_keep_alive
    let tx = custom_runtime::tx().balances().transfer_keep_alive(recipient.into(), amount);

    println!("[Substrate] Submitting balance transfer transaction...");
    let tx_hash = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Failed to submit transaction: {}", e))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {}", e))?
        .extrinsic_hash();

    println!("[Substrate] Transfer submitted with hash: {:?}", tx_hash);

    Ok(format!(
        "✅ Transfer submitted successfully!\n📦 Finalized in block: {tx_hash}"
    ))
}

// Add this internal function
pub async fn get_sync_path_internal(is_public: bool) -> Result<SyncPathResult, String> {
    let path_type = if is_public { "public" } else { "private" };
    if let Some(pool) = DB_POOL.get() {
        let rec = sqlx::query("SELECT path FROM sync_paths WHERE type = ?")
            .bind(path_type)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("DB error: {}", e))?;
        let path = if let Some(row) = rec {
            row.get::<String, _>("path")
        } else {
            // Return error instead of fallback to constant
            return Err(format!("Sync path for {} not set yet. Please configure encryption key first.", path_type));
        };
        Ok(SyncPathResult { path, is_public })
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

#[tauri::command]
pub async fn get_sync_path(is_public: bool) -> Result<SyncPathResult, String> {
    get_sync_path_internal(is_public).await
}

#[tauri::command]
pub async fn get_wss_endpoint() -> Result<String, String> {
    get_current_wss_endpoint().await
}

#[tauri::command]
pub async fn update_wss_endpoint_command(endpoint: String) -> Result<String, String> {
    update_wss_endpoint(endpoint.clone()).await?;
    Ok(format!("WSS endpoint updated to: {}", endpoint))
}

#[tauri::command]
pub async fn test_wss_endpoint_command(endpoint: String) -> Result<bool, String> {
    test_wss_endpoint(endpoint).await
}

type SubAccountRole = custom_runtime::runtime_types::pallet_subaccount::pallet::Role;

#[tauri::command]
pub async fn add_sub_account_tauri(
    main_seed: String,
    sub_seed: String,
) -> Result<String, String> {
    // Acquire the global lock
    let _lock = SUBSTRATE_TX_LOCK.lock().await;

    // Build signer from main seed
    let main_pair = sr25519::Pair::from_string(&main_seed, None)
        .map_err(|e| format!("Failed to create main signer pair: {e:?}"))?;
    let signer = PairSigner::new(main_pair.clone()); // Clone the pair for the signer

    // --- THE FIX IS HERE ---
    // Derive main_id directly from the main_pair's public key. This is unambiguous.
    let main_id: sp_core::crypto::AccountId32 = sp_core::crypto::AccountId32::from(main_pair.public());

    // Build sub account id from sub seed
    let sub_pair = sr25519::Pair::from_string(&sub_seed, None)
        .map_err(|e| format!("Failed to create sub pair: {e:?}"))?;
    let sub_id: sp_core::crypto::AccountId32 = sp_core::crypto::AccountId32::from(sub_pair.public());

    let api = get_substrate_client()
        .await
        .map_err(|e| format!("Failed to connect to Substrate node: {e}"))?;

    // Hardcode role to UploadDelete
    let role: SubAccountRole = SubAccountRole::UploadDelete;

    // Submit tx
    let tx = custom_runtime::tx().sub_account().add_sub_account(main_id.into(), sub_id.into(), role);
    println!("[Substrate] Submitting add_sub_account transaction...");
    let tx_hash = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Failed to submit transaction: {}", e))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {}", e))?
        .extrinsic_hash();
    println!("[Substrate] add_sub_account finalized: {:?}", tx_hash);

    // small cooldown similar to other txs
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    Ok(format!("✅ add_sub_account submitted! Finalized in block: {tx_hash}"))
}