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
    let s = balance_str.trim();
    if s.is_empty() || s == "0" {
        return "0".to_string();
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s, ""),
    };
    // Pad or truncate fractional part to exactly 18 digits
    let padded: String = if frac_part.len() >= 18 {
        frac_part[..18].to_string()
    } else {
        format!("{frac_part:0<18}")
    };
    let combined = format!("{int_part}{padded}");
    // Strip leading zeros but keep at least "0"
    let stripped = combined.trim_start_matches('0');
    if stripped.is_empty() { "0".to_string() } else { stripped.to_string() }
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
#[tauri::command]
pub async fn get_user_credits(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<CreditBalance, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let resp: CreditBalanceResponse = client.get("/api/billing/credits/balance/", &account_id).await?;
    let balance_str = resp.balance.as_deref().unwrap_or("0");
    let planck = credits_to_planck(balance_str);
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
pub async fn check_sync_eligibility(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<SyncEligibility, AppError> {
    use crate::billing::eligibility::{InsufficientCreditsAction, check_action_eligibility_inner};

    let result = check_action_eligibility_inner(&state, &account_id, InsufficientCreditsAction::FolderSync).await?;
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
}
