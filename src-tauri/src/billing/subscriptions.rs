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
pub async fn get_subscription_data(state: tauri::State<'_, crate::app_state::AppState>, account_id: crate::app_state::SessionAccount) -> Result<SubscriptionData, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());

    // Parallel fetch
    let (active_result, plans_result) = tokio::join!(
        client.get::<serde_json::Value>("/api/billing/stripe/active-subscription/", &account_id),
        client.get::<serde_json::Value>("/api/billing/stripe/subscription-plans/", &account_id),
    );

    let active = active_result.unwrap_or(serde_json::json!({"has_subscription": false}));
    let plans_resp = plans_result.unwrap_or(serde_json::json!({"plans": [], "recommendation": ""}));

    let plans = plans_resp.get("plans").cloned().unwrap_or(serde_json::json!([]));
    let recommendation = plans_resp.get("recommendation").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Derive is_on_highest_plan
    let has_subscription = active.get("has_subscription").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let is_on_highest_plan = if has_subscription {
        let current_amount = active
            .get("subscription")
            .and_then(|s| s.get("amount"))
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let highest_amount = plans.as_array().map_or(0.0, |arr| {
            arr.iter()
                .filter_map(|p| p.get("amount").and_then(serde_json::Value::as_f64))
                .fold(0.0f64, f64::max)
        });
        current_amount >= highest_amount
    } else {
        false
    };

    Ok(SubscriptionData {
        active_subscription: active,
        plans,
        recommendation,
        is_on_highest_plan,
    })
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
