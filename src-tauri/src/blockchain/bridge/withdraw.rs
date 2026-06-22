//! hAlpha → Alpha bridge: `AlphaBridge.withdraw` on the Hippius testnet.
//!
//! The simpler write direction — one extrinsic that burns hAlpha and emits
//! `WithdrawalRequestCreated`; the guardians mint Alpha back to the sender on
//! Bittensor. Construction + signing + submission live here so the wallet never
//! blind-signs renderer-built bytes (audit H-8).
//!
//! ⚠️ FUNDS-CRITICAL and compile-verified only — the on-chain submit path
//! REQUIRES a funded Hippius-testnet wallet to smoke-test before release.

use super::runtime::hippius_tn;
use super::{client, convert, types::BridgeOutcome};
use crate::blockchain::helpers::get_signer_and_address;
use crate::error::{AppError, Result};

/// Submit an hAlpha→Alpha withdrawal for `amount` (18-dec rao decimal string),
/// signed by the active local wallet.
///
/// `recipient` is accepted for API symmetry but the `withdraw` call carries only
/// the amount — the chain credits the burning account's own Bittensor address
/// (matching the TS, which passes `{ amount }`).
///
/// # Errors
/// [`AppError::Validation`] for a bad/under-minimum amount; signing errors via
/// [`get_signer_and_address`]; [`AppError::Substrate`] on submit/finalization.
#[tauri::command]
pub async fn bridge_halpha_to_alpha(
    state: tauri::State<'_, crate::app_state::AppState>,
    amount: String,
    recipient: Option<String>,
    password: String,
) -> Result<BridgeOutcome> {
    // `recipient` is not part of the on-chain `withdraw` call (the chain credits
    // the burning account) — it is only retained for the local history record.
    let amount: u128 = amount
        .trim()
        .parse()
        .map_err(|e| AppError::Validation(format!("Invalid amount: {e}")))?;
    if amount < convert::MIN_TRANSFER_HALPHA_RAO {
        return Err(AppError::Validation("Amount is below the minimum bridge transfer".into()));
    }

    let (signer, address) = get_signer_and_address(&state, &password).await?;
    let client = client::connect_hippius().await?;

    let tx = hippius_tn::tx().alpha_bridge().withdraw(amount);
    let events = client
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| AppError::Substrate(format!("Withdraw submit failed: {e}")))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| AppError::Substrate(format!("Withdraw transaction failed: {e}")))?;

    let tx_hash = format!("{:?}", events.extrinsic_hash());

    // Extract the withdrawal request id from WithdrawalRequestCreated.
    let withdrawal_id = events
        .find_first::<hippius_tn::alpha_bridge::events::WithdrawalRequestCreated>()
        .ok()
        .flatten()
        .map(|ev| format!("0x{}", hex::encode(ev.id.0)));

    // Record locally for the history view (best-effort).
    super::history::record_submitted(&state, "halpha-to-alpha", amount, &address, recipient.as_deref(), &tx_hash, withdrawal_id.as_deref()).await;

    Ok(BridgeOutcome {
        tx_hash,
        withdrawal_id,
        deposit_id: None,
        success: true,
    })
}
