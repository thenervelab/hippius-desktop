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

/// Full staking state for the authenticated user.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StakingInfo {
    pub bonded: String,
    pub rewards: String,
    pub unbonding: String,
    pub withdrawable: String,
    pub balance: String,
    pub available_balance: String,
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedTransfer {
    pub planck_amount: String,
    pub estimated_fee: String,
    pub available_balance_planck: String,
}
