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

/// Outcome of a submitted extrinsic.
///
/// Distinguishes the four operationally-different end states so the frontend
/// never blindly re-submits a transaction that may already be on-chain
/// (audit findings R-01 / R-15). The submit step and the finalization watch
/// are separate awaits: submission can succeed and the extrinsic land on-chain
/// while the watch later errors (RPC/websocket drop, timeout). Collapsing that
/// into a bare `Err` led the FE to offer an unconditional "Try Again" that
/// re-signed a fresh, valid extrinsic — a double-spend.
///
/// Retry-safety per variant:
/// - `Finalized` — succeeded; nothing to retry.
/// - `FinalizedFailed` — landed but the dispatch failed; the nonce was
///   consumed, so the call definitively did not take effect. Safe to retry as
///   a NEW transaction; `reason` is the on-chain error.
/// - `SubmittedUnconfirmed` — the outcome cannot be proven. Covers three
///   distinct situations behind one wire status (deliberate variant reuse, so
///   the FE contract stays frozen): the broadcast RPC errored after the node
///   may have received the bytes; the watch was lost before finalization; or
///   the extrinsic IS finalized but its dispatch result could not be fetched/
///   decoded. It MAY be on-chain and MAY have succeeded — the FE must surface
///   "pending, do not resend", NOT a retry.
/// - `RejectedAtSubmission` — the submission was rejected; the extrinsic never
///   entered the pool. Safe to retry.
///
/// Serializes as an internally-tagged object, e.g.
/// `{ "status": "submittedUnconfirmed", "txHash": "0x…", "reason": "…" }`.
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TxOutcome {
    Finalized { tx_hash: String },
    FinalizedFailed { tx_hash: String, reason: String },
    SubmittedUnconfirmed { tx_hash: String, reason: String },
    RejectedAtSubmission { reason: String },
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

#[cfg(test)]
mod tests {
    use super::TxOutcome;

    /// Wire-contract pin for `app/lib/utils/txOutcome.ts`.
    ///
    /// The FE switches on the exact `status` strings and reads the camelCase
    /// fields below; its safety property — "Submitted/unknown outcomes never
    /// offer a retry" — depends on this serialization never drifting. A serde
    /// attribute change or variant rename must fail HERE, not silently fall
    /// into the FE's unknown-status arm.
    #[test]
    fn tx_outcome_wire_shape_is_pinned() {
        let cases = [
            (
                TxOutcome::Finalized { tx_hash: "0xabc".into() },
                serde_json::json!({"status": "finalized", "txHash": "0xabc"}),
            ),
            (
                TxOutcome::FinalizedFailed {
                    tx_hash: "0xabc".into(),
                    reason: "r".into(),
                },
                serde_json::json!({"status": "finalizedFailed", "txHash": "0xabc", "reason": "r"}),
            ),
            (
                TxOutcome::SubmittedUnconfirmed {
                    tx_hash: "0xabc".into(),
                    reason: "r".into(),
                },
                serde_json::json!({"status": "submittedUnconfirmed", "txHash": "0xabc", "reason": "r"}),
            ),
            (
                TxOutcome::RejectedAtSubmission { reason: "r".into() },
                serde_json::json!({"status": "rejectedAtSubmission", "reason": "r"}),
            ),
        ];
        for (outcome, expected) in cases {
            assert_eq!(
                serde_json::to_value(&outcome).expect("serialize"),
                expected,
                "TxOutcome wire shape drifted from the txOutcome.ts contract",
            );
        }
    }
}
