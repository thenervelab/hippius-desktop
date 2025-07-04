
use subxt::tx::PairSigner;
use sp_core::{Pair, sr25519};
use crate::substrate_client::get_substrate_client;
use crate::constants::substrate::SEED_PHRASE;
use serde::Deserialize;

#[subxt::subxt(runtime_metadata_path = "metadata.scale")]
pub mod custom_runtime {}
use custom_runtime::runtime_types::ipfs_pallet::types::FileInput;
use custom_runtime::marketplace::calls::types::storage_unpin_request::FileHash;
use custom_runtime::runtime_types::bounded_collections::bounded_vec::BoundedVec;

#[derive(Deserialize)]
pub struct FileInputWrapper {
    pub file_hash: Vec<u8>,
    pub file_name: Vec<u8>,
}

#[derive(Deserialize)]
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

#[tauri::command]
pub async fn storage_request_tauri(
    files_input: Vec<FileInputWrapper>,
    miner_ids: Option<Vec<Vec<u8>>>,
) -> Result<String, String> {
    let pair = sr25519::Pair::from_string(SEED_PHRASE, None)
        .map_err(|e| format!("Failed to create pair: {:?}", e))?;

    let signer = PairSigner::new(pair);
    let api = get_substrate_client().await?;

    // Convert Vec<FileInputWrapper> to Vec<FileInput>
    let files_input: Vec<FileInput> = files_input.into_iter().map(FileInput::from).collect();

    let tx = custom_runtime::tx().marketplace().storage_request(files_input, miner_ids);
    let result = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("storage_request submitted: {:?}", result))
}

#[tauri::command]
pub async fn storage_unpin_request_tauri(
    file_hash_wrapper: FileHashWrapper,
) -> Result<String, String> {
    let pair = sr25519::Pair::from_string(SEED_PHRASE, None).map_err(|e| e.to_string())?;
    let signer = PairSigner::new(pair);
    let api = get_substrate_client().await?;

    let file_hash = FileHash::try_from(file_hash_wrapper)
        .map_err(|e| format!("FileHash conversion error: {}", e))?;
    let tx = custom_runtime::tx().marketplace().storage_unpin_request(file_hash);
    let result = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("storage_unpin_request submitted: {:?}", result))
}
