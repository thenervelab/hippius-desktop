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

/// Per-action credit pricing. **The only place credit pricing lives.**
///
/// Two kinds of pricing coexist here:
///
/// 1. **Static thresholds** (`VM_CREATION`) — actions whose cost is
///    fixed regardless of payload size.
/// 2. **Per-byte rate** (`CREDITS_PER_BYTE_MONTHLY`) — upload actions
///    (`FileUpload`, `FolderUpload`, `FolderSync`, `Sharing`) where the
///    real cost scales with the bytes the user is about to commit to
///    paid storage. The static thresholds for upload actions are kept
///    at `0.0` (legacy "any positive balance" floor) but the
///    [`required_credits`](InsufficientCreditsAction::required_credits)
///    accessor combines them with the bytes-priced layer so the IPC gate
///    refuses uploads the user cannot afford BEFORE hcfs-server returns
///    a 402.
///
/// Changing the price for an action means editing one constant here.
/// Frontend and tests stay untouched.
pub mod thresholds {
    /// Minimum credits required for a single file upload. Combined with
    /// [`CREDITS_PER_BYTE_MONTHLY`] times the file's byte length at the
    /// gate. The constant itself stays at `0.0` so a zero-byte sentinel
    /// upload (or a proactive FE check that doesn't yet know the size)
    /// falls back to the legacy "any positive balance" floor.
    pub const FILE_UPLOAD: f64 = 0.0;
    /// Minimum credits required for a folder upload (which expands into
    /// many file uploads server-side). Combined with the recursive byte
    /// sum at the gate. Same `0.0` floor rationale as [`FILE_UPLOAD`].
    pub const FOLDER_UPLOAD: f64 = 0.0;
    /// Minimum credits required to add a new sync folder. Combined with
    /// the byte sum of the folder's existing contents (since those
    /// bytes are about to be uploaded by the sync engine). Same `0.0`
    /// floor rationale as [`FILE_UPLOAD`].
    pub const FOLDER_SYNC: f64 = 0.0;
    /// Minimum credits required to provision a virtual machine. The
    /// VM provisioning extrinsic charges this much from the account
    /// up-front, so a balance below this guarantees a failed extrinsic.
    /// Bytes-priced layer does NOT apply — VM creation has no upload
    /// payload.
    pub const VM_CREATION: f64 = 10.0;
    /// Minimum credits required to mint a public share link. Combined
    /// with the shared file's byte length at the gate (sharing pulls the
    /// ciphertext from the same paid storage backend, so a fully drained
    /// account would generate broken share links).
    pub const SHARING: f64 = 0.0;

    /// Credits charged per byte for one month of IPFS-tier storage,
    /// derived from `billing::charts::calculate_storage_cost_internal`
    /// (`("ipfs", "per-month", 1.0)`). The per-month projection is the
    /// price the dashboard quotes to users (the per-block charge model
    /// in `charts.rs` integrated over `2.628e6` seconds), so gating on it
    /// matches the displayed price model rather than the larger
    /// first-hour-only fee.
    ///
    /// **Value derivation** (kept inline so a code review can spot a
    /// drift without leaving this file):
    ///
    /// ```text
    /// per_block_charge   = 6.7878e-9  credits / GB / 6s
    /// first_hour_charge  = 3.15e-5    credits / GB / first hour
    /// per_month_duration = 2.628e6 s  (≈ 30.42 days)
    /// blocks_after_h1    = (2.628e6 - 3600) / 6
    ///                    = 437_400
    /// per_gb_per_month   = first_hour_charge + per_block_charge * blocks_after_h1
    ///                    = 3.15e-5 + 6.7878e-9 * 437_400
    ///                    ≈ 2.9994e-3 credits / GB / month
    /// per_byte_monthly   = per_gb_per_month / 1_073_741_824  (1 GiB)
    ///                    ≈ 2.7935e-12 credits / byte / month
    /// ```
    ///
    /// Pin a slightly conservative round number so a user with the
    /// displayed balance can always actually upload the displayed
    /// capacity (off-by-one rounding on the server would otherwise 402
    /// the gate's most-eligible files). The constant is `3.0e-12` —
    /// ~7% above the derived rate so the gate is a defensible floor.
    ///
    /// TODO(rate-sync): Phase 4 / follow-up. Replace this hardcoded
    /// constant with a fetch from hcfs-server's pricing endpoint at boot
    /// (cached, refetched on 402) so client/server pricing can't drift.
    /// Tracked in the 2026-05-13 sync-402 plan.
    pub const CREDITS_PER_BYTE_MONTHLY: f64 = 3.0e-12;
}

/// Pure cost function: credits required to upload `bytes` to paid
/// storage for one month at the IPFS tier. Saturating-multiply on the
/// `f64` side is a no-op (IEEE-754 overflow → `+inf`), but the input is
/// already a `u64` from a real on-disk byte count so overflow is
/// practically impossible. The function is `const`-friendly except for
/// the float multiply; kept as a regular `fn` for testability via the
/// [`#[cfg(test)]` block below](self::tests).
///
/// Why a free function rather than a method on [`InsufficientCreditsAction`]:
/// the function is action-agnostic. Folder walks need to sum *bytes*
/// before knowing which action to gate on, and the test fixtures need
/// to assert pricing properties in isolation.
#[must_use]
pub fn cost_for_bytes(bytes: u64) -> f64 {
    // The conversion `u64 -> f64` loses precision above 2^53 bytes
    // (~9 EB), well beyond any realistic upload. Accept the loss.
    #[allow(clippy::cast_precision_loss)]
    let bytes_f = bytes as f64;
    bytes_f * thresholds::CREDITS_PER_BYTE_MONTHLY
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
    Sharing,
}

impl InsufficientCreditsAction {
    /// Look up the static credit threshold for this action. Does NOT
    /// include the per-byte priced layer — use
    /// [`required_credits`](Self::required_credits) at the gate site
    /// instead, which combines the threshold with `cost_for_bytes` for
    /// upload actions.
    pub fn min_credits(self) -> f64 {
        match self {
            Self::FileUpload => thresholds::FILE_UPLOAD,
            Self::FolderUpload => thresholds::FOLDER_UPLOAD,
            Self::FolderSync => thresholds::FOLDER_SYNC,
            Self::VmCreation => thresholds::VM_CREATION,
            Self::Sharing => thresholds::SHARING,
        }
    }

    /// Whether this action's cost scales with an upload byte count.
    /// `VmCreation` does not (its threshold is the up-front extrinsic
    /// fee); every other action gates payload bytes through paid
    /// storage and therefore is upload-priced.
    pub fn is_upload(self) -> bool {
        matches!(self, Self::FileUpload | Self::FolderUpload | Self::FolderSync | Self::Sharing)
    }

    /// Total credits required for this action with `bytes` of upload
    /// payload. Combines [`min_credits`](Self::min_credits) (the static
    /// threshold floor) with [`cost_for_bytes`] for upload actions; for
    /// non-upload actions the bytes argument is ignored.
    ///
    /// Floor semantics: when an upload action sees `bytes == 0` (FE
    /// proactive check before the size is known, or a zero-byte file)
    /// the per-byte layer evaluates to `0.0` and the result is exactly
    /// the static threshold. This preserves the legacy "any positive
    /// balance" check for the proactive FE path.
    pub fn required_credits(self, bytes: u64) -> f64 {
        let threshold = self.min_credits();
        if self.is_upload() {
            // Use the larger of the static floor and the bytes-priced
            // cost — neither layer should ever silently relax the other.
            threshold.max(cost_for_bytes(bytes))
        } else {
            threshold
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
            Self::Sharing => "sharing",
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
    bytes: u64,
) -> Result<ActionEligibility> {
    let pool = state.pool()?;
    let required = action.required_credits(bytes);

    // 1. Live marketplace credit fetch. NO caching — the whole point of
    //    moving this to Rust is to fix the staleness bug. Done first
    //    so `current_balance` is always populated even when a later
    //    check fails. Decoded into a typed struct (not `serde_json::Value`)
    //    so we skip the dynamic-Value allocation per call.
    let client = ApiClient::new(state.api_client.clone(), pool.clone());
    let resp: crate::billing::credits::CreditBalanceResponse = client.get("/api/billing/credits/balance/", account_id).await?;
    let credit_str = resp.balance.as_deref().unwrap_or("0");
    // An unparseable balance from a 200 response is NOT the same as an empty
    // wallet, but both previously collapsed to 0.0 and silently refused every
    // gated action with no diagnostic. Keep the fail-closed 0.0 (safe default)
    // but log it so a malformed billing-API balance is traceable rather than
    // presenting to the user as "insufficient credits".
    let credits: f64 = credit_str.parse::<f64>().unwrap_or_else(|_| {
        tracing::warn!(balance = %credit_str, %account_id, "unparseable credit balance from billing API; treating as 0");
        0.0
    });

    // 2. Threshold comparison. The user must always have a strictly
    //    positive balance (matches legacy `credits <= BigInt(0)` blocks
    //    in `useCreditCheck`), AND if there's a positive `required`
    //    cost the balance must meet it. The `required` value combines
    //    the static action threshold (e.g. ≥10 for VmCreation) with the
    //    per-byte upload cost via `required_credits`, so a single
    //    comparison covers both legacy and bytes-priced paths.
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
///
/// `bytes` is optional. The proactive FE path that gates a click before
/// the user has picked a file omits it (defaults to `0`) and the gate
/// falls back to the legacy "any positive balance" floor. Callers that
/// already know the byte count (e.g. an in-app dialog summarizing the
/// files about to be uploaded) should pass it so `required_balance` in
/// the structured response is the actual computed cost — that lets the
/// FE render "$1.38 needed, $0.33 available" instead of a constant.
#[tauri::command]
pub async fn check_action_eligibility(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    action: InsufficientCreditsAction,
    bytes: Option<u64>,
) -> Result<ActionEligibility> {
    check_action_eligibility_inner(&state, &account_id, action, bytes.unwrap_or(0)).await
}

/// Enforcement helper called as the FIRST line of every gated action
/// IPC. Returns `Err(NotReady(InsufficientCredits))` when the user
/// can't afford the action — making the gate atomic with the action
/// and impossible to bypass via direct IPC calls or stale FE cache.
///
/// For upload actions, the IPC MUST pass the actual byte count of the
/// payload it is about to commit (file size for `add_file`, sum of
/// sizes for `add_files`, recursive folder byte total for `add_folder`
/// and `add_local_sync_folder`). Pass `0` only for VmCreation or for
/// the very-first proactive check that doesn't yet know the size —
/// `0` falls back to the legacy "any positive balance" floor.
///
/// # Race window
///
/// Balance can drop between this gate firing and the upload actually
/// committing (concurrent device drains the wallet, billing tick rolls
/// over, hcfs-server's view of the balance lags this client's view).
/// The gate is a best-effort proactive refusal, NOT a transactional
/// reservation — this is accepted by design. Phase 2's per-file
/// `SyncEvent::FileFailed { kind: InsufficientBalance }` path (mapped
/// from hcfs-server's 402 response) is the last line of defense and
/// the only layer that sees the true committed balance at upload time.
/// See `docs/plans/2026-05-13-sync-402-data-integrity.md` for the full
/// data-integrity layering and how the two layers interact.
///
/// Action commands should write:
///
/// ```rust,ignore
/// #[tauri::command]
/// pub async fn add_file(state, account_id, /* ... */) -> Result<...> {
///     let bytes = tokio::fs::metadata(&file_path).await?.len();
///     crate::billing::eligibility::require_eligible(
///         &state, &account_id, InsufficientCreditsAction::FileUpload, bytes,
///     ).await?;
///     // ... existing body ...
/// }
/// ```
pub async fn require_eligible(state: &crate::app_state::AppState, account_id: &str, action: InsufficientCreditsAction, bytes: u64) -> Result<()> {
    let result = check_action_eligibility_inner(state, account_id, action, bytes).await?;
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
        assert!(float_eq(InsufficientCreditsAction::Sharing.min_credits(), thresholds::SHARING));
    }

    #[test]
    fn vm_creation_is_the_only_action_requiring_chain_balance() {
        assert!(!InsufficientCreditsAction::FileUpload.requires_chain_balance());
        assert!(!InsufficientCreditsAction::FolderUpload.requires_chain_balance());
        assert!(!InsufficientCreditsAction::FolderSync.requires_chain_balance());
        assert!(InsufficientCreditsAction::VmCreation.requires_chain_balance());
        assert!(!InsufficientCreditsAction::Sharing.requires_chain_balance());
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
            (InsufficientCreditsAction::Sharing, "\"sharing\""),
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
            InsufficientCreditsAction::Sharing,
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
        assert!(
            matches_eligibility(0.0, 0.0).is_none(),
            "0 credits with 0 threshold is INELIGIBLE (legacy `credits <= 0` blocks)"
        );
        assert!(matches_eligibility(0.5, 0.0).is_some(), "0.5 credits with 0 threshold is eligible");
        assert!(matches_eligibility(1.0, 0.0).is_some());

        // >= 10 actions
        assert!(matches_eligibility(0.0, 10.0).is_none());
        assert!(
            matches_eligibility(9.99, 10.0).is_none(),
            "9.99 credits with 10 threshold is INELIGIBLE (legacy `< 10` blocks)"
        );
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

    // ─────────────────────────────────────────────────────────────────
    // Bytes-priced pricing layer (Task 3.1)
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn cost_for_bytes_is_zero_at_zero() {
        // The proactive FE path passes `bytes = 0` before the user has
        // picked a file. The gate must fall back to the static
        // threshold in that case, not over-charge a phantom zero-byte
        // upload — pinned here so `cost_for_bytes(0)` stays at exactly
        // `0.0`. Bit-pattern compare dodges clippy::float_cmp.
        assert_eq!(super::cost_for_bytes(0).to_bits(), 0.0_f64.to_bits());
    }

    #[test]
    fn cost_for_bytes_scales_with_size() {
        // Monotonicity (axiom `rust_quality_111`-style invariant on a
        // pure function): doubling the bytes must at least double the
        // cost. Pin the relationship so a future refactor that swaps
        // the constant for a per-step pricing curve still holds the
        // monotone contract.
        let small = super::cost_for_bytes(1024);
        let large = super::cost_for_bytes(1024 * 1024);
        assert!(small < large, "1024 bytes should cost less than 1MiB: {small} vs {large}");
        // Cost should be finite and non-negative; pin to catch a sign
        // flip in the constant.
        assert!(small.is_finite() && small >= 0.0);
        assert!(large.is_finite() && large >= 0.0);
    }

    #[test]
    fn cost_for_bytes_one_gib_matches_charts_per_month() {
        // Pin the derived constant against the documented per-GB
        // per-month value. The constant `CREDITS_PER_BYTE_MONTHLY`
        // was chosen ~7% above the derived rate (deliberate
        // conservative floor); the test asserts the rate sits in the
        // expected order of magnitude so a typo in the exponent (e.g.
        // `3.0e-11` vs `3.0e-12`) gets caught.
        let one_gib = super::cost_for_bytes(1024 * 1024 * 1024);
        // Documented derived value ≈ 2.9994e-3 credits/GB/month;
        // constant pinned at 3.0e-12 / byte → ~3.22e-3 / GiB.
        assert!(one_gib > 2.0e-3, "1 GiB cost must exceed 0.002 credits/month: {one_gib}");
        assert!(one_gib < 1.0e-2, "1 GiB cost must stay below 0.01 credits/month: {one_gib}");
    }

    #[test]
    fn required_credits_is_max_of_threshold_and_byte_cost() {
        // Bytes-priced upload action: cost dominates the zero floor.
        let big = 10u64 * 1024 * 1024 * 1024; // 10 GiB
        let upload_cost = InsufficientCreditsAction::FileUpload.required_credits(big);
        let raw_cost = super::cost_for_bytes(big);
        assert!(upload_cost >= raw_cost);

        // Non-upload action: bytes are ignored; threshold dominates.
        let vm_cost = InsufficientCreditsAction::VmCreation.required_credits(big);
        assert_eq!(vm_cost.to_bits(), thresholds::VM_CREATION.to_bits());

        // Zero-byte upload: required is exactly the static floor.
        let zero_upload = InsufficientCreditsAction::FileUpload.required_credits(0);
        assert_eq!(zero_upload.to_bits(), thresholds::FILE_UPLOAD.to_bits());
    }

    #[test]
    fn is_upload_classifies_all_variants() {
        // Pin the upload/non-upload partition so a new variant added to
        // `InsufficientCreditsAction` must explicitly choose a side —
        // otherwise the bytes-priced gate would silently default to
        // ignoring the payload size for that new action.
        assert!(InsufficientCreditsAction::FileUpload.is_upload());
        assert!(InsufficientCreditsAction::FolderUpload.is_upload());
        assert!(InsufficientCreditsAction::FolderSync.is_upload());
        assert!(InsufficientCreditsAction::Sharing.is_upload());
        assert!(!InsufficientCreditsAction::VmCreation.is_upload());
    }

    #[test]
    fn eligibility_threshold_logic_handles_byte_priced_uploads() {
        // Tiny upload (1 byte): cost is far below any positive balance.
        let tiny = super::cost_for_bytes(1);
        assert!(matches_eligibility(0.33, tiny).is_some(), "1 byte fits in $0.33 balance");

        // 100 MiB upload: 100 * 1024 * 1024 * 3e-12 ≈ 3.14e-4 credits.
        // Still affordable on a $0.33 balance.
        let medium = super::cost_for_bytes(100 * 1024 * 1024);
        assert!(matches_eligibility(0.33, medium).is_some(), "100 MiB upload fits in $0.33 balance");

        // 1 TiB upload: ≈ 3.3 credits. NOT affordable on $0.33.
        let huge = super::cost_for_bytes(1024u64 * 1024 * 1024 * 1024);
        assert!(matches_eligibility(0.33, huge).is_none(), "1 TiB upload does NOT fit in $0.33 balance");
        assert!(matches_eligibility(10.0, huge).is_some(), "1 TiB upload fits in 10-credit balance");
    }
}
