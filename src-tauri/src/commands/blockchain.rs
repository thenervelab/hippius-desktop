//! Blockchain query and transaction commands.
//!
//! Moves all Polkadot RPC queries and staking transaction signing to Rust.
//! Queries read on-chain state via `subxt`. Transactions sign with the
//! keypair stored in `AppState.auth` (populated by login/unlock).
//!
//! This module covers:
//! - **Balance queries** — free/reserved/frozen via `system.account`
//! - **Staking lifecycle** — bond, unbond, withdraw, claim rewards
//! - **Transfers** — `balances.transfer_keep_alive`
//! - **Referral codes** — iterating `credits.referral_codes` storage
//! - **Unit conversion** — planck <-> human-readable (18 decimals)

use crate::substrate_client::get_substrate_client;
use serde::Serialize;
use sp_core::crypto::Ss58Codec;
use subxt::tx::PairSigner;
use tracing::info;

use crate::commands::substrate_tx::custom_runtime;

/// On-chain referral code with its accumulated reward.
#[derive(Serialize, Clone)]
pub struct ReferralLink {
    pub code: String,
    pub reward: String,
}

/// Account balance breakdown returned by [`get_account_balance`].
///
/// All values are in planck (10^-18 HIP) serialized as strings to avoid
/// JavaScript number precision loss at values above 2^53.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub free: String,
    pub reserved: String,
    pub frozen: String,
}

/// A single unbonding chunk with its target era and remaining wait time.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnbondingPeriod {
    pub amount: String,
    pub era: u32,
    pub remaining_eras: u32,
}

/// Full staking state for the authenticated user, combining ledger and balance data.
///
/// The frontend renders this directly in the stake/unstake page without
/// needing additional RPC calls.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StakingInfo {
    /// Active bonded amount in planck.
    pub bonded: String,
    /// Pending staking rewards in planck.
    pub rewards: String,
    /// Total amount currently unbonding.
    pub unbonding: String,
    /// Amount ready to withdraw (unbonding period complete).
    pub withdrawable: String,
    /// Free balance (for "available to stake" display).
    pub balance: String,
    /// Per-era unbonding breakdown.
    pub unbonding_periods: Vec<UnbondingPeriod>,
}

/// Result of a submitted extrinsic, returned to the frontend after finalization.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxResult {
    pub tx_hash: String,
    pub success: bool,
}

/// On-chain timestamp for a specific block number.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockTimestampResult {
    /// Milliseconds since epoch.
    pub timestamp: u64,
}

/// Build a `PairSigner` from the sr25519 keypair in `AppState.auth`.
///
/// Fails if the user is not authenticated (no keypair stored).
fn get_signer(
    app_state: &crate::app_state::AppState,
) -> Result<PairSigner<subxt::PolkadotConfig, sp_core::sr25519::Pair>, String> {
    let auth = app_state
        .auth
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    let pair = auth
        .sr25519_pair
        .clone()
        .ok_or("Not authenticated — please log in first")?;
    Ok(PairSigner::new(pair))
}

/// Read the SS58 address from the in-memory auth state.
fn get_substrate_address(app_state: &crate::app_state::AppState) -> Result<String, String> {
    let auth = app_state
        .auth
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    auth.substrate_address
        .clone()
        .ok_or("Not authenticated — please log in first".to_string())
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// Query `system.account(address)` for free/reserved/frozen balance.
#[tauri::command]
pub async fn get_account_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    address: String,
) -> Result<AccountBalance, String> {
    let client = get_substrate_client(&state).await?;

    let account_id: subxt::utils::AccountId32 = address
        .parse()
        .map_err(|_| format!("Invalid SS58 address: {address}"))?;

    let storage_query = custom_runtime::storage().system().account(&account_id);
    let account_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?
        .fetch(&storage_query)
        .await
        .map_err(|e| format!("Query failed: {e}"))?;

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
///
/// Combines `staking.ledger`, `staking.currentEra`, and `system.account`
/// into a single response to minimize frontend round-trips.
#[tauri::command]
pub async fn get_staking_info(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<StakingInfo, String> {
    let address = get_substrate_address(&state)?;
    let client = get_substrate_client(&state).await?;

    let account_id: subxt::utils::AccountId32 = address
        .parse()
        .map_err(|_| format!("Invalid SS58 address: {address}"))?;

    let balance_query = custom_runtime::storage().system().account(&account_id);
    let balance_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?
        .fetch(&balance_query)
        .await
        .map_err(|e| format!("Balance query failed: {e}"))?;
    let free_balance = balance_info
        .map(|info| info.data.free.to_string())
        .unwrap_or_else(|| "0".to_string());

    let mut bonded = "0".to_string();
    let mut unbonding_total: u128 = 0;
    let mut withdrawable_total: u128 = 0;
    let mut unbonding_periods = Vec::new();

    let current_era_query = custom_runtime::storage().staking().current_era();
    let current_era: u32 = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?
        .fetch(&current_era_query)
        .await
        .map_err(|e| format!("Era query failed: {e}"))?
        .unwrap_or(0);

    let ledger_query = custom_runtime::storage().staking().ledger(&account_id);
    if let Ok(Some(ledger)) = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?
        .fetch(&ledger_query)
        .await
    {
        bonded = ledger.active.to_string();

        for chunk in ledger.unlocking.0.iter() {
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

    // Accurate reward computation requires era-specific exposure data
    // that is complex to query via subxt; the frontend can query the
    // indexer for pending rewards if needed.
    let rewards = "0".to_string();

    Ok(StakingInfo {
        bonded,
        rewards,
        unbonding: unbonding_total.to_string(),
        withdrawable: withdrawable_total.to_string(),
        balance: free_balance,
        unbonding_periods,
    })
}

/// Query the on-chain timestamp for a given block number.
#[tauri::command]
pub async fn get_block_timestamp(
    state: tauri::State<'_, crate::app_state::AppState>,
    block_number: u64,
) -> Result<BlockTimestampResult, String> {
    use subxt::backend::legacy::LegacyRpcMethods;
    use subxt::backend::rpc::RpcClient;

    let client = get_substrate_client(&state).await?;

    let rpc_url = crate::substrate_client::get_current_wss_endpoint(state.pool()?)
        .await
        .unwrap_or_else(|_| crate::constants::substrate::WSS_ENDPOINT.to_string());
    let rpc_client = RpcClient::from_url(&rpc_url)
        .await
        .map_err(|e| format!("RPC connect failed: {e}"))?;
    let legacy: LegacyRpcMethods<subxt::PolkadotConfig> = LegacyRpcMethods::new(rpc_client);

    let block_hash = legacy
        .chain_get_block_hash(Some(block_number.into()))
        .await
        .map_err(|e| format!("Block hash query failed: {e}"))?
        .ok_or_else(|| format!("Block {block_number} not found"))?;

    let timestamp_query = custom_runtime::storage().timestamp().now();
    let timestamp: u64 = client
        .storage()
        .at(block_hash)
        .fetch(&timestamp_query)
        .await
        .map_err(|e| format!("Timestamp query failed: {e}"))?
        .unwrap_or(0);

    Ok(BlockTimestampResult { timestamp })
}

/// Fetch referral links (codes + rewards) for the given address.
///
/// Iterates all on-chain referral codes and filters to those owned by
/// the target account. Rewards are converted from planck to whole units.
#[tauri::command]
pub async fn get_referral_links(
    state: tauri::State<'_, crate::app_state::AppState>,
    address: String,
) -> Result<Vec<ReferralLink>, String> {
    let client = get_substrate_client(&state).await?;
    let target_account: subxt::utils::AccountId32 =
        address.parse().map_err(|_| "Invalid address".to_string())?;

    let storage = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?;

    let query = custom_runtime::storage().credits().referral_codes_iter();
    let mut entries = storage
        .iter(query)
        .await
        .map_err(|e| format!("ReferralCodes query failed: {e}"))?;

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

            let reward_query = custom_runtime::storage()
                .credits()
                .referral_code_rewards(code_bytes);
            let reward_raw = storage
                .fetch(&reward_query)
                .await
                .map_err(|e| format!("Reward query failed: {e}"))?
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

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/// Bond tokens for staking. If already bonded, calls `bond_extra` instead.
///
/// Rewards are auto-staked (`RewardDestination::Staked`) for initial bonds.
#[tauri::command]
pub async fn stake_bond(
    state: tauri::State<'_, crate::app_state::AppState>,
    amount: String,
) -> Result<TxResult, String> {
    let signer = get_signer(&state)?;
    let client = get_substrate_client(&state).await?;
    let address = get_substrate_address(&state)?;

    let amount: u128 = amount.parse().map_err(|e| format!("Invalid amount: {e}"))?;

    let account_id: subxt::utils::AccountId32 =
        address.parse().map_err(|_| "Invalid address".to_string())?;

    let ledger_query = custom_runtime::storage().staking().ledger(&account_id);
    let already_bonded = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?
        .fetch(&ledger_query)
        .await
        .map_err(|e| format!("Ledger query failed: {e}"))?
        .is_some();

    let tx_hash = if already_bonded {
        info!("Submitting bond_extra transaction...");
        let tx = custom_runtime::tx().staking().bond_extra(amount);
        client
            .tx()
            .sign_and_submit_then_watch_default(&tx, &signer)
            .await
            .map_err(|e| format!("Submit failed: {e}"))?
            .wait_for_finalized_success()
            .await
            .map_err(|e| format!("Transaction failed: {e}"))?
            .extrinsic_hash()
    } else {
        info!("Submitting bond transaction...");
        let tx = custom_runtime::tx().staking().bond(
            amount,
            custom_runtime::runtime_types::pallet_staking::RewardDestination::Staked,
        );
        client
            .tx()
            .sign_and_submit_then_watch_default(&tx, &signer)
            .await
            .map_err(|e| format!("Submit failed: {e}"))?
            .wait_for_finalized_success()
            .await
            .map_err(|e| format!("Transaction failed: {e}"))?
            .extrinsic_hash()
    };

    info!("Bond tx finalized: {:?}", tx_hash);
    Ok(TxResult {
        tx_hash: format!("{tx_hash:?}"),
        success: true,
    })
}

/// Unbond tokens (schedule for withdrawal after the unbonding period).
#[tauri::command]
pub async fn stake_unbond(
    state: tauri::State<'_, crate::app_state::AppState>,
    amount: String,
) -> Result<TxResult, String> {
    let signer = get_signer(&state)?;
    let client = get_substrate_client(&state).await?;

    let amount: u128 = amount.parse().map_err(|e| format!("Invalid amount: {e}"))?;

    info!("Submitting unbond transaction...");
    let tx = custom_runtime::tx().staking().unbond(amount);
    let tx_hash = client
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Submit failed: {e}"))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {e}"))?
        .extrinsic_hash();

    info!("Unbond tx finalized: {:?}", tx_hash);
    Ok(TxResult {
        tx_hash: format!("{tx_hash:?}"),
        success: true,
    })
}

/// Withdraw unbonded tokens (after the unbonding period completes).
///
/// Automatically queries slashing spans to pass the correct parameter.
#[tauri::command]
pub async fn stake_withdraw_unbonded(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<TxResult, String> {
    let signer = get_signer(&state)?;
    let client = get_substrate_client(&state).await?;
    let address = get_substrate_address(&state)?;

    let account_id: subxt::utils::AccountId32 =
        address.parse().map_err(|_| "Invalid address".to_string())?;

    let spans_query = custom_runtime::storage()
        .staking()
        .slashing_spans(&account_id);
    let num_slashing_spans = match client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?
        .fetch(&spans_query)
        .await
        .map_err(|e| format!("Slashing spans query failed: {e}"))?
    {
        Some(spans) => spans.prior.len() as u32,
        None => 0,
    };

    info!("Submitting withdraw_unbonded transaction (spans={num_slashing_spans})...");
    let tx = custom_runtime::tx()
        .staking()
        .withdraw_unbonded(num_slashing_spans);
    let tx_hash = client
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Submit failed: {e}"))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {e}"))?
        .extrinsic_hash();

    info!("Withdraw tx finalized: {:?}", tx_hash);
    Ok(TxResult {
        tx_hash: format!("{tx_hash:?}"),
        success: true,
    })
}

/// Claim staking rewards via `payout_stakers` for the previous era.
#[tauri::command]
pub async fn stake_claim_rewards(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<TxResult, String> {
    let signer = get_signer(&state)?;
    let client = get_substrate_client(&state).await?;
    let address = get_substrate_address(&state)?;

    let account_id: subxt::utils::AccountId32 =
        address.parse().map_err(|_| "Invalid address".to_string())?;

    let era_query = custom_runtime::storage().staking().current_era();
    let current_era = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| format!("Storage error: {e}"))?
        .fetch(&era_query)
        .await
        .map_err(|e| format!("Era query failed: {e}"))?
        .ok_or("Current era not available")?;

    if current_era == 0 {
        return Err("Cannot claim rewards: era is 0".to_string());
    }

    info!("Submitting payout_stakers for era {}...", current_era - 1);
    let tx = custom_runtime::tx()
        .staking()
        .payout_stakers(account_id, current_era - 1);
    let tx_hash = client
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Submit failed: {e}"))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {e}"))?
        .extrinsic_hash();

    info!("Payout tx finalized: {:?}", tx_hash);
    Ok(TxResult {
        tx_hash: format!("{tx_hash:?}"),
        success: true,
    })
}

/// Transfer balance using the keypair from `AppState.auth`.
///
/// Uses `transfer_keep_alive` to prevent the sender's account from being reaped.
#[tauri::command]
pub async fn transfer_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    recipient_address: String,
    amount: String,
) -> Result<TxResult, String> {
    let signer = get_signer(&state)?;
    let client = get_substrate_client(&state).await?;

    let amount: u128 = amount.parse().map_err(|e| format!("Invalid amount: {e}"))?;

    let recipient = <sp_core::crypto::AccountId32 as Ss58Codec>::from_ss58check(&recipient_address)
        .map_err(|e| format!("Invalid recipient address: {e:?}"))?;

    info!("Submitting transfer_keep_alive transaction...");
    let tx = custom_runtime::tx()
        .balances()
        .transfer_keep_alive(recipient.into(), amount);

    let tx_hash = client
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Submit failed: {e}"))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {e}"))?
        .extrinsic_hash();

    info!("Transfer tx finalized: {:?}", tx_hash);
    Ok(TxResult {
        tx_hash: format!("{tx_hash:?}"),
        success: true,
    })
}

// ---------------------------------------------------------------------------
// Unit conversion & explorer URL
// ---------------------------------------------------------------------------

const DECIMALS: u32 = 18;
const EXPLORER_BASE: &str = "https://hipstats.com";

/// Convert a human-readable amount (e.g. "1.5") to planck string (18 decimals).
#[tauri::command]
pub fn to_plancks(amount: String) -> Result<String, String> {
    if amount.is_empty() {
        return Err("Invalid amount".to_string());
    }
    amount
        .parse::<f64>()
        .map_err(|_| "Invalid amount".to_string())?;

    let (whole, fraction) = match amount.split_once('.') {
        Some((w, f)) => (w, f),
        None => (amount.as_str(), ""),
    };

    let fraction_padded = if fraction.len() >= DECIMALS as usize {
        &fraction[..DECIMALS as usize]
    } else {
        &format!("{:0<width$}", fraction, width = DECIMALS as usize)
    };

    let combined = format!("{}{}", whole, fraction_padded);
    let trimmed = combined.trim_start_matches('0');
    if trimmed.is_empty() {
        Ok("0".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

/// Convert a planck string to human-readable f64 (divide by 10^18).
#[tauri::command]
pub fn from_plancks(plancks: String) -> Result<f64, String> {
    let value: f64 = plancks
        .parse()
        .map_err(|_| "Invalid planck value".to_string())?;
    Ok(value / 1e18)
}

/// Return the explorer URL for an address.
#[tauri::command]
pub fn get_explorer_url(address: String) -> String {
    format!("{}/accounts/{}", EXPLORER_BASE, address)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_plancks_integer() {
        assert_eq!(to_plancks("1".into()).unwrap(), "1000000000000000000");
    }

    #[test]
    fn to_plancks_decimal() {
        assert_eq!(to_plancks("1.5".into()).unwrap(), "1500000000000000000");
    }

    #[test]
    fn to_plancks_zero() {
        assert_eq!(to_plancks("0".into()).unwrap(), "0");
    }

    #[test]
    fn to_plancks_small_fraction() {
        assert_eq!(to_plancks("0.000000000000000001".into()).unwrap(), "1");
    }

    #[test]
    fn to_plancks_many_decimals_truncates() {
        assert_eq!(
            to_plancks("0.1234567890123456789999".into()).unwrap(),
            "123456789012345678"
        );
    }

    #[test]
    fn to_plancks_invalid() {
        assert!(to_plancks("abc".into()).is_err());
        assert!(to_plancks("".into()).is_err());
    }

    #[test]
    fn from_plancks_basic() {
        let result = from_plancks("1000000000000000000".into()).unwrap();
        assert!((result - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn from_plancks_zero() {
        let result = from_plancks("0".into()).unwrap();
        assert!((result - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn from_plancks_invalid() {
        assert!(from_plancks("not_a_number".into()).is_err());
    }

    #[test]
    fn explorer_url() {
        let url = get_explorer_url("5GrwvaEF".into());
        assert_eq!(url, "https://hipstats.com/accounts/5GrwvaEF");
    }
}
