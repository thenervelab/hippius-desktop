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
use crate::blockchain::helpers::{TrackedSubmission, get_signer_and_address, submit_tracked};
use crate::blockchain::types::TxOutcome;
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
    let amount: u128 = amount.trim().parse().map_err(|e| AppError::Validation(format!("Invalid amount: {e}")))?;
    if amount < convert::MIN_TRANSFER_HALPHA_RAO {
        return Err(AppError::Validation("Amount is below the minimum bridge transfer".into()));
    }

    let (signer, address) = get_signer_and_address(&state, &password).await?;
    let client = client::connect_hippius().await?;

    let tx = hippius_tn::tx().alpha_bridge().withdraw(amount);
    // Route through the tracked submitter (mortal era + typed outcome) instead
    // of the fused Immortal `sign_and_submit_then_watch_default`: a withdraw
    // burns hAlpha, so an ambiguous post-broadcast result MUST surface as
    // `SubmittedUnconfirmed` (the FE then suppresses "Try Again") rather than a
    // generic error the user could resubmit into a double-burn (audit R-01/R-12).
    let outcome = match submit_tracked(&client, &tx, &signer).await? {
        TrackedSubmission::Finalized { tx_hash, events } => {
            // Extract the withdrawal request id from WithdrawalRequestCreated.
            let withdrawal_id = events
                .find_first::<hippius_tn::alpha_bridge::events::WithdrawalRequestCreated>()
                .ok()
                .flatten()
                .map(|ev| format!("0x{}", hex::encode(ev.id.0)));
            // Record locally for the history view (best-effort) — only a
            // confirmed (finalized) submission is recorded.
            super::history::record_submitted(
                &state,
                "halpha-to-alpha",
                amount,
                &address,
                recipient.as_deref(),
                &tx_hash,
                withdrawal_id.as_deref(),
            )
            .await;
            BridgeOutcome {
                withdrawal_id,
                deposit_id: None,
                outcome: TxOutcome::Finalized { tx_hash },
            }
        }
        // Every non-finalized state carries no ids and is NOT recorded — the
        // submission either never landed or its outcome is unproven.
        other => BridgeOutcome::status_only(other.into_tx_outcome()),
    };

    Ok(outcome)
}
