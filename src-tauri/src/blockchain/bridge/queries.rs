//! Read-only bridge IPC: fee quote, minimums (pure), plus on-chain balances and
//! staked-hotkey lookups. Replaces the renderer's `calculateBridgeFee` /
//! `calculateReceivedAmount` / minimum constants and `getBalances` /
//! `getStakedHotkeys` so the FE renders figures the backend computes.

use subxt::utils::AccountId32;
use subxt::{OnlineClient, PolkadotConfig};

use crate::blockchain::bridge::runtime::{bittensor, hippius_tn};
use crate::blockchain::bridge::types::{BridgeBalances, FeeEstimate, MinTransfers, StakedHotkey};
use crate::blockchain::bridge::{client, config, convert};
use crate::error::{AppError, Result};

/// `(hotkey_ss58, stake_rao)` the coldkey has on the bridge netuid, via the
/// `StakeInfoRuntimeApi.get_stake_info_for_coldkey` runtime API. Shared by the
/// balances (sum) and the hotkey picker (filter + sort).
async fn netuid_stakes(bt: &OnlineClient<PolkadotConfig>, acct: &AccountId32) -> Result<Vec<(String, u128)>> {
    let stakes = bt
        .runtime_api()
        .at_latest()
        .await
        .map_err(|e| AppError::Substrate(format!("bittensor runtime api: {e}")))?
        .call(bittensor::apis().stake_info_runtime_api().get_stake_info_for_coldkey(acct.clone()))
        .await
        .map_err(|e| AppError::Substrate(format!("get_stake_info_for_coldkey: {e}")))?;
    Ok(stakes
        .into_iter()
        .filter(|s| s.netuid == config::NETUID)
        .map(|s| (s.hotkey.to_string(), u128::from(s.stake)))
        .collect())
}

/// Free balances + staked Alpha for the bridge dialog (rao decimal strings).
///
/// # Errors
/// [`AppError::Validation`] for a bad address; [`AppError::Substrate`] on RPC failure.
#[tauri::command]
pub async fn bridge_get_balances(address: String) -> Result<BridgeBalances> {
    let acct: AccountId32 = address.parse().map_err(|e| AppError::Validation(format!("Invalid address: {e:?}")))?;

    let bt = client::connect_bittensor().await?;
    let alpha_free = bt
        .storage()
        .at_latest()
        .await
        .map_err(|e| AppError::Substrate(format!("bittensor storage: {e}")))?
        .fetch(&bittensor::storage().system().account(&acct))
        .await
        .map_err(|e| AppError::Substrate(format!("bittensor account: {e}")))?
        .map_or(0u128, |info| u128::from(info.data.free));
    let alpha_stake: u128 = netuid_stakes(&bt, &acct).await?.into_iter().map(|(_, s)| s).sum();

    let hp = client::connect_hippius().await?;
    let h_alpha = hp
        .storage()
        .at_latest()
        .await
        .map_err(|e| AppError::Substrate(format!("hippius storage: {e}")))?
        .fetch(&hippius_tn::storage().system().account(&acct))
        .await
        .map_err(|e| AppError::Substrate(format!("hippius account: {e}")))?
        // Hippius balance is already u128 (Bittensor's is u64 — converted above).
        .map_or(0u128, |info| info.data.free);

    Ok(BridgeBalances {
        alpha: alpha_free.to_string(),
        alpha_stake: alpha_stake.to_string(),
        h_alpha: h_alpha.to_string(),
    })
}

/// Hotkeys the coldkey has positive Alpha stake on (bridge netuid), newest-stake
/// first — feeds the deposit validator picker.
///
/// # Errors
/// As [`bridge_get_balances`].
#[tauri::command]
pub async fn bridge_get_staked_hotkeys(address: String) -> Result<Vec<StakedHotkey>> {
    let acct: AccountId32 = address.parse().map_err(|e| AppError::Validation(format!("Invalid address: {e:?}")))?;
    let bt = client::connect_bittensor().await?;
    let mut staked: Vec<(String, u128)> = netuid_stakes(&bt, &acct).await?.into_iter().filter(|(_, s)| *s > 0).collect();
    staked.sort_by_key(|(_, stake)| std::cmp::Reverse(*stake));
    Ok(staked
        .into_iter()
        .map(|(hotkey, stake)| StakedHotkey {
            hotkey,
            stake: stake.to_string(),
        })
        .collect())
}

/// Quote the bridge fee + received amount for `amount` (a smallest-unit "rao"
/// decimal string). Direction doesn't change the fee math (a flat 0.1%), but it
/// is accepted so the FE can keep one call shape and a future asymmetric fee
/// stays a backend-only change.
///
/// # Errors
/// [`AppError::Validation`] if `amount` isn't a non-negative integer rao value.
#[tauri::command]
pub fn bridge_estimate_fees(amount: String, direction: String) -> Result<FeeEstimate> {
    let _ = direction; // reserved; fee is currently flat across directions
    let amount: u128 = amount
        .trim()
        .parse()
        .map_err(|e| AppError::Validation(format!("Invalid bridge amount: {e}")))?;
    Ok(FeeEstimate {
        bridge_fee: convert::bridge_fee(amount).to_string(),
        received_amount: convert::received_after_fee(amount).to_string(),
    })
}

/// The minimum transfer amounts (rao decimal strings) the UI gates input on.
#[must_use]
#[tauri::command]
pub fn bridge_min_transfers() -> MinTransfers {
    MinTransfers {
        alpha: convert::MIN_TRANSFER_ALPHA_RAO.to_string(),
        h_alpha: convert::MIN_TRANSFER_HALPHA_RAO.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_matches_convert_math() {
        let est = bridge_estimate_fees("15000000000".into(), "alpha-to-halpha".into()).unwrap();
        assert_eq!(est.bridge_fee, "15000000");
        assert_eq!(est.received_amount, "14985000000");
        assert!(bridge_estimate_fees("-1".into(), "x".into()).is_err());
    }

    #[test]
    fn minimums_are_the_15_token_constants() {
        let m = bridge_min_transfers();
        assert_eq!(m.alpha, "15000000000");
        assert_eq!(m.h_alpha, "15000000000000000000");
    }
}
