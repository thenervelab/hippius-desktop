//! Drive storage quota: would this write fit under the account's plan?
//!
//! Drive storage is sold as a plan, so what may be written is decided by
//! the plan's allowance and what is already stored — not by a credit
//! balance. This replaces the credit gate on every Drive write path; VM
//! creation is genuinely credit-priced and keeps its own gate.
//!
//! ## Fail open, deliberately
//!
//! An account the Drive backend does not map to a plan has no allowance to
//! check. Rather than refuse it, the write proceeds and hcfs-server decides
//! with its own gate, which is the real backstop on every write. The same
//! applies when the allowance or the usage cannot be read: this check
//! exists to give a clear answer early, never to be the only thing standing
//! between a paying account and its own storage.

use crate::api::client::ApiClient;
use crate::app_state::{AppState, SessionAccount};
use crate::error::AppError;
use serde::Serialize;

/// What a quota check concluded, and the numbers behind it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaVerdict {
    pub allowed: bool,
    /// Bytes already stored, per the indexer.
    pub used_bytes: u64,
    /// The plan's allowance, or `None` when no plan could be read.
    pub limit_bytes: Option<u64>,
}

impl QuotaVerdict {
    /// No allowance to judge against; the server decides on the write.
    fn unknown(used_bytes: u64) -> Self {
        Self {
            allowed: true,
            used_bytes,
            limit_bytes: None,
        }
    }

    /// Judge `incoming_bytes` against a known allowance.
    ///
    /// The comparison lives here on its own so the tests can exercise the
    /// REAL rule. They used to assert against a copy of this expression
    /// written in the test module, which stays green no matter what this
    /// line does — the one branch that decides every upload was, in
    /// effect, uncovered.
    fn decide(used_bytes: u64, incoming_bytes: u64, limit_bytes: u64) -> Self {
        Self {
            // Saturating so a bogus huge size cannot wrap into "fits", and
            // `<=` because the allowance is what the account may store, not
            // one byte less.
            allowed: used_bytes.saturating_add(incoming_bytes) <= limit_bytes,
            used_bytes,
            limit_bytes: Some(limit_bytes),
        }
    }
}

/// Whether the payload describes an account on a paid plan.
///
/// A missing or non-boolean `active` reads as "not subscribed", which sends
/// the account to the free tier rather than to an unknown allowance —
/// every account has the free tier, so "no plan" is never "no limit".
pub(crate) fn subscription_is_active(sub: &serde_json::Value) -> bool {
    sub.get("active").and_then(serde_json::Value::as_bool).unwrap_or(false)
}

/// The allowance an ACTIVE subscription states, or `None` when it states
/// none. A plan with no stated allowance tells us nothing either way, so
/// the caller falls open rather than guessing a number.
pub(crate) fn active_plan_bytes(sub: &serde_json::Value) -> Option<u64> {
    sub.get("storage_bytes").and_then(serde_json::Value::as_u64).filter(|b| *b > 0)
}

/// The account's storage allowance in bytes, or `None` when it cannot be
/// read (fail open — see the module doc).
///
/// `active: false` is NOT "no allowance": every account has the free tier.
/// Treating it as unknown let a free account hundreds of GB past its 10 GB
/// keep uploading from the desktop while the console — which asks the
/// server's own `/can_upload` gate — refused the same bytes. The free
/// allowance is read from the plans catalogue, the number the server
/// itself enforces, so this check still cannot refuse a write the server
/// would accept; only a failed READ falls open.
async fn plan_allowance(state: &AppState, account: &SessionAccount) -> Option<u64> {
    let client = ApiClient::new(state.api_client.clone(), state.pool().ok()?.clone());
    let sub: serde_json::Value = client.get("/api/drive/subscription/", account).await.ok()?;
    if subscription_is_active(&sub) {
        return active_plan_bytes(&sub);
    }
    let plans: serde_json::Value = client.get("/api/drive/plans/", account).await.ok()?;
    free_plan_bytes(&plans)
}

/// The free plan's allowance out of the catalogue payload (a bare array or
/// `{ results: [...] }`, same tolerance as the FE's `useDrivePlans`).
///
/// Shared with [`crate::billing::storage_overview`] so the number the home
/// card plots and the number this gate enforces come from the SAME server
/// field. They were briefly two constants, which is how a card and a
/// refusal come to disagree about the same account.
pub(crate) fn free_plan_bytes(plans: &serde_json::Value) -> Option<u64> {
    let list = plans.as_array().or_else(|| plans.get("results").and_then(serde_json::Value::as_array))?;
    list.iter()
        .find(|p| p.get("is_free").and_then(serde_json::Value::as_bool).unwrap_or(false))
        .and_then(|p| p.get("storage_bytes"))
        .and_then(serde_json::Value::as_u64)
        .filter(|b| *b > 0)
}

/// Would storing `incoming_bytes` more keep the account inside its plan?
pub async fn check_drive_quota(state: &AppState, account: &SessionAccount, incoming_bytes: u64) -> Result<QuotaVerdict, AppError> {
    let (allowance, stats) = tokio::join!(
        plan_allowance(state, account),
        crate::billing::queries::fetch_drive_storage_stats(state, account.as_str()),
    );

    // Usage that cannot be read is not evidence of being over quota.
    let used_bytes = match stats {
        Ok(s) => s.total_bytes,
        Err(_) => return Ok(QuotaVerdict::unknown(0)),
    };

    let Some(limit_bytes) = allowance else {
        return Ok(QuotaVerdict::unknown(used_bytes));
    };

    Ok(QuotaVerdict::decide(used_bytes, incoming_bytes, limit_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_that_fits_is_allowed() {
        assert!(QuotaVerdict::decide(1_000, 500, 2_000).allowed);
    }

    #[test]
    fn exactly_filling_the_plan_is_allowed() {
        // The allowance is what the account may store, not one byte less.
        assert!(QuotaVerdict::decide(1_500, 500, 2_000).allowed);
    }

    #[test]
    fn a_write_past_the_allowance_is_refused() {
        assert!(!QuotaVerdict::decide(1_800, 500, 2_000).allowed);
    }

    #[test]
    fn one_byte_past_the_allowance_is_refused() {
        // Pins the boundary from the other side: with the pair above, a
        // `<` or `<=` slip is caught whichever way it goes.
        assert!(!QuotaVerdict::decide(1_500, 501, 2_000).allowed);
    }

    #[test]
    fn an_absurd_size_cannot_wrap_into_fitting() {
        assert!(!QuotaVerdict::decide(u64::MAX - 1, u64::MAX, 2_000).allowed);
    }

    #[test]
    fn a_verdict_reports_the_numbers_behind_it() {
        let v = QuotaVerdict::decide(1_000, 500, 2_000);
        assert_eq!(v.used_bytes, 1_000, "used bytes are the account's, not the sum");
        assert_eq!(v.limit_bytes, Some(2_000));
    }

    #[test]
    fn an_unknown_allowance_allows_the_write() {
        // A failed READ falls open; refusing there would block writes
        // hcfs-server would accept.
        let v = QuotaVerdict::unknown(123);
        assert!(v.allowed);
        assert!(v.limit_bytes.is_none());
    }

    /// An active plan is judged against the allowance it states.
    #[test]
    fn an_active_subscription_supplies_the_allowance() {
        let sub = serde_json::json!({ "active": true, "storage_bytes": 2_000u64 });
        assert!(subscription_is_active(&sub));
        assert_eq!(active_plan_bytes(&sub), Some(2_000));
    }

    /// An active plan that states no usable allowance is unknown, NOT zero
    /// — reading a missing or `0` field as an allowance would refuse every
    /// write on a paid account the moment the API omitted the field.
    #[test]
    fn an_active_plan_with_no_stated_allowance_is_unknown() {
        assert_eq!(active_plan_bytes(&serde_json::json!({ "active": true })), None);
        assert_eq!(active_plan_bytes(&serde_json::json!({ "active": true, "storage_bytes": 0u64 })), None);
    }

    /// Anything that is not an explicit `active: true` sends the account to
    /// the free tier, which is an allowance like any other.
    #[test]
    fn a_missing_or_false_active_flag_is_not_a_paid_plan() {
        assert!(!subscription_is_active(&serde_json::json!({ "active": false })));
        assert!(!subscription_is_active(&serde_json::json!({})));
        assert!(!subscription_is_active(&serde_json::json!({ "active": "yes" })));
    }

    /// A no-subscription account is judged against the FREE plan's
    /// allowance from the catalogue — treating it as unknown was the hole
    /// that let a free account far past 10 GB keep uploading from the
    /// desktop while the console's server-side gate refused the same bytes.
    #[test]
    fn the_free_plan_allowance_is_read_from_the_catalogue() {
        let ten_gib: u64 = 10 * 1024 * 1024 * 1024;
        let plans = serde_json::json!([
            { "code": "plus", "is_free": false, "storage_bytes": 999u64 },
            { "code": "free", "is_free": true, "storage_bytes": ten_gib }
        ]);
        assert_eq!(free_plan_bytes(&plans), Some(ten_gib));

        // The API may also wrap the list.
        let wrapped = serde_json::json!({ "results": [ { "is_free": true, "storage_bytes": ten_gib } ] });
        assert_eq!(free_plan_bytes(&wrapped), Some(ten_gib));

        // No free plan listed → nothing to judge against (fail open).
        let none = serde_json::json!([ { "code": "plus", "is_free": false, "storage_bytes": 999u64 } ]);
        assert_eq!(free_plan_bytes(&none), None);
    }
}
