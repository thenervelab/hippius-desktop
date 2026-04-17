//! Balance transfer commands — send funds, validate transfers.

use crate::blockchain::client::get_substrate_client;
use crate::blockchain::convert::to_plancks;
use crate::blockchain::helpers::{get_signer, get_substrate_address};
use crate::blockchain::queries::validate_address;
use crate::blockchain::runtime::custom_runtime;
use crate::blockchain::types::{TxResult, ValidatedTransfer};
use std::str::FromStr;
use tracing::info;

/// Estimated transaction fee in planck.
const ESTIMATED_TRANSFER_FEE_PLANCK: u128 = 270_233_151;

/// Max-transferable amount for the "Send Max" UX on the balance page.
///
/// Pure function — takes a planck balance string, subtracts the fee, and
/// returns both the remaining planck and the formatted HIP string. Lives
/// in Rust so the fee constant, the BigInt subtraction, and the planck→HIP
/// conversion are all owned by the backend (the same places the actual
/// transfer logic lives).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaxTransferable {
    pub planck: String,
    pub hip: String,
}

#[tauri::command]
pub fn compute_max_transferable(balance_planck: String) -> MaxTransferable {
    let balance = balance_planck.parse::<u128>().unwrap_or(0);
    let max_planck = balance.saturating_sub(ESTIMATED_TRANSFER_FEE_PLANCK);
    let planck = max_planck.to_string();
    let hip = crate::blockchain::convert::planck_to_hip_full(planck.clone());
    MaxTransferable { planck, hip }
}

/// Transfer balance using the keypair from `AppState.auth`.
#[tauri::command]
pub async fn transfer_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    recipient_address: String,
    amount: String,
) -> Result<TxResult, crate::error::AppError> {
    let signer = get_signer(&state)?;
    let client = get_substrate_client(&state).await?;

    let amount: u128 = amount
        .parse()
        .map_err(|e| crate::error::AppError::Other(format!("Invalid amount: {e}")))?;

    // Parse the recipient as a `subxt::utils::AccountId32` directly —
    // this avoids the removed `sp_core::crypto::AccountId32 → MultiAddress`
    // conversion that only existed under `substrate-compat`.
    let recipient = subxt::utils::AccountId32::from_str(&recipient_address)
        .map_err(|e| crate::error::AppError::Other(format!("Invalid recipient address: {e:?}")))?;

    info!("Submitting transfer_keep_alive transaction...");
    let tx = custom_runtime::tx().balances().transfer_keep_alive(recipient.into(), amount);

    let tx_hash = client
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Submit failed: {e}")))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Transaction failed: {e}")))?
        .extrinsic_hash();

    info!("Transfer tx finalized: {:?}", tx_hash);
    Ok(TxResult {
        tx_hash: format!("{tx_hash:?}"),
        success: true,
    })
}

/// Validate a balance transfer in a single call — fetches balance from chain.
#[tauri::command]
pub async fn validate_send_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    recipient_address: String,
    amount: String,
) -> Result<ValidatedTransfer, crate::error::AppError> {
    if !validate_address(recipient_address) {
        return Err(crate::error::AppError::Validation("Invalid recipient address".into()));
    }

    let address = get_substrate_address(&state)?;
    let client = get_substrate_client(&state).await?;
    let account_id: subxt::utils::AccountId32 = address.parse().map_err(|_| format!("Invalid sender address: {address}"))?;
    let storage_query = custom_runtime::storage().system().account(&account_id);
    let account_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?
        .fetch(&storage_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Query failed: {e}")))?;
    let available: u128 = account_info.map_or(0, |i| i.data.free);

    let planck_str = to_plancks(amount)?;
    let planck: u128 = planck_str
        .parse()
        .map_err(|_| crate::error::AppError::Validation("Invalid planck amount".into()))?;

    if planck == 0 {
        return Err(crate::error::AppError::Validation("Amount must be greater than zero".into()));
    }

    if planck > available {
        return Err(crate::error::AppError::Validation("Amount exceeds your available balance".into()));
    }
    if planck.saturating_add(ESTIMATED_TRANSFER_FEE_PLANCK) > available {
        return Err(crate::error::AppError::Validation(
            "Amount (incl. transaction fee) exceeds your balance".into(),
        ));
    }

    let estimated_fee = ESTIMATED_TRANSFER_FEE_PLANCK.to_string();
    let available_balance_planck = available.to_string();
    Ok(ValidatedTransfer {
        planck_amount_hip: crate::blockchain::convert::planck_to_hip(&planck_str),
        estimated_fee_hip: crate::blockchain::convert::planck_to_hip(&estimated_fee),
        available_balance_hip: crate::blockchain::convert::planck_to_hip(&available_balance_planck),
        planck_amount: planck_str,
        estimated_fee,
        available_balance_planck,
    })
}
