//! Stripe subscription management — plans, active sub, create, portal URL.

use crate::api::client::ApiClient;
use crate::error::AppError;
use serde::Serialize;
use tracing::info;

// ---------------------------------------------------------------------------
/// Combined subscription data: active subscription + available plans + derived flags.
///
/// Replaces the two-invoke orchestration in `useSubscriptionData.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionData {
    pub active_subscription: serde_json::Value,
    pub plans: serde_json::Value,
    pub recommendation: String,
    /// Whether the user is on the highest available plan (no upgrade possible).
    pub is_on_highest_plan: bool,
}

/// Fetch subscription data in a single call: active subscription + plans + derived flags.
#[tauri::command]
pub async fn get_subscription_data(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
) -> Result<SubscriptionData, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());

    // Parallel fetch
    let (active_result, plans_result) = tokio::join!(
        client.get::<serde_json::Value>("/api/billing/stripe/active-subscription/", &account_id),
        client.get::<serde_json::Value>("/api/billing/stripe/subscription-plans/", &account_id),
    );

    let active = active_result.unwrap_or(serde_json::json!({"has_subscription": false}));
    let plans_resp = plans_result.unwrap_or(serde_json::json!({"plans": [], "recommendation": ""}));
    Ok(assemble_subscription_data(active, plans_resp))
}

/// Combine the two billing payloads into the FE-facing shape.
///
/// `is_on_highest_plan` is false when there is no subscription **or** when
/// the plans list is empty/missing. An empty list is the fail-soft from a
/// failed plans fetch; treating `current >= 0` as "highest" would hide the
/// upgrade CTA while we do not actually know the catalog.
fn assemble_subscription_data(active: serde_json::Value, plans_resp: serde_json::Value) -> SubscriptionData {
    let plans = plans_resp.get("plans").cloned().unwrap_or(serde_json::json!([]));
    let recommendation = plans_resp.get("recommendation").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let has_subscription = active.get("has_subscription").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let is_on_highest_plan = has_subscription && current_meets_highest_plan(&active, &plans);

    SubscriptionData {
        active_subscription: active,
        plans,
        recommendation,
        is_on_highest_plan,
    }
}

fn current_meets_highest_plan(active: &serde_json::Value, plans: &serde_json::Value) -> bool {
    let Some(arr) = plans.as_array() else {
        return false;
    };
    if arr.is_empty() {
        return false;
    }
    let current_amount = active
        .get("subscription")
        .and_then(|s| s.get("amount"))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let highest_amount = arr
        .iter()
        .filter_map(|p| p.get("amount").and_then(serde_json::Value::as_f64))
        .fold(0.0f64, f64::max);
    current_amount >= highest_amount
}

/// Initiate a Stripe checkout session for a new subscription.
///
/// Returns a Stripe checkout URL that the frontend opens in the system browser.
#[tauri::command]
pub async fn create_subscription(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    price_id: String,
    success_url: Option<String>,
    cancel_url: Option<String>,
) -> Result<serde_json::Value, AppError> {
    info!(price_id = %price_id, "Creating subscription");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let body = serde_json::json!({
        "price_id": price_id,
        "success_url": success_url,
        "cancel_url": cancel_url,
    });
    Ok(client
        .post::<serde_json::Value, _>("/api/billing/stripe/create-subscription/", &body, &account_id)
        .await?)
}

/// Get a Stripe Customer Portal URL for managing an existing subscription.
#[tauri::command]
pub async fn get_customer_portal_url(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    return_url: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let body = serde_json::json!({ "return_url": return_url });
    Ok(client
        .post::<serde_json::Value, _>("/api/billing/stripe/customer-portal/", &body, &account_id)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::assemble_subscription_data;
    use serde_json::json;

    #[test]
    fn no_subscription_is_never_on_the_highest_plan() {
        let data = assemble_subscription_data(
            json!({"has_subscription": false}),
            json!({"plans": [{"amount": 10.0}], "recommendation": "pro"}),
        );
        assert!(!data.is_on_highest_plan);
        assert_eq!(data.recommendation, "pro");
    }

    #[test]
    fn current_amount_at_or_above_the_catalog_max_is_highest() {
        let data = assemble_subscription_data(
            json!({"has_subscription": true, "subscription": {"amount": 20.0}}),
            json!({"plans": [{"amount": 10.0}, {"amount": 20.0}]}),
        );
        assert!(data.is_on_highest_plan);
    }

    #[test]
    fn current_amount_below_the_catalog_max_is_not_highest() {
        let data = assemble_subscription_data(
            json!({"has_subscription": true, "subscription": {"amount": 10.0}}),
            json!({"plans": [{"amount": 10.0}, {"amount": 20.0}]}),
        );
        assert!(!data.is_on_highest_plan);
    }

    #[test]
    fn empty_or_missing_plans_never_claim_highest() {
        // Fail-soft from a failed plans fetch used to compare current >= 0 and
        // hide the upgrade CTA. An empty catalog is "we don't know", not "top tier".
        let empty = assemble_subscription_data(
            json!({"has_subscription": true, "subscription": {"amount": 20.0}}),
            json!({"plans": [], "recommendation": ""}),
        );
        assert!(!empty.is_on_highest_plan);

        let missing = assemble_subscription_data(json!({"has_subscription": true, "subscription": {"amount": 20.0}}), json!({}));
        assert!(!missing.is_on_highest_plan);
        assert_eq!(missing.plans, json!([]));
    }
}
