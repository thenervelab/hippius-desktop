//! Substrate runtime type bindings, legacy transfer, and WSS endpoint commands.
//!
//! Houses the `subxt`-generated [`custom_runtime`] module (from `metadata.scale`)
//! which provides type-safe access to all Hippius chain pallets.

use crate::blockchain::client::{get_current_wss_endpoint, get_substrate_client, update_wss_endpoint};
use serde::Deserialize;
use tracing::info;

#[subxt::subxt(runtime_metadata_path = "metadata.scale")]
pub mod custom_runtime {}
use custom_runtime::marketplace::calls::types::storage_unpin_request::FileHash;
use custom_runtime::runtime_types::bounded_collections::bounded_vec::BoundedVec;
use custom_runtime::runtime_types::ipfs_pallet::types::FileInput;

/// Frontend-friendly wrapper for file pin requests.
#[derive(Deserialize, Debug)]
pub struct FileInputWrapper {
    pub file_hash: Vec<u8>,
    pub file_name: Vec<u8>,
}

/// Frontend-friendly wrapper for file unpin requests.
#[derive(Deserialize, Debug)]
pub struct FileHashWrapper {
    pub file_hash: Vec<u8>,
}

impl TryFrom<FileHashWrapper> for FileHash {
    type Error = String;

    fn try_from(wrapper: FileHashWrapper) -> Result<Self, Self::Error> {
        if wrapper.file_hash.len() > 350u32 as usize {
            return Err(format!(
                "File hash length {} exceeds maximum allowed length {}",
                wrapper.file_hash.len(),
                350u32
            ));
        }
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

/// Legacy transfer command that accepts a raw seed phrase.
///
/// Prefer [`crate::blockchain::transfers::transfer_balance`] which uses the
/// in-memory keypair instead of requiring the seed to be passed over IPC.
#[tauri::command]
pub async fn transfer_balance_tauri(
    state: tauri::State<'_, crate::app_state::AppState>,
    sender_seed: String,
    recipient_address: String,
    amount: String,
) -> Result<String, crate::error::AppError> {
    use sp_core::{Pair, crypto::Ss58Codec, sr25519};
    use subxt::tx::PairSigner;

    let amount: u128 = amount
        .parse()
        .map_err(|e| crate::error::AppError::Other(format!("Invalid amount: {e}")))?;

    let pair = sr25519::Pair::from_string(&sender_seed, None)
        .map_err(|e| crate::error::AppError::Other(format!("Failed to create signer pair: {e:?}")))?;
    let signer = PairSigner::new(pair);

    let recipient = sp_core::crypto::AccountId32::from_ss58check(&recipient_address)
        .map_err(|e| crate::error::AppError::Other(format!("Invalid recipient address: {e:?}")))?;

    let api = get_substrate_client(&state).await?;
    let tx = custom_runtime::tx()
        .balances()
        .transfer_keep_alive(recipient.into(), amount);

    info!("Submitting balance transfer transaction...");
    let tx_hash = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| crate::error::AppError::Substrate(e.to_string()))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Transaction failed: {e}")))?
        .extrinsic_hash();

    info!("Transfer submitted with hash: {:?}", tx_hash);
    Ok(format!("Transfer submitted successfully! Finalized in block: {tx_hash}"))
}

/// Fetch the current WSS endpoint.
#[tauri::command]
pub async fn get_wss_endpoint(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<String, crate::error::AppError> {
    Ok(get_current_wss_endpoint(state.pool()?).await?)
}

/// Update the WSS endpoint.
#[tauri::command]
pub async fn update_wss_endpoint_command(
    state: tauri::State<'_, crate::app_state::AppState>,
    endpoint: String,
) -> Result<String, crate::error::AppError> {
    update_wss_endpoint(&state, endpoint.clone()).await?;
    Ok(format!("WSS endpoint updated to: {endpoint}"))
}

/// Test if an RPC endpoint is reachable.
#[tauri::command]
pub async fn test_rpc_endpoint_command(endpoint: String) -> Result<(), crate::error::AppError> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err(crate::error::AppError::Validation(
            "Please enter an RPC endpoint".into(),
        ));
    }
    if !trimmed.starts_with("ws://") && !trimmed.starts_with("wss://") {
        return Err(crate::error::AppError::Validation(
            "Invalid WSS endpoint format. URL must start with ws:// or wss://".into(),
        ));
    }
    crate::blockchain::client::test_rpc_endpoint(trimmed)
        .await
        .map_err(crate::error::AppError::Other)
}
