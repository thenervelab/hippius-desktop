use subxt::tx::PairSigner;
use sp_core::{Pair, sr25519};
use subxt::{OnlineClient, PolkadotConfig};
use crate::substrate_client::get_substrate_client;

#[subxt::subxt(runtime_metadata_path = "metadata.scale")]
pub mod custom_runtime {}

use custom_runtime::runtime_types::ipfs_pallet::types::FileInput;
use custom_runtime::marketplace::calls::types::storage_unpin_request::FileHash;

const SEED_PHRASE: &str = "your seed phrase here";

#[tauri::command]
pub async fn storage_request_tauri(
    files_input: Vec<FileInput>,
    miner_ids: Option<Vec<Vec<u8>>>,
) -> Result<String, String> {

    let pair = sr25519::Pair::from_string(SEED_PHRASE, None)
    .map_err(|e| format!("Failed to create pair: {:?}", e))?;

    let signer = PairSigner::new(pair);
    let api = get_substrate_client().await?;

    let tx = custom_runtime::tx().marketplace().storage_request(files_input, miner_ids);
    let result = api.tx().sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("storage_request submitted: {:?}", result))
}

#[tauri::command]
pub async fn storage_unpin_request_tauri(
    file_hash: FileHash,
) -> Result<String, String> {
    let pair = sr25519::Pair::from_string(SEED_PHRASE, None).map_err(|e| e.to_string())?;
    let signer = PairSigner::new(pair);
    let api = get_substrate_client().await?;

    let tx = custom_runtime::tx().marketplace().storage_unpin_request(file_hash);
    let result = api.tx().sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("storage_unpin_request submitted: {:?}", result))
}
