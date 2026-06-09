//! Credits balance, planck conversion, and sync eligibility.

use crate::api::client::ApiClient;
use crate::error::AppError;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Credits & transactions (API)
// ---------------------------------------------------------------------------

/// Convert a decimal credit string (e.g. "1.5") to its planck representation
/// (18 decimals) without floating-point intermediary. Returns the integer as a
/// string so TypeScript can convert to BigInt losslessly.
fn credits_to_planck(balance_str: &str) -> String {
    // Delegate to the canonical decimal→planck converter (same 18-decimal
    // pad/truncate/strip-leading-zeros logic + fail-closed validation) so the
    // two can't drift (audit R-09). Policy difference vs `to_plancks`: the
    // billing balance is first-party, but a malformed 200 must render as "0" —
    // never a corrupt planck string (the FE feeds it to `BigInt()`) and never a
    // panic — so we trim surrounding whitespace and fail *soft* to "0" where
    // `to_plancks` (a user-typed send amount) fails *hard* with a validation
    // error.
    crate::blockchain::convert::to_plancks(balance_str.trim().to_owned()).unwrap_or_else(|_| "0".to_string())
}

/// Credit balance in both representations the frontend needs: raw planck
/// (for bigint math / eligibility comparisons) and pre-formatted HIP
/// display string (from `planck_to_hip`, so every credit render in the
/// app goes through a single formatter).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreditBalance {
    pub planck: String,
    pub hip: String,
}

/// Wire shape of `/api/billing/credits/balance/`. Decoded directly into
/// this struct instead of `serde_json::Value` so we skip the dynamic
/// allocation of a `Map<String, Value>` plus boxed `Value::String` per
/// HTTP response.
#[derive(serde::Deserialize)]
pub(crate) struct CreditBalanceResponse {
    /// Balance in HIP units as a decimal string (e.g. `"1.5"`).
    #[serde(default)]
    pub balance: Option<String>,
}

/// Fetch the credit balance.
///
/// The API returns `{ "balance": "1.5" }`. This command converts to
/// planck via `credits_to_planck` (string divmod, no float), then runs
/// the planck string through `planck_to_hip` so the FE has both shapes
/// in a single round-trip.
/// Fetch this account's LIVE credit balance from the billing API and convert it
/// to a planck string. Shared by `get_user_credits` (display) and
/// `check_low_credit_notification_live` (the low-balance warning) so the warning
/// decision runs against a freshly-fetched balance instead of the FE's
/// `staleTime: Infinity` cache, which was never invalidated — a user who dropped
/// below the threshold mid-session was never warned (audit R-08).
pub(crate) async fn fetch_credit_balance_planck(state: &crate::app_state::AppState, account_id: &crate::app_state::SessionAccount) -> Result<String, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let resp: CreditBalanceResponse = client.get("/api/billing/credits/balance/", account_id).await?;
    let balance_str = resp.balance.as_deref().unwrap_or("0");
    Ok(credits_to_planck(balance_str))
}

#[tauri::command]
pub async fn get_user_credits(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
) -> Result<CreditBalance, AppError> {
    let planck = fetch_credit_balance_planck(&state, &account_id).await?;
    let hip = crate::blockchain::convert::planck_to_hip(&planck);
    Ok(CreditBalance { planck, hip })
}

/// Check whether the user is eligible to start syncing files.
///
/// Checks chain balance and marketplace credits. Returns a reason code
/// so the frontend can display the appropriate toast message.
///
/// Reason codes: `"balance_zero"`, `"no_credits"`, or `None` when eligible.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEligibility {
    pub eligible: bool,
    /// Machine-readable reason code — frontend maps to a user-facing message.
    pub reason: Option<String>,
}

/// **Backwards-compatible alias** for the original sync-eligibility check.
///
/// New code should call `check_action_eligibility` in `billing/eligibility.rs`
/// directly with `InsufficientCreditsAction::FolderSync`. This wrapper exists
/// so that any pre-existing FE caller of `check_sync_eligibility` keeps
/// working without a behavior change — it returns the same `SyncEligibility`
/// shape and the same legacy reason codes (`balance_zero` / `no_credits`).
#[tauri::command]
pub async fn check_sync_eligibility(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
) -> Result<SyncEligibility, AppError> {
    use crate::billing::eligibility::{InsufficientCreditsAction, check_action_eligibility_inner};

    // Legacy alias preserves the pre-Task-3.1 semantic: `> 0` floor, no
    // bytes-priced layer. Callers that need price-aware gating should
    // call `check_action_eligibility` directly with an explicit byte
    // count (see `useCreditCheck` migration plan).
    let result = check_action_eligibility_inner(&state, &account_id, InsufficientCreditsAction::FolderSync, 0).await?;
    if result.eligible {
        return Ok(SyncEligibility {
            eligible: true,
            reason: None,
        });
    }
    // Map the new `reason` codes back to the legacy ones the old IPC
    // contract used. The new shape is richer (current_balance,
    // required_balance) but legacy callers only consumed `reason`.
    let legacy_reason = match result.reason.as_deref() {
        Some("balance_zero") => "balance_zero",
        // The legacy reason for "credits below threshold" was "no_credits",
        // since the only legacy threshold was `> 0`. Preserve that name.
        _ => "no_credits",
    };
    Ok(SyncEligibility {
        eligible: false,
        reason: Some(legacy_reason.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credits_to_planck_whole_number() {
        assert_eq!(credits_to_planck("1"), "1000000000000000000");
    }

    #[test]
    fn credits_to_planck_decimal() {
        assert_eq!(credits_to_planck("1.5"), "1500000000000000000");
    }

    #[test]
    fn credits_to_planck_small() {
        assert_eq!(credits_to_planck("0.000000000000000001"), "1");
    }

    #[test]
    fn credits_to_planck_zero() {
        assert_eq!(credits_to_planck("0"), "0");
        assert_eq!(credits_to_planck(""), "0");
    }

    #[test]
    fn credits_to_planck_large() {
        assert_eq!(credits_to_planck("123456.789"), "123456789000000000000000");
    }

    #[test]
    fn credits_to_planck_many_decimals() {
        // Truncates beyond 18 digits
        assert_eq!(credits_to_planck("1.1234567890123456789"), "1123456789012345678");
    }

    // ── R-09: fail-closed validation + panic-safety ────────────────────────

    #[test]
    fn credits_to_planck_rejects_negative() {
        // Previously survived as "-5000000000000000000".
        assert_eq!(credits_to_planck("-5"), "0");
        assert_eq!(credits_to_planck("-0.5"), "0");
    }

    #[test]
    fn credits_to_planck_rejects_scientific_notation() {
        // Previously mangled to "15e3000000000000000".
        assert_eq!(credits_to_planck("1.5e3"), "0");
        assert_eq!(credits_to_planck("1E18"), "0");
    }

    #[test]
    fn credits_to_planck_rejects_non_digits_and_extra_dots() {
        assert_eq!(credits_to_planck("abc"), "0");
        assert_eq!(credits_to_planck("1.2.3"), "0");
        assert_eq!(credits_to_planck("0x10"), "0");
        assert_eq!(credits_to_planck("1,5"), "0");
    }

    #[test]
    fn credits_to_planck_does_not_panic_on_multibyte_fraction() {
        // A multibyte char at/after byte 18 of the fraction used to panic the
        // raw `frac_part[..18]` slice. It must now fail closed to "0" instead.
        let malformed = format!("0.{}é", "1".repeat(17)); // 'é' is 2 bytes at offset 17
        assert_eq!(credits_to_planck(&malformed), "0");
        // Long all-digit fraction (> 18) still truncates cleanly, no panic.
        assert_eq!(credits_to_planck("0.1234567890123456789012345"), "123456789012345678");
    }
}
