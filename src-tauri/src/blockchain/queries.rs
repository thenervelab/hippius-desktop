//! Balance, staking, and on-chain data queries.

use crate::blockchain::client::get_substrate_client;
use crate::blockchain::convert::planck_to_hip;
use crate::blockchain::helpers::get_substrate_address;
use crate::blockchain::runtime::custom_runtime;
use crate::blockchain::types::{AccountBalance, BlockTimestampResult, ReferralLink, StakingInfo, UnbondingPeriod};

/// Query `system.account(address)` for free/reserved/frozen balance.
#[tauri::command]
pub async fn get_account_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    address: String,
) -> Result<AccountBalance, crate::error::AppError> {
    let client = get_substrate_client(&state).await?;
    let account_id: subxt::utils::AccountId32 = address.parse().map_err(|_| format!("Invalid SS58 address: {address}"))?;
    let storage_query = custom_runtime::storage().system().account(&account_id);
    let account_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?
        .fetch(&storage_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Query failed: {e}")))?;

    let (free, reserved, frozen) = match account_info {
        Some(info) => (info.data.free.to_string(), info.data.reserved.to_string(), info.data.frozen.to_string()),
        None => ("0".to_string(), "0".to_string(), "0".to_string()),
    };
    Ok(AccountBalance {
        free_hip: planck_to_hip(&free),
        reserved_hip: planck_to_hip(&reserved),
        frozen_hip: planck_to_hip(&frozen),
        free,
        reserved,
        frozen,
    })
}

/// Query staking state for the current authenticated user.
#[tauri::command]
pub async fn get_staking_info(state: tauri::State<'_, crate::app_state::AppState>) -> Result<StakingInfo, crate::error::AppError> {
    let address = get_substrate_address(&state)?;
    let client = get_substrate_client(&state).await?;
    let account_id: subxt::utils::AccountId32 = address.parse().map_err(|_| format!("Invalid SS58 address: {address}"))?;

    // Single RPC call — all queries use the same block snapshot
    let storage = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?;

    let balance_query = custom_runtime::storage().system().account(&account_id);
    let balance_info = storage
        .fetch(&balance_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Balance query failed: {e}")))?;
    let free_balance = balance_info.map_or_else(|| "0".to_string(), |info| info.data.free.to_string());

    let mut bonded = "0".to_string();
    let mut unbonding_total: u128 = 0;
    let mut withdrawable_total: u128 = 0;
    let mut unbonding_periods = Vec::new();

    let current_era_query = custom_runtime::storage().staking().current_era();
    let current_era: u32 = storage
        .fetch(&current_era_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Era query failed: {e}")))?
        .unwrap_or(0);

    let ledger_query = custom_runtime::storage().staking().ledger(&account_id);
    // Propagate a ledger RPC failure instead of collapsing it into "no stake":
    // the previous `if let Ok(Some(_))` treated a network/codec error like a
    // genuinely unbonded account and returned zeroed StakingInfo as success, so
    // the FE showed 0 bonded for a real staker. `None` (no ledger = not staking)
    // still legitimately keeps the zeros; only `Err` now surfaces. Mirrors the
    // `?` handling of the balance and current_era fetches above.
    let ledger = storage
        .fetch(&ledger_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Ledger query failed: {e}")))?;
    if let Some(ledger) = ledger {
        bonded = ledger.active.to_string();
        for chunk in &ledger.unlocking.0 {
            let unlock_era = chunk.era;
            let amount = chunk.value;
            let remaining = unlock_era.saturating_sub(current_era);
            if remaining == 0 {
                withdrawable_total += amount;
            } else {
                unbonding_total += amount;
                let amount_str = amount.to_string();
                unbonding_periods.push(UnbondingPeriod {
                    amount_hip: planck_to_hip(&amount_str),
                    amount: amount_str,
                    era: unlock_era,
                    remaining_eras: remaining,
                });
            }
        }
    }

    let rewards = "0".to_string();
    let total: u128 = free_balance.parse().unwrap_or(0);
    let bonded_u128: u128 = bonded.parse().unwrap_or(0);
    let available = total.saturating_sub(bonded_u128).saturating_sub(unbonding_total);

    let unbonding = unbonding_total.to_string();
    let withdrawable = withdrawable_total.to_string();
    let available_balance = available.to_string();

    Ok(StakingInfo {
        bonded_hip: planck_to_hip(&bonded),
        rewards_hip: planck_to_hip(&rewards),
        unbonding_hip: planck_to_hip(&unbonding),
        withdrawable_hip: planck_to_hip(&withdrawable),
        balance_hip: planck_to_hip(&free_balance),
        available_balance_hip: planck_to_hip(&available_balance),
        bonded,
        rewards,
        unbonding,
        withdrawable,
        balance: free_balance,
        available_balance,
        unbonding_periods,
    })
}

/// Query the on-chain timestamp for a given block number.
#[tauri::command]
pub async fn get_block_timestamp(
    state: tauri::State<'_, crate::app_state::AppState>,
    block_number: u64,
) -> Result<BlockTimestampResult, crate::error::AppError> {
    use subxt::backend::legacy::LegacyRpcMethods;

    let client = get_substrate_client(&state).await?;

    // Get the RPC handle through the connect-aware helper so it can't spuriously
    // report "RPC client not initialized" when the rpc_client cache was cleared
    // concurrently while the OnlineClient above stayed cached — both are
    // re-derived together. See client::get_rpc_client.
    let rpc = crate::blockchain::client::get_rpc_client(&state).await?;
    let legacy: LegacyRpcMethods<subxt::PolkadotConfig> = LegacyRpcMethods::new(rpc);

    let block_hash = legacy
        .chain_get_block_hash(Some(block_number.into()))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Block hash query failed: {e}")))?
        .ok_or_else(|| format!("Block {block_number} not found"))?;

    let timestamp_query = custom_runtime::storage().timestamp().now();
    let timestamp: u64 = client
        .storage()
        .at(block_hash)
        .fetch(&timestamp_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Timestamp query failed: {e}")))?
        .unwrap_or(0);

    Ok(BlockTimestampResult { timestamp })
}

/// Fetch referral links (codes + rewards) for the given address.
#[tauri::command]
pub async fn get_referral_links(
    state: tauri::State<'_, crate::app_state::AppState>,
    address: String,
) -> Result<Vec<ReferralLink>, crate::error::AppError> {
    let client = get_substrate_client(&state).await?;
    let target_account: subxt::utils::AccountId32 = address.parse().map_err(|_| "Invalid address".to_string())?;

    let storage = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?;

    let query = custom_runtime::storage().credits().referral_codes_iter();
    let mut entries = storage
        .iter(query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("ReferralCodes query failed: {e}")))?;

    let decimals = 10u128.pow(18);

    // Walk the iterator sequentially (subxt requires &mut self for next).
    // Collect matching codes first, then fan out the per-code reward
    // fetches concurrently with `try_join_all`. Previously each match's
    // reward fetch was awaited inline before pulling the next entry, so
    // a user with K matches paid K serial RPC round-trips on top of the
    // O(N) iteration. Now the K reward fetches run in parallel against
    // the same `at_latest()` snapshot.
    let mut matched_codes: Vec<(Vec<u8>, String)> = Vec::new();
    // Propagate a mid-iteration RPC error rather than ending the loop silently:
    // `while let Some(Ok(entry))` stopped on the first `Some(Err(_))` and
    // returned the codes matched so far as `Ok`, so a dropped subscription
    // produced a partial referral list that looked complete to the FE.
    while let Some(result) = entries.next().await {
        let entry = result.map_err(|e| crate::error::AppError::Other(format!("ReferralCodes iteration failed: {e}")))?;
        if entry.value == target_account {
            let code_bytes = entry.key_bytes[entry.key_bytes.len().saturating_sub(32)..].to_vec();
            let code = String::from_utf8_lossy(code_bytes.iter().copied().skip_while(|b| *b == 0).collect::<Vec<u8>>().as_slice()).to_string();
            matched_codes.push((code_bytes, code));
        }
    }

    let storage_ref = &storage;
    let reward_futures = matched_codes.iter().map(|(code_bytes, _)| {
        let reward_query = custom_runtime::storage().credits().referral_code_rewards(code_bytes.as_slice());
        async move {
            storage_ref
                .fetch(&reward_query)
                .await
                .map(|opt| opt.unwrap_or(0u128))
                .map_err(|e| crate::error::AppError::Other(format!("Reward query failed: {e}")))
        }
    });
    let rewards: Vec<u128> = futures_util::future::try_join_all(reward_futures).await?;

    let links = matched_codes
        .into_iter()
        .zip(rewards)
        .map(|((_, code), reward_raw)| ReferralLink {
            code,
            reward: (reward_raw / decimals).to_string(),
        })
        .collect();

    Ok(links)
}

/// Validate whether a string is a valid SS58 (Substrate) address.
#[tauri::command]
pub fn validate_address(address: String) -> bool {
    address.parse::<subxt::utils::AccountId32>().is_ok()
}
