//! Wire types returned to the frontend by the bridge IPC commands.

use crate::blockchain::types::TxOutcome;
use serde::Serialize;

/// Outcome of a bridge submission. `deposit_id`/`withdrawal_id` are the bridge
/// request ids extracted from the chain events (hex of the 32-byte id); they are
/// present only on a `finalized` outcome (the others never observed a confirmed
/// event).
///
/// The submission result is the **flattened [`TxOutcome`]** (its `status`,
/// `txHash` and `reason` fields) — the SAME wire shape transfers/staking return —
/// so the FE runs it through `resolveTxOutcome`, which THROWS (and the dialog
/// suppresses "Try Again") on a `submittedUnconfirmed` outcome. That is what
/// closes the bridge double-spend (R-01): a withdraw/deposit whose extrinsic
/// landed but whose finalization watch dropped is reported `submittedUnconfirmed`,
/// not a generic error the dialog offers to resubmit. There is no `Default` or
/// `Clone`: `TxOutcome` has no meaningful default and is built fresh per submission.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOutcome {
    /// `AlphaBridge.WithdrawalRequestCreated.id`, set on a finalized hAlpha→Alpha.
    pub withdrawal_id: Option<String>,
    /// Contract `DepositRequestCreated.deposit_request_id`, set on a finalized Alpha→hAlpha.
    pub deposit_id: Option<String>,
    /// Submission status/txHash/reason, flattened into this object so the FE can
    /// reuse `resolveTxOutcome` (`{ status, txHash, reason, withdrawalId, depositId }`).
    #[serde(flatten)]
    pub outcome: TxOutcome,
}

impl BridgeOutcome {
    /// A submission outcome with no bridge ids — every non-finalized state
    /// (rejected / submitted-unconfirmed / finalized-failed), where no confirmed
    /// `DepositRequestCreated` / `WithdrawalRequestCreated` event was observed.
    pub(crate) fn status_only(outcome: TxOutcome) -> Self {
        Self { withdrawal_id: None, deposit_id: None, outcome }
    }
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

/// Bittensor-contract-side view of a deposit (from `get_deposit_request`), when
/// the cross-ref read succeeds. Enriches the Hippius-side `DepositView`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositBittensorSide {
    pub status: String,
    pub created_at_block: String,
    pub amount_display: String,
    pub nonce: String,
}

/// Bittensor-contract-side view of a withdrawal (from `get_withdrawal`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawalBittensorSide {
    pub status: String,
    pub created_at_block: String,
    pub amount_display: String,
    pub vote_count: u32,
    pub finalized_at_block: Option<String>,
}

/// One deposit (Alpha→hAlpha) as read from `AlphaBridge.Deposits`. `status` is
/// the raw chain status; `unified_status` is the display status from `status.rs`.
/// `bittensor_side` is the best-effort contract cross-ref (`None` if unavailable).
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
    pub bittensor_side: Option<DepositBittensorSide>,
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
    pub bittensor_side: Option<WithdrawalBittensorSide>,
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
