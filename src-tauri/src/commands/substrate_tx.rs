use subxt::tx::PairSigner;
use sp_core::{Pair, sr25519};
use crate::substrate_client::get_substrate_client;
use serde::Deserialize;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;
use crate::DB_POOL;
use chrono::Utc;
use serde::Serialize;
use sqlx::Row;

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

#[derive(Deserialize, Debug)]
pub struct SetSyncPathParams {
    pub path: String,
    pub is_public: bool,
}

#[derive(Serialize, Debug)]
pub struct SyncPathResult {
    pub path: String,
    pub is_public: bool,
}

pub static SUBSTRATE_TX_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[tauri::command]
pub async fn storage_request_tauri(
    files_input: Vec<FileInputWrapper>,
    miner_ids: Option<Vec<Vec<u8>>>,
    seed_phrase: String,
) -> Result<String, String> {
    // Acquire the global lock
    let _lock = SUBSTRATE_TX_LOCK.lock().await;

    let pair = sr25519::Pair::from_string(&seed_phrase, None)
        .map_err(|e| format!("Failed to create signer pair: {e:?}"))?;
    let signer = PairSigner::new(pair);
    let account_id = signer.account_id();

    let api = get_substrate_client()
        .await
        .map_err(|e| format!("Failed to connect to Substrate node: {e}"))?;

    // Convert file inputs
    let files_input: Vec<FileInput> = files_input
        .into_iter()
        .map(FileInput::from)
        .collect();
    let tx = custom_runtime::tx().marketplace().storage_request(files_input, miner_ids);

    // Submit tx
    println!("Submitting storage request transaction");
    let tx_hash = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Failed to submit transaction: {}", e))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {}", e))?
        .extrinsic_hash();

    println!("Transaction submitted with hash: {:?}", tx_hash);
    // we should wait 6 secs so that this block is passed before doing next tx
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    
    Ok(format!(
        "✅ storage_request submitted successfully!\n📦 Finalized in block: {tx_hash}"
    ))
}

#[tauri::command]
pub async fn storage_unpin_request_tauri(
    file_hash_wrapper: FileHashWrapper,
    seed_phrase: String
) -> Result<String, String> {
    // Acquire the global lock
    let _lock = SUBSTRATE_TX_LOCK.lock().await;

    let pair = sr25519::Pair::from_string(&seed_phrase, None).map_err(|e| e.to_string())?;
    let signer = PairSigner::new(pair);
    let api = get_substrate_client().await?;

    let file_hash = FileHash::try_from(file_hash_wrapper)
        .map_err(|e| format!("FileHash conversion error: {}", e))?;
    let tx = custom_runtime::tx().marketplace().storage_unpin_request(file_hash);

    println!("Submitting unpin request transaction");
    let tx_hash = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Failed to submit transaction: {}", e))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {}", e))?
        .extrinsic_hash();
    println!("Transaction submitted with hash: {:?}", tx_hash);

    // we should wait 6 secs so that this block is passed before doing next tx
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    Ok(format!("storage_unpin_request submitted: {:?}", tx_hash))
}

#[tauri::command]
pub async fn set_sync_path(params: SetSyncPathParams) -> Result<String, String> {
    let path_type = if params.is_public { "public" } else { "private" };
    let timestamp = Utc::now().timestamp();
    if let Some(pool) = DB_POOL.get() {
        // Upsert logic: update if exists, else insert
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
            Ok(_) => Ok(format!("Sync path for '{}' set successfully.", path_type)),
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
    amount: String, // as string for frontend compatibility
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

// Tauri command just calls the internal function
#[tauri::command]
pub async fn get_sync_path(is_public: bool) -> Result<SyncPathResult, String> {
    get_sync_path_internal(is_public).await
}