//! Plan-aware storage overview for the home page's simple storage card.
//!
//! One IPC round-trip composing the two facts the card needs: bytes used
//! (the same indexer row `get_drive_storage_stats` reads) and the active
//! subscription's storage allowance. The allowance is derived from the
//! plan's `credits_per_billing` through the same pricing model every other
//! surface uses (`calculate_storage_capacity` — console ProHeader, desktop
//! PageHeader chip, plan cards), so the card can never disagree with the
//! "Active Plan" chip rendered beside it.
//!
//! Per product decision (2026-08-19): storage capacity comes from the
//! subscription plan ONLY — there is deliberately no credits-derived
//! fallback. No plan means the card shows its "No active plan" state.

use serde::Serialize;

use crate::api::client::ApiClient;
use crate::error::AppError;

/// Capacity math is decimal GB end-to-end (`calculate_storage_capacity`
/// returns SI GB; the FE formats with the SI `formatBytes`), so the GB→bytes
/// conversion must be SI too — 1e9, not 2^30.
const BYTES_PER_GB: u64 = 1_000_000_000;

/// Wire shape of the simple storage card. camelCase over IPC.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    /// Bytes currently stored in Drive (latest indexer snapshot).
    pub used_bytes: u64,
    /// Plan storage allowance in bytes; `0` when there is no active plan.
    pub total_bytes: u64,
    /// `used / total * 100`, clamped to `[0, 100]`; `0` when there is no
    /// plan. Clamped because over-quota is a real state (usage recorded
    /// before a downgrade) and the bar must not overflow.
    pub percent: f64,
    pub has_plan: bool,
    /// Human plan name (e.g. "Pro") when subscribed.
    pub plan_name: Option<String>,
}

/// Pure composition of the overview from its two inputs. `plan` is
/// `(plan_name, allowance_gb)` when an active subscription exists.
fn build_overview(used_bytes: u64, plan: Option<(String, u64)>) -> StorageOverview {
    match plan {
        Some((plan_name, plan_gb)) => {
            let total_bytes = plan_gb.saturating_mul(BYTES_PER_GB);
            let percent = if total_bytes > 0 {
                ((used_bytes as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
            StorageOverview {
                used_bytes,
                total_bytes,
                percent,
                has_plan: true,
                plan_name: Some(plan_name),
            }
        }
        None => StorageOverview {
            used_bytes,
            total_bytes: 0,
            percent: 0.0,
            has_plan: false,
            plan_name: None,
        },
    }
}

/// Extract `(plan_name, allowance_gb)` from the active-subscription payload,
/// or `None` when the account has no usable subscription. Fail-soft by
/// design: a malformed or missing field reads as "no plan", mirroring
/// `get_subscription_data`'s `unwrap_or` posture.
fn plan_from_subscription(active: &serde_json::Value) -> Option<(String, u64)> {
    if !active.get("has_subscription").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    let sub = active.get("subscription")?;
    let credits_per_billing = sub.get("credits_per_billing").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    if credits_per_billing <= 0.0 {
        return None;
    }
    let plan_name = sub.get("plan_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let gb = crate::billing::charts::calculate_storage_capacity(vec![credits_per_billing])
        .into_iter()
        .next()
        .map_or(0, |info| info.storage_gb);
    Some((plan_name, gb))
}

/// Fetch the storage overview for the home page's storage card.
///
/// # Errors
///
/// Returns [`AppError`] when the indexer used-bytes read fails — the card
/// must not render a confident "0 B used" over an outage. A failed
/// subscription fetch, by contrast, degrades to `has_plan: false` (the same
/// fail-soft posture as `get_subscription_data`).
#[tauri::command]
pub async fn get_storage_overview(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
) -> Result<StorageOverview, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());

    let (stats_result, active_result) = tokio::join!(
        crate::billing::queries::fetch_drive_storage_stats(state.inner(), account_id.as_str()),
        client.get::<serde_json::Value>("/api/billing/stripe/active-subscription/", &account_id),
    );

    let stats = stats_result?;
    let active = active_result.unwrap_or_else(|_| serde_json::json!({ "has_subscription": false }));

    Ok(build_overview(stats.total_bytes, plan_from_subscription(&active)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_plan_yields_empty_totals() {
        let overview = build_overview(42, None);
        assert!(!overview.has_plan);
        assert_eq!(overview.used_bytes, 42);
        assert_eq!(overview.total_bytes, 0);
        assert_eq!(overview.percent, 0.0);
        assert_eq!(overview.plan_name, None);
    }

    #[test]
    fn plan_percent_is_used_over_total() {
        // 300 GB of 1000 GB → 30%.
        let overview = build_overview(300 * BYTES_PER_GB, Some(("Pro".into(), 1000)));
        assert!(overview.has_plan);
        assert_eq!(overview.total_bytes, 1000 * BYTES_PER_GB);
        assert!((overview.percent - 30.0).abs() < 1e-9);
        assert_eq!(overview.plan_name.as_deref(), Some("Pro"));
    }

    #[test]
    fn over_quota_clamps_to_100() {
        // Usage above the allowance (downgrade case) must not overflow the bar.
        let overview = build_overview(2000 * BYTES_PER_GB, Some(("Solo".into(), 1000)));
        assert_eq!(overview.percent, 100.0);
        // Raw byte counts stay honest even while the percent clamps.
        assert_eq!(overview.used_bytes, 2000 * BYTES_PER_GB);
    }

    #[test]
    fn zero_gb_plan_does_not_divide_by_zero() {
        let overview = build_overview(500, Some(("Broken".into(), 0)));
        assert!(overview.has_plan);
        assert_eq!(overview.total_bytes, 0);
        assert_eq!(overview.percent, 0.0);
    }

    #[test]
    fn subscription_payload_maps_to_plan() {
        let active = serde_json::json!({
            "has_subscription": true,
            "subscription": { "plan_name": "Pro", "credits_per_billing": 5.0 }
        });
        let plan = plan_from_subscription(&active).expect("plan expected");
        assert_eq!(plan.0, "Pro");
        // 5 credits/month buys well over 1 TB under the current pricing
        // model (~0.003 credits per GB-month); pin a loose lower bound so a
        // pricing tweak doesn't break the test, while a unit slip (GB→MB)
        // still fails loudly.
        assert!(plan.1 > 1000, "expected > 1000 GB for 5 credits, got {}", plan.1);
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
