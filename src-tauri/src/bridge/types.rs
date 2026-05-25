//! Bridge data types — `camelCase` so the TS shapes from
//! `hippius-web/src/lib/bridge/types.ts` carry over unchanged on the
//! frontend.
//!
//! Naming policy: keep field names identical to web's TypeScript so
//! the FE can paste shapes from there without renames. Even the
//! direction strings (`alpha-to-halpha` / `halpha-to-alpha`) match
//! verbatim.

use serde::{Deserialize, Serialize};

/// Which way the bridge is going. Lowercase + dash-separated to
/// match the strings the web client persisted before us — keeps the
/// SQLite rows interoperable if we ever ingest exported web history.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeDirection {
    AlphaToHalpha,
    HalphaToAlpha,
}

impl BridgeDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            BridgeDirection::AlphaToHalpha => "alpha-to-halpha",
            BridgeDirection::HalphaToAlpha => "halpha-to-alpha",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "alpha-to-halpha" => Some(BridgeDirection::AlphaToHalpha),
            "halpha-to-alpha" => Some(BridgeDirection::HalphaToAlpha),
            _ => None,
        }
    }
}

/// High-level bridge status — driven by the on-chain confirmation
/// state, not the local extrinsic submit step. `unknown` is the
/// post-timeout limbo state (the transfer may still succeed; we just
/// can't tell from the chain yet).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BridgeStatus {
    Pending,
    Confirmed,
    Processing,
    Completed,
    Failed,
    Unknown,
}

impl BridgeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            BridgeStatus::Pending => "pending",
            BridgeStatus::Confirmed => "confirmed",
            BridgeStatus::Processing => "processing",
            BridgeStatus::Completed => "completed",
            BridgeStatus::Failed => "failed",
            BridgeStatus::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(BridgeStatus::Pending),
            "confirmed" => Some(BridgeStatus::Confirmed),
            "processing" => Some(BridgeStatus::Processing),
            "completed" => Some(BridgeStatus::Completed),
            "failed" => Some(BridgeStatus::Failed),
            "unknown" => Some(BridgeStatus::Unknown),
            _ => None,
        }
    }
}

/// One step in the bridge wizard. Mirrors web's `BridgeStep`. Tauri
/// emits these via the `hippius_bridge_step` event during
/// `bridge_submit_*` so the dialog can paint a 4-step progress
/// timeline (Alpha→hAlpha) or a 1-step timeline (hAlpha→Alpha).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStep {
    /// 1-based step number for the wizard label.
    pub step: u32,
    pub label: String,
    pub detail: String,
    /// `pending | active | done | error`.
    pub state: BridgeStepState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BridgeStepState {
    Pending,
    Active,
    Done,
    Error,
}

/// One event in the bridge transaction's lifecycle. Stored as JSON
/// inside `bridge_transactions.events_json` so the frontend timeline
/// can show the full history without an extra JOIN.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTransactionEvent {
    /// Event kind. Kept as a free-form string so we don't have to
    /// enumerate every web-side variant — the FE renders the
    /// `message` regardless.
    #[serde(rename = "type")]
    pub kind: String,
    /// Milliseconds since the Unix epoch.
    pub timestamp: i64,
    pub message: String,
    /// Optional extra structured data for the row's tooltip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// A persisted bridge transaction. Wire format matches web's
/// `TrackedTransaction` so the existing UI components compile against
/// the desktop IPC unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedBridgeTransaction {
    pub id: String,
    pub direction: String,
    pub status: String,
    /// Amount in chain-native smallest unit as a decimal string —
    /// always a string on the wire so BigInts > 2^53 round-trip
    /// through JSON without loss.
    pub amount: String,
    /// Decimal places for `amount`. Alpha is 9, hAlpha is 18.
    /// Stored alongside so the FE doesn't need to look at `direction`
    /// to know how to format the displayed value.
    pub amount_decimals: u8,
    pub sender_address: String,
    pub recipient_address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tx_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_tx_hash: Option<String>,
    /// Set on Alpha → hAlpha after the contract returns a deposit id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deposit_id: Option<String>,
    /// Set on hAlpha → Alpha after the AlphaBridge pallet emits a
    /// `WithdrawalRequested` event with an id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawal_id: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub attestations: u32,
    pub required_attestations: u32,
    pub events: Vec<BridgeTransactionEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denial_reason: Option<String>,
    #[serde(default)]
    pub refunded: bool,
}

/// Return shape of a `bridge_submit_*` IPC.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSubmitResult {
    /// Local tracking id (used by the FE to subscribe to progress events).
    pub bridge_transaction_id: String,
    /// On-chain extrinsic hash of the submit step. For Alpha → hAlpha
    /// this is the `Contracts::call` hash; for hAlpha → Alpha it's
    /// the `AlphaBridge::withdraw` hash.
    pub tx_hash: String,
}
