//! Staking transaction commands — bond, unbond, withdraw, claim rewards.

use crate::blockchain::client::get_substrate_client;
use crate::blockchain::helpers::{get_signer, get_signer_and_address, sign_submit_track};
use crate::blockchain::runtime::custom_runtime;
use crate::blockchain::types::TxOutcome;
use tracing::info;

/// Bond tokens for staking. If already bonded, calls `bond_extra` instead.
/// Requires the active local wallet's password to derive a signing keypair.
#[tauri::command]
pub async fn stake_bond(
    state: tauri::State<'_, crate::app_state::AppState>,
    amount: String,
    password: String,
) -> Result<TxOutcome, crate::error::AppError> {
    let (signer, address) = get_signer_and_address(&state, &password).await?;
    let client = get_substrate_client(&state).await?;

    let amount: u128 = amount
        .parse()
        .map_err(|e| crate::error::AppError::Validation(format!("Invalid amount: {e}")))?;

    let account_id = address
        .parse::<subxt::utils::AccountId32>()
        .map_err(|_| crate::error::AppError::Validation("Invalid address".into()))?;

    let ledger_query = custom_runtime::storage().staking().ledger(&account_id);
    let already_bonded = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Storage error: {e}")))?
        .fetch(&ledger_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Ledger query failed: {e}")))?
        .is_some();

    let outcome = if already_bonded {
        info!("Submitting bond_extra transaction...");
        let tx = custom_runtime::tx().staking().bond_extra(amount);
        sign_submit_track(&client, &tx, &signer).await?
    } else {
        info!("Submitting bond transaction...");
        let tx = custom_runtime::tx()
            .staking()
            .bond(amount, custom_runtime::runtime_types::pallet_staking::RewardDestination::Staked);
        sign_submit_track(&client, &tx, &signer).await?
    };

    info!("Bond outcome: {outcome:?}");
    Ok(outcome)
}

/// Unbond tokens (schedule for withdrawal after the unbonding period).
/// Requires the active local wallet's password.
#[tauri::command]
pub async fn stake_unbond(
    state: tauri::State<'_, crate::app_state::AppState>,
    amount: String,
    password: String,
) -> Result<TxOutcome, crate::error::AppError> {
    let signer = get_signer(&state, &password).await?;
    let client = get_substrate_client(&state).await?;

    let amount: u128 = amount
        .parse()
        .map_err(|e| crate::error::AppError::Validation(format!("Invalid amount: {e}")))?;

    info!("Submitting unbond transaction...");
    let tx = custom_runtime::tx().staking().unbond(amount);
    let outcome = sign_submit_track(&client, &tx, &signer).await?;
    info!("Unbond outcome: {outcome:?}");
    Ok(outcome)
}

/// Withdraw unbonded tokens (after the unbonding period completes).
/// Requires the active local wallet's password.
#[tauri::command]
pub async fn stake_withdraw_unbonded(
    state: tauri::State<'_, crate::app_state::AppState>,
    password: String,
) -> Result<TxOutcome, crate::error::AppError> {
    let (signer, address) = get_signer_and_address(&state, &password).await?;
    let client = get_substrate_client(&state).await?;

    let account_id = address
        .parse::<subxt::utils::AccountId32>()
        .map_err(|_| crate::error::AppError::Validation("Invalid address".into()))?;

    let spans_query = custom_runtime::storage().staking().slashing_spans(&account_id);
    let num_slashing_spans = match client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Storage error: {e}")))?
        .fetch(&spans_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Slashing spans query failed: {e}")))?
    {
        Some(spans) => spans.prior.len() as u32,
        None => 0,
    };

    info!("Submitting withdraw_unbonded transaction (spans={num_slashing_spans})...");
    let tx = custom_runtime::tx().staking().withdraw_unbonded(num_slashing_spans);
    let outcome = sign_submit_track(&client, &tx, &signer).await?;
    info!("Withdraw outcome: {outcome:?}");
    Ok(outcome)
}

/// Claim staking rewards via `payout_stakers` for the previous era.
/// Requires the active local wallet's password.
#[tauri::command]
pub async fn stake_claim_rewards(state: tauri::State<'_, crate::app_state::AppState>, password: String) -> Result<TxOutcome, crate::error::AppError> {
    let (signer, address) = get_signer_and_address(&state, &password).await?;
    let client = get_substrate_client(&state).await?;

    let account_id = address
        .parse::<subxt::utils::AccountId32>()
        .map_err(|_| crate::error::AppError::Validation("Invalid address".into()))?;

    let era_query = custom_runtime::storage().staking().current_era();
    let current_era = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Storage error: {e}")))?
        .fetch(&era_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Era query failed: {e}")))?
        .ok_or(crate::error::AppError::Other("Current era not available".into()))?;

    if current_era == 0 {
        return Err(crate::error::AppError::Other("Cannot claim rewards: era is 0".into()));
    }

    info!("Submitting payout_stakers for era {}...", current_era - 1);
    let tx = custom_runtime::tx().staking().payout_stakers(account_id, current_era - 1);
    let outcome = sign_submit_track(&client, &tx, &signer).await?;
    info!("Payout outcome: {outcome:?}");
    Ok(outcome)
}
