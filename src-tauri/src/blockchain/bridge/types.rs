//! Wire types returned to the frontend by the bridge IPC commands.

use serde::Serialize;

/// Outcome of a bridge submission. `deposit_id`/`withdrawal_id` are the bridge
/// request ids extracted from the chain events (hex of the 32-byte id), used by
/// the UI to track the cross-chain transfer.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOutcome {
    /// Hex extrinsic hash of the submitted transaction.
    pub tx_hash: String,
    /// `AlphaBridge.WithdrawalRequestCreated.id`, set on hAlpha→Alpha.
    pub withdrawal_id: Option<String>,
    /// Contract `DepositRequestCreated.deposit_request_id`, set on Alpha→hAlpha.
    pub deposit_id: Option<String>,
    pub success: bool,
}

/// Balances shown in the bridge dialog, as smallest-unit ("rao") decimal
/// strings so no BigInt crosses the IPC boundary.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeBalances {
    /// Free Alpha on the Bittensor side (9-dec rao).
    pub alpha: String,
    /// Alpha currently staked to the validator hotkey (9-dec rao).
    pub alpha_stake: String,
    /// Free hAlpha on the Hippius side (18-dec rao).
    pub h_alpha: String,
}

/// A hotkey the coldkey has Alpha staked to (on the bridge netuid), for the
/// deposit dialog's validator picker. `stake` is 9-dec Alpha rao as a string.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StakedHotkey {
    pub hotkey: String,
    pub stake: String,
}

/// Fee/received breakdown for a quoted amount — all 9-dec or 18-dec rao decimal
/// strings depending on the direction.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeEstimate {
    pub bridge_fee: String,
    pub received_amount: String,
}

/// Minimum transfer amounts (rao decimal strings) the UI gates input against.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinTransfers {
    pub alpha: String,
    pub h_alpha: String,
}

/// One deposit (Alpha→hAlpha) as read from `AlphaBridge.Deposits`. `status` is
/// the raw chain status; `unified_status` is the display status from `status.rs`.
/// `bittensorSide` enrichment (contract cross-ref) is a follow-up — omitted for now.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositView {
    pub request_id: String,
    pub recipient: String,
    pub amount: String,
    pub amount_display: String,
    pub votes: Vec<String>,
    pub vote_count: u32,
    pub status: String,
    pub unified_status: String,
    pub created_at_block: String,
    pub finalized_at_block: Option<String>,
}

/// One withdrawal (hAlpha→Alpha) as read from `AlphaBridge.WithdrawalRequests`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawalView {
    pub request_id: String,
    pub sender: String,
    pub recipient: String,
    pub amount: String,
    pub amount_display: String,
    pub status: String,
    pub unified_status: String,
    pub created_at_block: String,
}

/// Bridge-wide stats for the explorer header.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStats {
    pub total_deposits: u32,
    pub total_withdrawals: u32,
    pub pending_deposits: u32,
    pub pending_withdrawals: u32,
    pub hippius_height: u64,
    pub bittensor_height: u64,
    pub approve_threshold: u16,
    pub cleanup_ttl_blocks: String,
    pub guardians: Vec<String>,
}

/// Aggregate on-chain explorer snapshot returned to the FE history table.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOnChainData {
    pub deposits: Vec<DepositView>,
    pub withdrawals: Vec<WithdrawalView>,
    pub stats: BridgeStats,
}
