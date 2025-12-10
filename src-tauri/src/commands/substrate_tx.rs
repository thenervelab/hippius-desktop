use crate::DB_POOL;
use crate::commands::syncing::ensure_aws_env;
use crate::substrate_client::{
    get_current_wss_endpoint, get_substrate_client, test_wss_endpoint, update_wss_endpoint,
};
use crate::sync_engine::DeletePolicy;
use crate::sync_shared::{
    GLOBAL_CANCEL_TOKEN, S3_PRIVATE_SYNC_STATE, S3_PUBLIC_SYNC_STATE, S3SyncState, SYNCING_ACCOUNTS,
};
use crate::{start_private_folder_sync_tauri, start_public_folder_sync_tauri};
use crate::utils::objectstore_tokens::{has_master_token, save_temp_auth_key};
use chrono::Utc;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde::Serialize;
use sp_core::{Pair, sr25519};
use sqlx::Row;
use crate::utils::account_key::account_key;
use std::sync::atomic::Ordering;
use std::time::Duration;
use subxt::tx::PairSigner;
use tauri::Emitter;
use tokio::sync::Mutex;

#[subxt::subxt(runtime_metadata_path = "metadata.scale")]
pub mod custom_runtime {}
use custom_runtime::marketplace::calls::types::storage_unpin_request::FileHash;
use custom_runtime::runtime_types::bounded_collections::bounded_vec::BoundedVec;
use custom_runtime::runtime_types::ipfs_pallet::types::FileInput;

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
    pub temp_auth_key: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSyncPathParams {
    pub is_public: bool,
    pub account_id: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct SyncPathResult {
    pub path: String,
    pub is_public: bool,
}

pub static SUBSTRATE_TX_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

use crate::commands::syncing::get_sync_policy_from_db;

#[tauri::command]
pub async fn set_sync_path(
    app_handle: tauri::AppHandle,
    params: SetSyncPathParams,
) -> Result<String, String> {
    crate::utils::sync::set_active_account(&params.account_id);

    // If no master token yet and a temp auth key is provided, store it now for this account.
    if !has_master_token(&params.account_id).await.unwrap_or(false) {
        if let Some(tk) = params
            .temp_auth_key
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            let _ = save_temp_auth_key(&params.account_id, tk).await;
        }
    }
    let path_type = if params.is_public {
        "public"
    } else {
        "private"
    };
    let timestamp = Utc::now().timestamp();

    if let Some(pool) = DB_POOL.get() {
        // Get the current sync path (if any) to detect changes
        let owner = account_key(&params.account_id);
        // Legacy cleanup: if a pre-owner row exists (owner is empty) with the same type, replace it once.
        if let Ok(Some(legacy_id)) = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1",
        )
        .bind(path_type)
        .fetch_optional(pool)
        .await
        {
            let _ = sqlx::query(
                "REPLACE INTO sync_paths (id, owner, path, type, timestamp) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(legacy_id)
            .bind(&owner)
            .bind(&params.path)
            .bind(path_type)
            .bind(timestamp)
            .execute(pool)
            .await;
        }
        let current_path: Option<String> =
            sqlx::query_scalar("SELECT path FROM sync_paths WHERE owner = ? AND type = ?")
                .bind(&owner)
                .bind(path_type)
                .fetch_optional(pool)
                .await
                .unwrap_or(None);

        let is_path_changed = current_path
            .as_ref()
            .map(|p| p != &params.path)
            .unwrap_or(true);

        // Always stop any ongoing sync and clear state when setting a new path
        {
            println!(
                "[set_sync_path] Preparing to update sync path for '{}'",
                path_type
            );

            // 1. Signal global cancellation to stop any ongoing sync operations
            GLOBAL_CANCEL_TOKEN.store(true, Ordering::SeqCst);

            // 2. Clear the account from SYNCING_ACCOUNTS
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts
                    .retain(|(acc, typ)| !(acc == &params.account_id && typ == &path_type));
                println!(
                    "[set_sync_path] Cleared sync account for {} {}",
                    path_type, params.account_id
                );
            }

            // 3. Reset the appropriate sync state
            if params.is_public {
                let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
                *state = S3SyncState::default();
                println!("[set_sync_path] Reset public sync state");
            } else {
                let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
                *state = S3SyncState::default();
                println!("[set_sync_path] Reset private sync state");
            }

            // 4. Reset the cancellation token for the new sync
            GLOBAL_CANCEL_TOKEN.store(false, Ordering::SeqCst);

            // Small delay to ensure all operations are cleaned up
            tokio::time::sleep(Duration::from_millis(500)).await;

            if is_path_changed && current_path.is_some() {
                println!(
                    "[set_sync_path] Sync path changed from {:?} to {}",
                    current_path, params.path
                );
            }
        }

        // Rest of your existing code for database update and sync start...
        let res = sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, timestamp) VALUES (?, ?, ?, ?)
             ON CONFLICT(owner, type) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp",
        )
        .bind(&owner)
        .bind(&params.path)
        .bind(path_type)
        .bind(timestamp)
        .execute(pool)
        .await;

        match res {
            Ok(_) => {
                println!(
                    "[set_sync_path] Sync path for '{}' set successfully in DB.",
                    path_type
                );

                // Create security-scoped bookmark for macOS
                #[cfg(target_os = "macos")]
                {
                    use crate::utils::bookmark_db::store_bookmark;
                    if let Err(e) = store_bookmark(&params.path, path_type).await {
                        eprintln!(
                            "[set_sync_path] Warning: Failed to create security-scoped bookmark: {}",
                            e
                        );
                        // Don't fail the entire operation if bookmark creation fails
                    }
                }

                // Now spawn the appropriate sync task depending on type
                if params.is_public {
                    let app_handle_public = app_handle.clone();
                    let account = params.account_id.clone();

                    let handle = tokio::spawn(async move {
                        if let Err(e) = ensure_aws_env(account.clone()).await {
                            eprintln!("[set_sync_path] Aborting public sync start: {}", e);
                            return;
                        }

                        println!("[set_sync_path] Starting PUBLIC sync task...");
                        match get_sync_policy_from_db().await {
                            Ok(delete_policy) => {
                                start_public_folder_sync_tauri(
                                    app_handle_public,
                                    account.clone(),
                                    delete_policy,
                                )
                                .await;
                            }
                            Err(e) => {
                                eprintln!("[set_sync_path] Failed to get delete policy: {}", e);
                                // Fallback to default policy if DB lookup fails
                                start_public_folder_sync_tauri(
                                    app_handle_public,
                                    account.clone(),
                                    DeletePolicy::UploadOnly,
                                )
                                .await;
                            }
                        }
                    });
                    crate::commands::syncing::register_task(app_handle.clone(), handle).await;
                    // emit sync started event
                    match crate::utils::sync::reset_sync_event_state("public").await {
                        Ok(_) => {
                            if let Err(e) = app_handle
                                .emit("started_syncing", serde_json::json!({"type": "public"}))
                                .map_err(|e| e.to_string())
                            {
                                eprintln!("Failed to emit started_syncing event: {}", e);
                            }
                            println!("[Sync] public Sync started event emitted");
                        }
                        Err(err) => {
                            eprintln!("Failed to determine if first run: {}", err);
                        }
                    }

                    // Start PUBLIC S3 listing cron
                    if let Some(pool) = crate::DB_POOL.get() {
                        let pool_pub = pool.clone();
                        let account_for_cron_pub = params.account_id.clone();
                        let handle = tokio::spawn(async move {
                            let interval = 30u64;
                            loop {
                                match crate::sync_shared::list_bucket_contents(
                                    account_for_cron_pub.clone(),
                                    "public".to_string(),
                                )
                                .await
                                {
                                    Ok(items) => {
                                        if let Err(e) =
                                            crate::sync_shared::store_bucket_listing_in_db(
                                                &pool_pub,
                                                &account_for_cron_pub,
                                                "public",
                                                &items,
                                            )
                                            .await
                                        {
                                            eprintln!(
                                                "[set_sync_path][S3InventoryCron][public] Failed storing listing: {}",
                                                e
                                            );
                                        }
                                    }
                                    Err(e) => eprintln!(
                                        "[set_sync_path][S3InventoryCron][public] List failed: {}",
                                        e
                                    ),
                                }
                                tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                            }
                        });
                        crate::commands::syncing::register_task(app_handle.clone(), handle).await;
                    }
                } else {
                    // Similar logic for private...
                    let app_handle_private = app_handle.clone();
                    let account = params.account_id.clone();

                    let handle = tokio::spawn(async move {
                        if let Err(e) = ensure_aws_env(account.clone()).await {
                            eprintln!("[set_sync_path] Aborting private sync start: {}", e);
                            return;
                        }

                        println!("[set_sync_path] Starting PRIVATE sync task...");
                        match get_sync_policy_from_db().await {
                            Ok(delete_policy) => {
                                start_private_folder_sync_tauri(
                                    app_handle_private,
                                    account.clone(),
                                    delete_policy,
                                )
                                .await;
                            }
                            Err(e) => {
                                eprintln!("[set_sync_path] Failed to get delete policy: {}", e);
                                // Fallback to default policy if DB lookup fails
                                start_private_folder_sync_tauri(
                                    app_handle_private,
                                    account.clone(),
                                    DeletePolicy::UploadOnly,
                                )
                                .await;
                            }
                        }
                    });
                    crate::commands::syncing::register_task(app_handle.clone(), handle).await;
                    // emit sync started event
                    match crate::utils::sync::reset_sync_event_state("private").await {
                        Ok(_) => {
                            if let Err(e) = app_handle
                                .emit("started_syncing", serde_json::json!({"type": "private"}))
                                .map_err(|e| e.to_string())
                            {
                                eprintln!("Failed to emit started_syncing event: {}", e);
                            }
                            println!("[Sync] private Sync started event emitted");
                        }
                        Err(err) => {
                            eprintln!("Failed to determine if first run: {}", err);
                        }
                    }

                    // Start PRIVATE S3 listing cron
                    if let Some(pool) = crate::DB_POOL.get() {
                        let pool_priv = pool.clone();
                        let account_for_cron_priv = params.account_id.clone();
                        let handle = tokio::spawn(async move {
                            let interval = 30u64;
                            loop {
                                match crate::sync_shared::list_bucket_contents(
                                    account_for_cron_priv.clone(),
                                    "private".to_string(),
                                )
                                .await
                                {
                                    Ok(items) => {
                                        if let Err(e) =
                                            crate::sync_shared::store_bucket_listing_in_db(
                                                &pool_priv,
                                                &account_for_cron_priv,
                                                "private",
                                                &items,
                                            )
                                            .await
                                        {
                                            eprintln!(
                                                "[S3InventoryCron][private] Failed storing listing: {}",
                                                e
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[S3InventoryCron][private] List failed: {}", e)
                                    }
                                }
                                tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                            }
                        });
                        crate::commands::syncing::register_task(app_handle.clone(), handle).await;
                    }
                }

                Ok(format!("Sync path for '{}' set successfully.", path_type))
            }
            Err(e) => {
                eprintln!(
                    "[set_sync_path] DB write failed for owner {} type {}: {}",
                    owner, path_type, e
                );
                Err(format!("Failed to set sync path: {}", e))
            }
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
    use crate::substrate_client::get_substrate_client;
    use sp_core::{Pair, crypto::Ss58Codec, sr25519};
    use subxt::tx::PairSigner;

    // Parse the string to u128
    let amount: u128 = amount
        .parse()
        .map_err(|e| format!("Invalid amount: {}", e))?;

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
    let tx = custom_runtime::tx()
        .balances()
        .transfer_keep_alive(recipient.into(), amount);

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
pub async fn get_sync_path_internal(is_public: bool, owner: &str) -> Result<SyncPathResult, String> {
    let path_type = if is_public { "public" } else { "private" };
    if let Some(pool) = DB_POOL.get() {
        // Try scoped entry first
        let rec_row = sqlx::query("SELECT path FROM sync_paths WHERE owner = ? AND type = ?")
            .bind(owner)
            .bind(path_type)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("DB error: {}", e))?;

        // If not found, migrate a legacy (owner='') row only when no scoped rows exist yet.
        let path_opt: Option<String> = if let Some(row) = rec_row {
            Some(row.get::<String, _>("path"))
        } else {
            let scoped_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(1) FROM sync_paths WHERE owner != '' AND owner IS NOT NULL",
            )
            .fetch_one(pool)
            .await
            .unwrap_or(0);

            if scoped_count == 0 {
                let mut tx = pool
                    .begin()
                    .await
                    .map_err(|e| format!("DB error (tx begin): {}", e))?;

                let legacy = sqlx::query_as::<_, (i64, String)>(
                    "SELECT id, path FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1",
                )
                .bind(path_type)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| format!("DB error: {}", e))?;

                if let Some((legacy_id, legacy_path)) = legacy {
                    // Remove any pre-existing scoped row to avoid UNIQUE constraint failures.
                    let _ = sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND type = ?")
                        .bind(owner)
                        .bind(path_type)
                        .execute(&mut *tx)
                        .await;

                    let _ = sqlx::query(
                        "UPDATE sync_paths SET owner = ? WHERE id = ? AND owner = ''",
                    )
                    .bind(owner)
                    .bind(legacy_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("DB error updating legacy row: {}", e))?;

                    tx.commit()
                        .await
                        .map_err(|e| format!("DB error (commit): {}", e))?;
                    Some(legacy_path)
                } else {
                    tx.commit()
                        .await
                        .map_err(|e| format!("DB error (commit): {}", e))?;
                    None
                }
            } else {
                None
            }
        };

        if let Some(path) = path_opt {
            Ok(SyncPathResult { path, is_public })
        } else {
            Err(format!(
                "Sync path for {} not set yet. Please configure encryption key first.",
                path_type
            ))
        }
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

#[tauri::command]
pub async fn get_sync_path(params: GetSyncPathParams) -> Result<SyncPathResult, String> {
    // Allow camelCase param names from the frontend and fall back to the active account if none provided.
    let account_id = match params
        .account_id
        .or_else(|| crate::utils::sync::current_account_id().ok())
    {
        Some(id) => id,
        None => {
            return Ok(SyncPathResult {
                path: "".to_string(),
                is_public: params.is_public,
            })
        }
    };
    let owner = account_key(&account_id);
    get_sync_path_internal(params.is_public, &owner).await
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
pub async fn add_sub_account_tauri(main_seed: String, sub_seed: String) -> Result<String, String> {
    let max_retries = 5;
    let mut retry_count = 0;
    let base_delay = std::time::Duration::from_secs(2);

    loop {
        match try_add_sub_account(&main_seed, &sub_seed).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if e.contains("MainCannotBeSubAccount") {
                    return Err(e); // Special case - don't retry
                }

                retry_count += 1;
                if retry_count >= max_retries {
                    return Err(format!("Failed after {} retries: {}", max_retries, e));
                }

                let delay = base_delay * 2_u32.pow(retry_count - 1);
                eprintln!(
                    "[Substrate] Attempt {} failed: {}. Retrying in {:?}",
                    retry_count, e, delay
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
}

async fn try_add_sub_account(main_seed: &str, sub_seed: &str) -> Result<String, String> {
    // Acquire the global lock
    let _lock = SUBSTRATE_TX_LOCK.lock().await;

    // Build signer from main seed
    let main_pair = sr25519::Pair::from_string(main_seed, None)
        .map_err(|e| format!("Failed to create main signer pair: {e:?}"))?;
    let signer = PairSigner::new(main_pair.clone());

    let main_id: sp_core::crypto::AccountId32 =
        sp_core::crypto::AccountId32::from(main_pair.public());

    // Build sub account id from sub seed
    let sub_pair = sr25519::Pair::from_string(sub_seed, None)
        .map_err(|e| format!("Failed to create sub pair: {e:?}"))?;
    let sub_id: sp_core::crypto::AccountId32 =
        sp_core::crypto::AccountId32::from(sub_pair.public());

    let api = get_substrate_client()
        .await
        .map_err(|e| format!("Failed to connect to Substrate node: {e}"))?;

    // Hardcode role to UploadDelete
    let role: SubAccountRole = SubAccountRole::UploadDelete;

    // Submit tx
    let tx =
        custom_runtime::tx()
            .sub_account()
            .add_sub_account(main_id.into(), sub_id.into(), role);
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

    Ok(format!(
        "✅ add_sub_account submitted! Finalized in block: {tx_hash}"
    ))
}
