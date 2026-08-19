//! Plan/credits-aware overview for the home page's two small cards and the
//! top-bar "Active Plan" chip.
//!
//! One IPC round-trip composing three facts: bytes used (the same indexer
//! row `get_drive_storage_stats` reads), the active subscription, and the
//! credit balance. The **capacity-source priority chain lives HERE, once**:
//!
//!   1. active subscription → capacity is the plan's allowance
//!   2. else credits > 0    → capacity is `used + credits-buyable storage`
//!      (the mobile app's original hybrid: the balance prices the *free*
//!      space, so what's already stored still counts toward the total)
//!   3. else                → no capacity to plot ("No active plan")
//!
//! Every consumer (storage card, plan card, top-bar chip) renders from this
//! single decision, so the surfaces can never disagree about whether the
//! user is "on a plan" or "on credits". Allowances are derived from
//! credit amounts through the same pricing model every other surface uses
//! (`calculate_storage_capacity` — console ProHeader, plan cards).

use serde::Serialize;

use crate::api::client::ApiClient;
use crate::error::AppError;

/// Capacity math is decimal GB end-to-end (`calculate_storage_capacity`
/// returns SI GB; the FE formats with the SI `formatBytes`), so the GB→bytes
/// conversion must be SI too — 1e9, not 2^30.
const BYTES_PER_GB: u64 = 1_000_000_000;

/// Which source won the capacity decision. Lowercase on the wire.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum CapacitySource {
    Subscription,
    Credits,
    None,
}

/// Active-plan facts for the plan card / top-bar chip. camelCase over IPC.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    /// Human plan name (e.g. "Pro"); may be empty if the API omits it.
    pub name: String,
    /// Price per billing interval, in the plan's currency unit.
    pub amount: f64,
    /// Billing interval as the API reports it (e.g. "month", "year").
    pub interval: String,
    /// The plan's storage allowance in bytes.
    pub storage_bytes: u64,
}

/// Wire shape of the home overview. camelCase over IPC.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    /// Bytes currently stored in Drive (latest indexer snapshot).
    pub used_bytes: u64,
    /// Effective capacity in bytes per the priority chain; `0` for `None`.
    pub total_bytes: u64,
    /// `used / total * 100`, clamped to `[0, 100]`; `0` when no capacity.
    /// Clamped because over-quota is a real state (usage recorded before a
    /// downgrade) and the bar must not overflow.
    pub percent: f64,
    pub source: CapacitySource,
    /// Present when `source == Subscription`.
    pub plan: Option<PlanInfo>,
    /// Pre-formatted HIP credit balance (from `planck_to_hip`, the single
    /// credit formatter). Present whenever the balance fetch succeeded, so
    /// the plan card can show it even alongside a subscription if design
    /// ever wants to.
    pub credits_hip: Option<String>,
}

/// Pure composition of the overview from its three inputs.
///
/// `credits` is the balance in HIP units; `credits_capacity_gb` is what that
/// balance buys per month (pre-computed by the caller so this stays pure and
/// unit-testable without the pricing binary search).
fn build_overview(used_bytes: u64, plan: Option<PlanInfo>, credits: f64, credits_capacity_gb: u64, credits_hip: Option<String>) -> StorageOverview {
    if let Some(plan) = plan {
        let total_bytes = plan.storage_bytes;
        let percent = percent_of(used_bytes, total_bytes);
        return StorageOverview {
            used_bytes,
            total_bytes,
            percent,
            source: CapacitySource::Subscription,
            plan: Some(plan),
            credits_hip,
        };
    }
    if credits > 0.0 {
        // The balance prices what can still be stored, so capacity is
        // used + buyable — matching the mobile app's original hybrid.
        let total_bytes = used_bytes.saturating_add(credits_capacity_gb.saturating_mul(BYTES_PER_GB));
        let percent = percent_of(used_bytes, total_bytes);
        return StorageOverview {
            used_bytes,
            total_bytes,
            percent,
            source: CapacitySource::Credits,
            plan: None,
            credits_hip,
        };
    }
    StorageOverview {
        used_bytes,
        total_bytes: 0,
        percent: 0.0,
        source: CapacitySource::None,
        plan: None,
        credits_hip,
    }
}

fn percent_of(used: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    ((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
}

/// Extract [`PlanInfo`] from the active-subscription payload, or `None` when
/// the account has no usable subscription. Fail-soft by design: a malformed
/// or missing field reads as "no plan" (the priority chain then falls to
/// credits), mirroring `get_subscription_data`'s `unwrap_or` posture.
fn plan_from_subscription(active: &serde_json::Value) -> Option<PlanInfo> {
    if !active.get("has_subscription").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    let sub = active.get("subscription")?;
    let credits_per_billing = sub.get("credits_per_billing").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    if credits_per_billing <= 0.0 {
        return None;
    }
    Some(PlanInfo {
        name: sub.get("plan_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        amount: sub.get("amount").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        interval: sub.get("interval").and_then(|v| v.as_str()).unwrap_or("month").to_string(),
        storage_bytes: capacity_gb_for_credits(credits_per_billing).saturating_mul(BYTES_PER_GB),
    })
}

/// GB purchasable per month for a credit amount, via the canonical pricing
/// model (`calculate_storage_capacity`'s binary search).
fn capacity_gb_for_credits(credits: f64) -> u64 {
    if credits <= 0.0 {
        return 0;
    }
    crate::billing::charts::calculate_storage_capacity(vec![credits])
        .into_iter()
        .next()
        .map_or(0, |info| info.storage_gb)
}

/// Fetch the storage/plan overview for the home page and top-bar chip.
///
/// # Errors
///
/// Returns [`AppError`] when the indexer used-bytes read fails — the card
/// must not render a confident "0 B used" over an outage. The subscription
/// and credit fetches, by contrast, degrade softly (no plan / no credits):
/// each alone is a display concern, and the priority chain still resolves.
#[tauri::command]
pub async fn get_storage_overview(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
) -> Result<StorageOverview, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());

    let (stats_result, active_result, credits_result) = tokio::join!(
        crate::billing::queries::fetch_drive_storage_stats(state.inner(), account_id.as_str()),
        client.get::<serde_json::Value>("/api/billing/stripe/active-subscription/", &account_id),
        crate::billing::credits::fetch_credit_balance_planck(state.inner(), &account_id),
    );

    let stats = stats_result?;
    let active = active_result.unwrap_or_else(|_| serde_json::json!({ "has_subscription": false }));

    let credits_hip = credits_result.ok().map(|planck| crate::blockchain::convert::planck_to_hip(&planck));
    // The display string is plain decimal ("1.5"), so it parses directly;
    // an absent/unparseable balance reads as 0 → the chain falls to None.
    let credits: f64 = credits_hip.as_deref().and_then(|hip| hip.parse().ok()).unwrap_or(0.0);

    let plan = plan_from_subscription(&active);
    // Only price the credits capacity when it can win the chain — the
    // binary search is cheap, but skipping it keeps the plan path lean.
    let credits_capacity_gb = if plan.is_none() { capacity_gb_for_credits(credits) } else { 0 };

    Ok(build_overview(stats.total_bytes, plan, credits, credits_capacity_gb, credits_hip))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pro_plan(gb: u64) -> PlanInfo {
        PlanInfo {
            name: "Pro".into(),
            amount: 5.0,
            interval: "month".into(),
            storage_bytes: gb * BYTES_PER_GB,
        }
    }

    #[test]
    fn subscription_wins_over_credits() {
        // 300 GB of a 1000 GB plan → 30%, even with a fat credit balance.
        let overview = build_overview(300 * BYTES_PER_GB, Some(pro_plan(1000)), 500.0, 999_999, Some("500".into()));
        assert_eq!(overview.source, CapacitySource::Subscription);
        assert_eq!(overview.total_bytes, 1000 * BYTES_PER_GB);
        assert!((overview.percent - 30.0).abs() < 1e-9);
        assert_eq!(overview.plan.as_ref().map(|p| p.name.as_str()), Some("Pro"));
        // Credits still ride along for display.
        assert_eq!(overview.credits_hip.as_deref(), Some("500"));
    }

    #[test]
    fn credits_capacity_is_used_plus_buyable() {
        // 100 GB stored, credits buy 300 GB → total 400 GB, 25% used.
        let overview = build_overview(100 * BYTES_PER_GB, None, 1.0, 300, Some("1".into()));
        assert_eq!(overview.source, CapacitySource::Credits);
        assert_eq!(overview.total_bytes, 400 * BYTES_PER_GB);
        assert!((overview.percent - 25.0).abs() < 1e-9);
        assert_eq!(overview.plan, None);
    }

    #[test]
    fn no_plan_no_credits_yields_none() {
        let overview = build_overview(42, None, 0.0, 0, Some("0".into()));
        assert_eq!(overview.source, CapacitySource::None);
        assert_eq!(overview.used_bytes, 42);
        assert_eq!(overview.total_bytes, 0);
        assert!(overview.percent.abs() < 1e-9);
    }

    #[test]
    fn over_quota_clamps_to_100() {
        // Usage above the allowance (downgrade case) must not overflow the bar.
        let overview = build_overview(2000 * BYTES_PER_GB, Some(pro_plan(1000)), 0.0, 0, None);
        assert!((overview.percent - 100.0).abs() < 1e-9);
        // Raw byte counts stay honest even while the percent clamps.
        assert_eq!(overview.used_bytes, 2000 * BYTES_PER_GB);
    }

    #[test]
    fn credits_that_buy_nothing_still_count_as_credits() {
        // A dust balance prices 0 extra GB: total == used → a full bar,
        // which is the honest reading ("you can't store more on this").
        let overview = build_overview(500, None, 0.0001, 0, Some("0.0001".into()));
        assert_eq!(overview.source, CapacitySource::Credits);
        assert_eq!(overview.total_bytes, 500);
        assert!((overview.percent - 100.0).abs() < 1e-9);
    }

    #[test]
    fn zero_gb_plan_does_not_divide_by_zero() {
        let overview = build_overview(500, Some(pro_plan(0)), 0.0, 0, None);
        assert_eq!(overview.source, CapacitySource::Subscription);
        assert_eq!(overview.total_bytes, 0);
        assert!(overview.percent.abs() < 1e-9);
    }

    #[test]
    fn subscription_payload_maps_to_plan() {
        let active = serde_json::json!({
            "has_subscription": true,
            "subscription": {
                "plan_name": "Pro",
                "credits_per_billing": 5.0,
                "amount": 12.0,
                "interval": "month"
            }
        });
        let plan = plan_from_subscription(&active).expect("plan expected");
        assert_eq!(plan.name, "Pro");
        assert!((plan.amount - 12.0).abs() < 1e-9);
        assert_eq!(plan.interval, "month");
        // 5 credits/month buys well over 1 TB under the current pricing
        // model (~0.003 credits per GB-month); pin a loose lower bound so a
        // pricing tweak doesn't break the test, while a unit slip (GB→MB or
        // a missing 1e9) still fails loudly.
        assert!(
            plan.storage_bytes > 1000 * BYTES_PER_GB,
            "expected > 1 TB for 5 credits, got {}",
            plan.storage_bytes
        );
    }

    #[test]
    fn missing_or_inactive_subscription_maps_to_none() {
        assert_eq!(plan_from_subscription(&serde_json::json!({ "has_subscription": false })), None);
        assert_eq!(plan_from_subscription(&serde_json::json!({})), None);
        // has_subscription true but no subscription object → fail-soft None.
        assert_eq!(plan_from_subscription(&serde_json::json!({ "has_subscription": true })), None);
        // Zero credits_per_billing cannot price an allowance.
        assert_eq!(
            plan_from_subscription(&serde_json::json!({
                "has_subscription": true,
                "subscription": { "plan_name": "X", "credits_per_billing": 0.0 }
            })),
            None
        );
    }
}
