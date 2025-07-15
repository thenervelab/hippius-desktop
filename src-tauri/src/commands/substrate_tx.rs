use subxt::tx::PairSigner;
use sp_core::{Pair, sr25519};
use crate::substrate_client::get_substrate_client;
// use crate::constants::substrate::SEED_PHRASE;
use serde::Deserialize;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;
use sp_core::crypto::Ss58Codec;

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
    println!("files Input is {:?}", files_input);
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
pub fn get_sync_path() -> String {
    crate::constants::substrate::SYNC_PATH.to_string()
}