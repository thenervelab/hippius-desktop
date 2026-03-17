//! Billing, credits, and subscription commands.

use crate::api_client::{ApiClient, IndexerClient};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Credits & transactions (API)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_user_credits_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get::<serde_json::Value>("/api/billing/credits/balance/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_billing_transactions(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![("page", page_str.as_str()), ("limit", limit_str.as_str())];
    client
        .get_with_params::<serde_json::Value>("/api/billing/transactions/", &params, &account_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Stripe subscription
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_subscription_plans(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get::<serde_json::Value>(
            "/api/billing/stripe/subscription-plans/",
            &account_id,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_active_subscription(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get::<serde_json::Value>(
            "/api/billing/stripe/active-subscription/",
            &account_id,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_subscription(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    price_id: String,
    success_url: Option<String>,
    cancel_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let body = serde_json::json!({
        "price_id": price_id,
        "success_url": success_url,
        "cancel_url": cancel_url,
    });
    client
        .post::<serde_json::Value, _>(
            "/api/billing/stripe/create-subscription/",
            &body,
            &account_id,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_customer_portal_url(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    return_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let body = serde_json::json!({ "return_url": return_url });
    client
        .post::<serde_json::Value, _>(
            "/api/billing/stripe/customer-portal/",
            &body,
            &account_id,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_deposit_address(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get::<serde_json::Value>("/api/billing/substrate-address/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Indexer queries (credits, marketplace, balance history, events)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct IndexerResponse {
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[tauri::command]
pub async fn get_indexer_credits(
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    indexer
        .get::<serde_json::Value>("/credits/free-credits", &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_marketplace_credits(
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("event_name", "CreditsConsumed"),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    indexer
        .get::<serde_json::Value>("/marketplace/credit", &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_system_balance_history(
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(30).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    indexer
        .get::<serde_json::Value>("/system-account-balance", &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_balance_transfers(
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    indexer
        .get::<serde_json::Value>("/balance-transfers", &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_add_credit_events(
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("event_name", "MintedAccountCredits"),
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    indexer
        .get::<serde_json::Value>("/events", &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_files_size(
    account_id: String,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let limit_str = limit.unwrap_or(30).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("limit", limit_str.as_str()),
    ];
    indexer
        .get::<serde_json::Value>("/ipfs/user-total-files-size", &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_file_nodes(cid: String) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let params = vec![("cid", cid.as_str())];
    indexer
        .get::<serde_json::Value>("/files", &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_node_locations(
    page: Option<i64>,
    limit: Option<i64>,
    miner_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let indexer = IndexerClient::from_env().map_err(|e| e.to_string())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(1).to_string();
    let mut params = vec![
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    if let Some(ref id) = miner_id {
        params.push(("miner_id", id.as_str()));
    }
    indexer
        .get::<serde_json::Value>("/node-metrics", &params)
        .await
        .map_err(|e| e.to_string())
}
