//! Balance, staking, and on-chain data queries.

use crate::blockchain::client::get_substrate_client;
use crate::blockchain::helpers::get_substrate_address;
use crate::blockchain::runtime::custom_runtime;
use crate::blockchain::types::*;

/// Query `system.account(address)` for free/reserved/frozen balance.
#[tauri::command]
pub async fn get_account_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    address: String,
) -> Result<AccountBalance, crate::error::AppError> {
    let client = get_substrate_client(&state).await?;
    let account_id: subxt::utils::AccountId32 =
        address.parse().map_err(|_| format!("Invalid SS58 address: {address}"))?;
    let storage_query = custom_runtime::storage().system().account(&account_id);
    let account_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?
        .fetch(&storage_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Query failed: {e}")))?;

    match account_info {
        Some(info) => Ok(AccountBalance {
            free: info.data.free.to_string(),
            reserved: info.data.reserved.to_string(),
            frozen: info.data.frozen.to_string(),
        }),
        None => Ok(AccountBalance {
            free: "0".to_string(),
            reserved: "0".to_string(),
            frozen: "0".to_string(),
        }),
    }
}

/// Query staking state for the current authenticated user.
#[tauri::command]
pub async fn get_staking_info(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<StakingInfo, crate::error::AppError> {
    let address = get_substrate_address(&state)?;
    let client = get_substrate_client(&state).await?;
    let account_id: subxt::utils::AccountId32 =
        address.parse().map_err(|_| format!("Invalid SS58 address: {address}"))?;

    let balance_query = custom_runtime::storage().system().account(&account_id);
    let balance_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?
        .fetch(&balance_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Balance query failed: {e}")))?;
    let free_balance = balance_info.map_or_else(|| "0".to_string(), |info| info.data.free.to_string());

    let mut bonded = "0".to_string();
    let mut unbonding_total: u128 = 0;
    let mut withdrawable_total: u128 = 0;
    let mut unbonding_periods = Vec::new();

    let current_era_query = custom_runtime::storage().staking().current_era();
    let current_era: u32 = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?
        .fetch(&current_era_query)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Era query failed: {e}")))?
        .unwrap_or(0);

    let ledger_query = custom_runtime::storage().staking().ledger(&account_id);
    if let Ok(Some(ledger)) = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Storage error: {e}")))?
        .fetch(&ledger_query)
        .await
    {
        bonded = ledger.active.to_string();
        for chunk in &ledger.unlocking.0 {
            let unlock_era = chunk.era;
            let amount = chunk.value;
            let remaining = unlock_era.saturating_sub(current_era);
            if remaining == 0 {
                withdrawable_total += amount;
            } else {
                unbonding_total += amount;
                unbonding_periods.push(UnbondingPeriod {
                    amount: amount.to_string(),
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

    Ok(StakingInfo {
        bonded,
        rewards,
        unbonding: unbonding_total.to_string(),
        withdrawable: withdrawable_total.to_string(),
        balance: free_balance,
        available_balance: available.to_string(),
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
    use subxt::backend::rpc::RpcClient;

    let client = get_substrate_client(&state).await?;
    let rpc_url = crate::blockchain::client::get_current_wss_endpoint(state.pool()?)
        .await
        .unwrap_or_else(|_| crate::blockchain::client::WSS_ENDPOINT.to_string());
    let rpc_client = RpcClient::from_url(&rpc_url)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("RPC connect failed: {e}")))?;
    let legacy: LegacyRpcMethods<subxt::PolkadotConfig> = LegacyRpcMethods::new(rpc_client);

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
    let target_account: subxt::utils::AccountId32 =
        address.parse().map_err(|_| "Invalid address".to_string())?;

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
    let mut links = Vec::new();

    while let Some(Ok(entry)) = entries.next().await {
        if entry.value == target_account {
            let code_bytes = &entry.key_bytes[entry.key_bytes.len().saturating_sub(32)..];
            let code = String::from_utf8_lossy(
                code_bytes
                    .iter()
                    .copied()
                    .skip_while(|b| *b == 0)
                    .collect::<Vec<u8>>()
                    .as_slice(),
            )
            .to_string();

            let reward_query =
                custom_runtime::storage().credits().referral_code_rewards(code_bytes);
            let reward_raw = storage
                .fetch(&reward_query)
                .await
                .map_err(|e| crate::error::AppError::Other(format!("Reward query failed: {e}")))?
                .unwrap_or(0u128);

            links.push(ReferralLink {
                code,
                reward: (reward_raw / decimals).to_string(),
            });
        }
    }

    Ok(links)
}

/// Validate whether a string is a valid SS58 (Substrate) address.
#[tauri::command]
pub fn validate_address(address: String) -> bool {
    address.parse::<subxt::utils::AccountId32>().is_ok()
}
