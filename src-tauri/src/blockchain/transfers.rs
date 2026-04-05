//! Balance transfer commands — send funds, validate transfers.

use crate::blockchain::client::get_substrate_client;
use crate::blockchain::convert::to_plancks;
use crate::blockchain::helpers::{get_signer, get_substrate_address};
use crate::blockchain::queries::validate_address;
use crate::blockchain::runtime::custom_runtime;
use crate::blockchain::types::{TxResult, ValidatedTransfer};
use sp_core::crypto::Ss58Codec;
use tracing::info;

/// Estimated transaction fee in planck.
const ESTIMATED_TRANSFER_FEE_PLANCK: u128 = 270_233_151;

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

    let recipient = <sp_core::crypto::AccountId32 as Ss58Codec>::from_ss58check(&recipient_address)
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

/// Validate a transfer amount and convert to planck.
#[tauri::command]
pub fn validate_and_convert_transfer(amount: String, available_balance_planck: String, fee_planck: String) -> Result<String, crate::error::AppError> {
    if amount.trim().is_empty() {
        return Err(crate::error::AppError::Validation("Amount is required".into()));
    }

    let num: f64 = amount
        .parse()
        .map_err(|_| crate::error::AppError::Validation("Amount must be a valid number".into()))?;

    if num <= 0.0 {
        return Err(crate::error::AppError::Validation("Amount must be greater than zero".into()));
    }

    let planck = to_plancks(amount)?;
    let planck_u128: u128 = planck.parse().unwrap_or(0);
    let balance_u128: u128 = available_balance_planck.parse().unwrap_or(0);
    let fee_u128: u128 = fee_planck.parse().unwrap_or(0);

    if planck_u128 > balance_u128 {
        return Err(crate::error::AppError::Validation("Amount exceeds your available balance".into()));
    }

    if planck_u128.saturating_add(fee_u128) > balance_u128 {
        return Err(crate::error::AppError::Validation(
            "Amount (incl. transaction fee) exceeds your balance".into(),
        ));
    }

    Ok(planck)
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

    Ok(ValidatedTransfer {
        planck_amount: planck_str,
        estimated_fee: ESTIMATED_TRANSFER_FEE_PLANCK.to_string(),
        available_balance_planck: available.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_valid_amount() {
        let result = validate_and_convert_transfer("1.0".into(), "2000000000000000000".into(), "270233151".into());
        assert_eq!(result.unwrap(), "1000000000000000000");
    }

    #[test]
    fn transfer_empty_amount() {
        let result = validate_and_convert_transfer("".into(), "1000".into(), "0".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("required"));
    }

    #[test]
    fn transfer_invalid_number() {
        let result = validate_and_convert_transfer("abc".into(), "1000".into(), "0".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("valid number"));
    }

    #[test]
    fn transfer_zero_amount() {
        let result = validate_and_convert_transfer("0".into(), "1000".into(), "0".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("greater than zero"));
    }

    #[test]
    fn transfer_exceeds_balance() {
        let result = validate_and_convert_transfer("3.0".into(), "2000000000000000000".into(), "0".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("exceeds"));
    }

    #[test]
    fn transfer_exceeds_with_fee() {
        let result = validate_and_convert_transfer("2.0".into(), "2000000000000000000".into(), "270233151".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("fee"));
    }
}
