//! Shared blockchain types used across query, staking, and transfer modules.

use serde::Serialize;

/// On-chain referral code with its accumulated reward.
#[derive(Serialize, Clone)]
pub struct ReferralLink {
    pub code: String,
    pub reward: String,
}

/// Account balance breakdown.
///
/// Every numeric field is returned both as raw planck (full precision,
/// 10^-18 HIP) and as a pre-formatted HIP display string. The planck
/// values stay canonical for calculations and validation; the `*_hip`
/// fields let the frontend render without re-implementing the
/// planck→HIP divide that used to drift between callers and silently
/// lose precision above 2^53.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub free: String,
    pub free_hip: String,
    pub reserved: String,
    pub reserved_hip: String,
    pub frozen: String,
    pub frozen_hip: String,
}

/// A single unbonding chunk with its target era and remaining wait time.
///
/// `remaining_blocks` is the chain-precise block count until the chunk
/// becomes withdrawable — computed from era length × sessions per era
/// minus the current era progress. The frontend multiplies by the 6s
/// block time to render an "Nd Nh" countdown, matching hippius-web.
///
/// `None` when the runtime didn't surface enough data to compute it
/// (older chain spec, pallet rename, RPC hiccup). The frontend falls
/// back to a coarse "~N era(s)" label in that case.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnbondingPeriod {
    pub amount: String,
    pub amount_hip: String,
    pub era: u32,
    pub remaining_eras: u32,
    pub remaining_blocks: Option<u64>,
}

/// Full staking state for the authenticated user.
///
/// See [`AccountBalance`] for the `planck` vs `*_hip` split.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StakingInfo {
    pub bonded: String,
    pub bonded_hip: String,
    pub rewards: String,
    pub rewards_hip: String,
    pub unbonding: String,
    pub unbonding_hip: String,
    pub withdrawable: String,
    pub withdrawable_hip: String,
    pub balance: String,
    pub balance_hip: String,
    pub available_balance: String,
    pub available_balance_hip: String,
    pub unbonding_periods: Vec<UnbondingPeriod>,
}

/// Result of a submitted extrinsic.
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
    pub timestamp: u64,
}

/// Result of a validated balance transfer.
///
/// Mirrors the planck/hip split used elsewhere in this module so the
/// confirm dialog can render the amount and fee without re-doing the
/// planck→HIP divide on the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedTransfer {
    pub planck_amount: String,
    pub planck_amount_hip: String,
    pub estimated_fee: String,
    pub estimated_fee_hip: String,
    pub available_balance_planck: String,
    pub available_balance_hip: String,
}
