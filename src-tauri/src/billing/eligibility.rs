//! Action-eligibility checks for credit-gated operations.
//!
//! Centralizes the threshold table, the live balance check, and the
//! enforcement helper that gated action IPCs use to refuse work when the
//! user can't afford it. Replaces the TypeScript `useCreditCheck` hook
//! that was reading from a `staleTime: Infinity` TanStack Query cache and
//! gating only at the click handler — see
//! `docs/follow-ups/credit-check-rust-source-of-truth.md` for the full
//! reasoning.
//!
//! ## Architecture
//!
//! Two entry points:
//!
//! 1. [`check_action_eligibility`] — Tauri command that returns a
//!    structured `ActionEligibility { eligible, reason, .. }` so the FE
//!    can show the insufficient-credits dialog **proactively** before
//!    opening an action modal. The check uses a **live** balance fetch
//!    with no caching — that's the whole point of moving this to Rust.
//!
//! 2. [`require_eligible`] — Async helper called as the FIRST line of
//!    every gated action IPC. Returns `Err(NotReady(InsufficientCredits))`
//!    if the user can't afford the action. This makes the gate atomic
//!    with the action and impossible to bypass by calling the IPC
//!    directly or by acting on stale FE cache.
//!
//! ## Why a separate enum from `NotReadyKind`
//!
//! `InsufficientCreditsAction` is the **input** to the eligibility
//! check (which action is being requested). It travels FE → Rust as a
//! `kebab-case` string in the IPC parameter. The reverse direction
//! (Rust → FE error) doesn't need to carry the action because the FE
//! always knows which IPC it called — `NotReadyKind::InsufficientCredits`
//! is a unit variant.

use crate::api::client::ApiClient;
use crate::error::{AppError, NotReadyKind, Result};
use serde::{Deserialize, Serialize};

/// Per-action credit thresholds. **The only place credit pricing lives.**
///
/// Changing the price for an action means editing one constant here.
/// Frontend and tests stay untouched.
pub mod thresholds {
    /// Minimum credits required for a single file upload. Strictly
    /// greater than zero — any positive balance is enough.
    pub const FILE_UPLOAD: f64 = 0.0;
    /// Minimum credits required for a folder upload (which expands into
    /// many file uploads server-side). Same `> 0` rule.
    pub const FOLDER_UPLOAD: f64 = 0.0;
    /// Minimum credits required to add a new sync folder. Same `> 0`
    /// rule — used by the existing `check_sync_eligibility` flow.
    pub const FOLDER_SYNC: f64 = 0.0;
    /// Minimum credits required to provision a virtual machine. The
    /// VM provisioning extrinsic charges this much from the account
    /// up-front, so a balance below this guarantees a failed extrinsic.
    pub const VM_CREATION: f64 = 10.0;
}

/// Which action the user is requesting eligibility for. Wire format is
/// `kebab-case` to match the existing TypeScript
/// `InsufficientCreditsReason` type and the dialog copy table — the FE
/// already passes these strings to the (now-defunct) JS-side gate, so
/// migrating the call sites is mechanical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InsufficientCreditsAction {
    FileUpload,
    FolderUpload,
    FolderSync,
    VmCreation,
}

impl InsufficientCreditsAction {
    /// Look up the credit threshold for this action.
    pub fn min_credits(self) -> f64 {
        match self {
            Self::FileUpload => thresholds::FILE_UPLOAD,
            Self::FolderUpload => thresholds::FOLDER_UPLOAD,
            Self::FolderSync => thresholds::FOLDER_SYNC,
            Self::VmCreation => thresholds::VM_CREATION,
        }
    }

    /// Whether the action requires a non-zero substrate chain balance
    /// in addition to marketplace credits. Currently only true for VM
    /// creation, which signs an extrinsic at provision time — a chain-
    /// balance-zero account can't pay the extrinsic fee even if it has
    /// marketplace credits.
    pub fn requires_chain_balance(self) -> bool {
        matches!(self, Self::VmCreation)
    }

    /// Stable string used in [`ActionEligibility::reason`] when the
    /// check fails. Frontend can match on this in lieu of (or in
    /// addition to) the human-readable message.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FileUpload => "file-upload",
            Self::FolderUpload => "folder-upload",
            Self::FolderSync => "folder-sync",
            Self::VmCreation => "vm-creation",
        }
    }
}

/// Result of an eligibility check. The frontend uses this to decide
/// whether to open the insufficient-credits dialog before launching a
/// gated action modal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEligibility {
    pub eligible: bool,
    /// Machine-readable reason code when ineligible. One of:
    /// - `"balance_zero"` — chain balance is zero (only set for actions
    ///   that need to sign an extrinsic; see [`requires_chain_balance`])
    /// - `"insufficient_credits"` — marketplace credits below the
    ///   action's threshold
    /// - `None` when eligible
    pub reason: Option<String>,
    /// Live marketplace credit balance at the time of the check, in
    /// whole credit units. Useful for the FE to show the user how
    /// many more credits they need.
    pub current_balance: f64,
    /// Threshold the action requires.
    pub required_balance: f64,
}

/// Inner check, callable from any context (Tauri command OR
/// `require_eligible` helper). Returns the structured eligibility
/// rather than an error so it can be used for both proactive UI
/// queries and IPC enforcement.
///
/// Order matters: marketplace credits are fetched FIRST (always), so
/// `ActionEligibility::current_balance` is always accurate regardless
/// of which check fails. The chain-balance check happens AFTER and only
/// for actions that need to sign an extrinsic — and even then, an
/// already-failed credit check short-circuits.
pub(crate) async fn check_action_eligibility_inner(
    state: &crate::app_state::AppState,
    account_id: &str,
    action: InsufficientCreditsAction,
) -> Result<ActionEligibility> {
    let pool = state.pool()?;
    let required = action.min_credits();

    // 1. Live marketplace credit fetch. NO caching — the whole point of
    //    moving this to Rust is to fix the staleness bug. Done first
    //    so `current_balance` is always populated even when a later
    //    check fails.
    let client = ApiClient::new(state.api_client.clone(), pool.clone());
    let resp: serde_json::Value = client.get("/api/billing/credits/balance/", account_id).await?;
    let credit_str = resp.get("balance").and_then(|v| v.as_str()).unwrap_or("0");
    let credits: f64 = credit_str.parse().unwrap_or(0.0);

    // 2. Threshold comparison. The user must always have a strictly
    //    positive balance (matches legacy `credits <= BigInt(0)` blocks
    //    in `useCreditCheck`), AND if there's a non-zero threshold the
    //    balance must meet it (matches legacy `creditsNumber < 10` for
    //    VM creation). Both legacy semantics combined into one check
    //    that doesn't require a float-equality comparison against zero.
    let credits_ok = credits > 0.0 && (required <= 0.0 || credits >= required);
    if !credits_ok {
        return Ok(ActionEligibility {
            eligible: false,
            reason: Some("insufficient_credits".into()),
            current_balance: credits,
            required_balance: required,
        });
    }

    // 3. Chain balance check (only for actions that sign extrinsics —
    //    currently just `VmCreation`). Mirrors the existing
    //    `check_sync_eligibility` substrate path. Clone the Arc and
    //    drop the lock guard before any .await.
    if action.requires_chain_balance() {
        let substrate_client = {
            let guard = state.blockchain.client.read().unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.clone()
        };
        if let Some(client) = substrate_client
            && let Ok(acct) = account_id.parse::<subxt::utils::AccountId32>()
        {
            let query = crate::blockchain::runtime::custom_runtime::storage().system().account(&acct);
            if let Ok(storage) = client.storage().at_latest().await
                && let Ok(info) = storage.fetch(&query).await
            {
                let free = info.map_or(0, |i| i.data.free);
                if free == 0 {
                    return Ok(ActionEligibility {
                        eligible: false,
                        reason: Some("balance_zero".into()),
                        // `current_balance` correctly reflects the
                        // marketplace credit balance (not zero) — the
                        // user has credits, they just don't have chain
                        // balance to pay the extrinsic fee.
                        current_balance: credits,
                        required_balance: required,
                    });
                }
            }
        }
    }

    Ok(ActionEligibility {
        eligible: true,
        reason: None,
        current_balance: credits,
        required_balance: required,
    })
}

/// Tauri command for the proactive eligibility check. Called by the
/// frontend `useCreditCheck` hook before opening any gated action modal.
#[tauri::command]
pub async fn check_action_eligibility(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    action: InsufficientCreditsAction,
) -> Result<ActionEligibility> {
    check_action_eligibility_inner(&state, &account_id, action).await
}

/// Enforcement helper called as the FIRST line of every gated action
/// IPC. Returns `Err(NotReady(InsufficientCredits))` when the user
/// can't afford the action — making the gate atomic with the action
/// and impossible to bypass via direct IPC calls or stale FE cache.
///
/// Action commands should write:
///
/// ```rust,ignore
/// #[tauri::command]
/// pub async fn add_file(state, account_id, /* ... */) -> Result<...> {
///     crate::billing::eligibility::require_eligible(
///         &state, &account_id, InsufficientCreditsAction::FileUpload,
///     ).await?;
///     // ... existing body ...
/// }
/// ```
pub async fn require_eligible(
    state: &crate::app_state::AppState,
    account_id: &str,
    action: InsufficientCreditsAction,
) -> Result<()> {
    let result = check_action_eligibility_inner(state, account_id, action).await?;
    if result.eligible {
        Ok(())
    } else {
        Err(AppError::NotReady(NotReadyKind::InsufficientCredits))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compare two `f64` values by bit pattern. The thresholds are
    /// integer-valued constants, so bit equality is exact and lets us
    /// dodge clippy's `float_cmp` lint without `#[allow]`.
    fn float_eq(a: f64, b: f64) -> bool {
        a.to_bits() == b.to_bits()
    }

    #[test]
    fn min_credits_per_action_matches_thresholds() {
        assert!(float_eq(InsufficientCreditsAction::FileUpload.min_credits(), thresholds::FILE_UPLOAD));
        assert!(float_eq(InsufficientCreditsAction::FolderUpload.min_credits(), thresholds::FOLDER_UPLOAD));
        assert!(float_eq(InsufficientCreditsAction::FolderSync.min_credits(), thresholds::FOLDER_SYNC));
        assert!(float_eq(InsufficientCreditsAction::VmCreation.min_credits(), thresholds::VM_CREATION));
    }

    #[test]
    fn vm_creation_is_the_only_action_requiring_chain_balance() {
        assert!(!InsufficientCreditsAction::FileUpload.requires_chain_balance());
        assert!(!InsufficientCreditsAction::FolderUpload.requires_chain_balance());
        assert!(!InsufficientCreditsAction::FolderSync.requires_chain_balance());
        assert!(InsufficientCreditsAction::VmCreation.requires_chain_balance());
    }

    #[test]
    fn action_serializes_to_kebab_case() {
        // Wire format must match the existing TS `InsufficientCreditsReason`
        // type values, which the dialog copy table keys on.
        for (action, expected) in [
            (InsufficientCreditsAction::FileUpload, "\"file-upload\""),
            (InsufficientCreditsAction::FolderUpload, "\"folder-upload\""),
            (InsufficientCreditsAction::FolderSync, "\"folder-sync\""),
            (InsufficientCreditsAction::VmCreation, "\"vm-creation\""),
        ] {
            let json = serde_json::to_string(&action).expect("serialize");
            assert_eq!(json, expected);
            assert_eq!(action.as_str(), &expected[1..expected.len() - 1]);
        }
    }

    #[test]
    fn action_round_trips_through_json() {
        // Frontend sends `kebab-case` strings; Rust must accept them.
        for action in [
            InsufficientCreditsAction::FileUpload,
            InsufficientCreditsAction::FolderUpload,
            InsufficientCreditsAction::FolderSync,
            InsufficientCreditsAction::VmCreation,
        ] {
            let json = serde_json::to_string(&action).unwrap();
            let parsed: InsufficientCreditsAction = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, action);
        }
    }

    /// Pure threshold logic without touching the network — verifies
    /// the strict `>` vs `>=` semantics that mirror the legacy TS rules:
    /// `credits > 0` for the zero-threshold actions, `credits >= 10` for
    /// VM creation.
    #[test]
    fn eligibility_threshold_logic_matches_legacy_typescript() {
        // > 0 actions
        assert!(matches_eligibility(0.0, 0.0).is_none(), "0 credits with 0 threshold is INELIGIBLE (legacy `credits <= 0` blocks)");
        assert!(matches_eligibility(0.5, 0.0).is_some(), "0.5 credits with 0 threshold is eligible");
        assert!(matches_eligibility(1.0, 0.0).is_some());

        // >= 10 actions
        assert!(matches_eligibility(0.0, 10.0).is_none());
        assert!(matches_eligibility(9.99, 10.0).is_none(), "9.99 credits with 10 threshold is INELIGIBLE (legacy `< 10` blocks)");
        assert!(matches_eligibility(10.0, 10.0).is_some(), "exactly 10 credits passes legacy `< 10` check");
        assert!(matches_eligibility(11.0, 10.0).is_some());
    }

    /// Returns `Some(())` if `credits` would pass the eligibility check
    /// for the given threshold, mirroring the production logic exactly.
    /// Used by the unit test above to keep the assertion table compact.
    fn matches_eligibility(credits: f64, required: f64) -> Option<()> {
        let eligible = credits > 0.0 && (required <= 0.0 || credits >= required);
        eligible.then_some(())
    }
}
