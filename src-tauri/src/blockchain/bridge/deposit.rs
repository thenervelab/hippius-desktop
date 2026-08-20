//! Alpha → hAlpha bridge: the 4-step ink! deposit flow on Bittensor.
//!
//! 1. `Proxy.add_proxy(contract, Any)` so the bridge contract can stake for the
//!    caller (idempotent — a Duplicate is fine).
//! 2. Dry-run `deposit(amount, hotkey)` via the `ContractsApi.call` runtime API
//!    to get gas + storage deposit and surface a revert reason before paying.
//! 3. Submit `Contracts.call` with doubled gas + the dry-run storage deposit.
//! 4. `Proxy.remove_proxy(contract, Any)` to revoke the escrow grant.
//!
//! Construction + signing live here so the wallet never blind-signs renderer
//! bytes (audit H-8). Mirrors the proven flow in `app/lib/bridge/service.ts`
//! and `thebrain/contracts/bridge/integration-tests`.
//!
//! ⚠️⚠️ FUNDS-CRITICAL, compile-verified only. The dry-run gas/storage handling
//! and the contract submit MUST be smoke-tested against a funded
//! Bittensor-testnet wallet + live node before release (see DEPOSIT_PORT_NOTES.md).

use subxt::blocks::ExtrinsicEvents;
use subxt::ext::codec::{Decode, Encode};
use subxt::utils::{AccountId32, MultiAddress};
use subxt::{OnlineClient, PolkadotConfig};

use super::runtime::bittensor;
use super::runtime::bittensor::runtime_types::{
    pallet_contracts::primitives::StorageDeposit, sp_weights::weight_v2::Weight, subtensor_runtime_common::ProxyType,
};
use super::{client, config, contract, convert, types::BridgeOutcome};
use crate::blockchain::helpers::{TrackedSubmission, get_signer_and_address, submit_tracked};
use crate::blockchain::types::TxOutcome;
use crate::error::{AppError, Result};

/// Double a dry-run gas estimate (TS `doubleGas`) for headroom.
fn double_weight(w: &Weight) -> Weight {
    Weight {
        ref_time: w.ref_time.saturating_mul(2),
        proof_size: w.proof_size.saturating_mul(2),
    }
}

/// The storage-deposit limit to pass to the real call: the dry-run's charge (a
/// `Refund` means no charge → no limit needed). Mirrors TS `clampStorageDeposit`.
/// The chain's balance type is `u64`.
fn storage_limit(sd: &StorageDeposit<u64>) -> Option<u64> {
    match sd {
        StorageDeposit::Charge(c) => Some(*c),
        StorageDeposit::Refund(_) => None,
    }
}

/// ink! `deposit` call data: selector ++ SCALE(amount, hotkey).
fn deposit_input(amount: u128, hotkey: &AccountId32) -> Vec<u8> {
    let mut data = config::DEPOSIT_SELECTOR.to_vec();
    amount.encode_to(&mut data);
    hotkey.encode_to(&mut data);
    data
}

/// Submit an Alpha→hAlpha deposit for `amount` (9-dec rao decimal string),
/// staking to `hotkey` (defaults to the configured validator), signed by the
/// active local wallet.
///
/// # Errors
/// [`AppError::Validation`] for bad input; signing errors via
/// [`get_signer_and_address`]; [`AppError::Substrate`] on dry-run/submit
/// failure (with the decoded contract-revert reason when the dry-run reverts).
#[tauri::command]
pub async fn bridge_alpha_to_halpha(
    state: tauri::State<'_, crate::app_state::AppState>,
    amount: String,
    hotkey: Option<String>,
    password: String,
) -> Result<BridgeOutcome> {
    let amount: u128 = amount.trim().parse().map_err(|e| AppError::Validation(format!("Invalid amount: {e}")))?;
    if amount < convert::MIN_TRANSFER_ALPHA_RAO {
        return Err(AppError::Validation("Amount is below the minimum bridge transfer".into()));
    }

    let hotkey: AccountId32 = hotkey
        .as_deref()
        .unwrap_or(config::DEFAULT_VALIDATOR_HOTKEY)
        .parse()
        .map_err(|e| AppError::Validation(format!("Invalid hotkey address: {e:?}")))?;
    let contract_addr: AccountId32 = config::BRIDGE_CONTRACT_ADDRESS
        .parse()
        .map_err(|e| AppError::Validation(format!("Invalid bridge contract address: {e:?}")))?;

    let (signer, origin_ss58) = get_signer_and_address(&state, &password).await?;
    let origin: AccountId32 = origin_ss58
        .parse()
        .map_err(|e| AppError::Validation(format!("Invalid signer address: {e:?}")))?;
    let client = client::connect_bittensor().await?;

    // Step 1: add_proxy (idempotent — ignore a Duplicate).
    let add = bittensor::tx()
        .proxy()
        .add_proxy(MultiAddress::Id(contract_addr.clone()), ProxyType::Any, 0);
    if let Err(e) = client.tx().sign_and_submit_then_watch_default(&add, &signer).await {
        let msg = e.to_string();
        if !msg.contains("Duplicate") {
            return Err(AppError::Substrate(format!("add_proxy failed: {msg}")));
        }
    }

    let input = deposit_input(amount, &hotkey);

    // Step 2: dry-run via the ContractsApi runtime API.
    let dry = bittensor::apis()
        .contracts_api()
        .call(origin.clone(), contract_addr.clone(), 0, None, None, input.clone());
    let result = client
        .runtime_api()
        .at_latest()
        .await
        .map_err(|e| AppError::Substrate(format!("runtime api: {e}")))?
        .call(dry)
        .await
        .map_err(|e| AppError::Substrate(format!("deposit dry-run failed: {e}")))?;

    // A revert is `Ok(ExecReturnValue { flags has REVERT bit, data })`; a
    // module-level failure is `Err(_)`. Only decode the contract error on revert
    // (a success payload is Ok(Ok(id)) and must NOT be run through the error
    // decoder). REVERT is bit 0 of the ReturnFlags bitset.
    match &result.result {
        Ok(exec) => {
            if exec.flags.bits & 0x0000_0001 != 0 {
                let reason = contract::describe_contract_error(&exec.data).unwrap_or_else(|| "deposit reverted".into());
                return Err(AppError::Substrate(format!("Deposit would revert: {reason}")));
            }
        }
        Err(dispatch_error) => {
            return Err(AppError::Substrate(format!("Deposit dry-run failed: {dispatch_error:?}")));
        }
    }

    let gas_limit = double_weight(&result.gas_required);
    // `Contracts.call` takes the storage-deposit limit as a Compact-encoded balance.
    let storage_deposit_limit = storage_limit(&result.storage_deposit).map(subxt::ext::codec::Compact);

    // Step 3: submit the real contract call. Tracked (mortal era + typed
    // outcome) because this is the funds-moving step: an ambiguous post-broadcast
    // result MUST surface as `SubmittedUnconfirmed` (FE suppresses "Try Again")
    // rather than a generic error the user could resubmit into a double deposit
    // (audit R-01/R-12). Steps 1/4 (add/remove proxy) are idempotent /
    // best-effort and stay on the simple path.
    let call = bittensor::tx()
        .contracts()
        .call(MultiAddress::Id(contract_addr.clone()), 0, gas_limit, storage_deposit_limit, input);
    let outcome = match submit_tracked(&client, &call, &signer).await? {
        TrackedSubmission::Finalized { tx_hash, events } => {
            // Step 4: best-effort revoke the proxy grant (deposit confirmed).
            let remove = bittensor::tx()
                .proxy()
                .remove_proxy(MultiAddress::Id(contract_addr.clone()), ProxyType::Any, 0);
            if let Err(e) = client.tx().sign_and_submit_then_watch_default(&remove, &signer).await {
                tracing::warn!(error = %e, "remove_proxy after deposit failed (deposit already succeeded)");
            }

            // Recover the Bittensor-side deposit_request_id for tracking (best-effort).
            let deposit_id = extract_deposit_id(&client, &contract_addr, origin, &events).await;

            // Record locally for the history view (best-effort) — only a
            // confirmed (finalized) deposit is recorded.
            super::history::record_submitted(
                &state,
                "alpha-to-halpha",
                amount,
                &origin_ss58,
                Some(&origin_ss58),
                &tx_hash,
                deposit_id.as_deref(),
            )
            .await;
            BridgeOutcome {
                withdrawal_id: None,
                deposit_id,
                outcome: TxOutcome::Finalized { tx_hash },
            }
        }
        // Non-finalized: the deposit either never landed or its outcome is
        // unproven, so no id and no history record. We deliberately do NOT
        // auto-remove the proxy here — unchanged from the prior error path,
        // which `?`-returned before step 4. Revoking the standing proxy grant on
        // an ambiguous deposit is a tracked testnet follow-up.
        other => BridgeOutcome::status_only(other.into_tx_outcome()),
    };

    Ok(outcome)
}

/// Recover the deposit_request_id for the just-submitted deposit.
///
/// The `deposit_request_id` is an `#[ink(topic)]` on `DepositRequestCreated`
/// (hashed into the event topics, not the data), so it can't be read straight
/// out of the event. Instead we decode the event's first non-topic field —
/// `deposit_nonce` — and ask the contract to map it back via the
/// `get_deposit_request_id_by_nonce` read. Returns `None` on any failure (the
/// id is a tracking handle; its absence never affects the successful deposit).
///
/// ⚠️ The event-data decode assumes ink! v5 lays the non-topic fields
/// (`deposit_nonce`, `amount`) into `data` with no leading discriminant — verify
/// against a live deposit on testnet.
async fn extract_deposit_id(
    client: &OnlineClient<PolkadotConfig>,
    contract: &AccountId32,
    origin: AccountId32,
    events: &ExtrinsicEvents<PolkadotConfig>,
) -> Option<String> {
    let emitted = events
        .find::<bittensor::contracts::events::ContractEmitted>()
        .filter_map(std::result::Result::ok)
        .find(|e| e.contract == *contract)?;
    let mut data = emitted.data.as_slice();
    let nonce = u64::decode(&mut data).ok()?;
    let id: Option<[u8; 32]> = contract::query_contract(client, contract, origin, config::GET_DEPOSIT_REQUEST_ID_BY_NONCE_SELECTOR, nonce.encode())
        .await
        .ok()?;
    id.map(|h| format!("0x{}", hex::encode(h)))
}
