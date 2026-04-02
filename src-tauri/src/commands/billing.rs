//! Billing, credits, and subscription commands.
//!
//! Thin IPC wrappers that delegate to [`crate::api_client::ApiClient`] (for
//! authenticated Hippius API calls) and [`crate::api_client::IndexerClient`]
//! (for public blockchain indexer queries). Each command maps 1:1 to a
//! frontend billing page feature — credit balance, transaction history,
//! Stripe subscriptions, deposit addresses, storage metrics, and node locations.

use crate::api_client::{ApiClient, IndexerClient};
use crate::error::AppError;
use tracing::info;

// ---------------------------------------------------------------------------
// Credits & transactions (API)
// ---------------------------------------------------------------------------

/// Fetch the current marketplace credit balance for an account.
#[tauri::command]
pub async fn get_user_credits_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.pool()?.clone());
    Ok(client.get::<serde_json::Value>("/api/billing/credits/balance/", &account_id).await?)
}

/// Fetch paginated billing transaction history for an account.
#[tauri::command]
pub async fn get_billing_transactions(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.pool()?.clone());
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![("page", page_str.as_str()), ("limit", limit_str.as_str())];
    Ok(client
        .get_with_params::<serde_json::Value>("/api/billing/transactions/", &params, &account_id)
        .await?)
}

// ---------------------------------------------------------------------------
// Stripe subscription
// ---------------------------------------------------------------------------

/// Fetch available Stripe subscription plans.
#[tauri::command]
pub async fn get_subscription_plans(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.pool()?.clone());
    Ok(client
        .get::<serde_json::Value>("/api/billing/stripe/subscription-plans/", &account_id)
        .await?)
}

/// Fetch the user's currently active Stripe subscription, if any.
#[tauri::command]
pub async fn get_active_subscription(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.pool()?.clone());
    Ok(client
        .get::<serde_json::Value>("/api/billing/stripe/active-subscription/", &account_id)
        .await?)
}

/// Initiate a Stripe checkout session for a new subscription.
///
/// Returns a Stripe checkout URL that the frontend opens in the system browser.
#[tauri::command]
pub async fn create_subscription(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    price_id: String,
    success_url: Option<String>,
    cancel_url: Option<String>,
) -> Result<serde_json::Value, AppError> {
    info!(price_id = %price_id, "Creating subscription");
    let client = ApiClient::new(state.pool()?.clone());
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
    account_id: String,
    return_url: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.pool()?.clone());
    let body = serde_json::json!({ "return_url": return_url });
    Ok(client
        .post::<serde_json::Value, _>("/api/billing/stripe/customer-portal/", &body, &account_id)
        .await?)
}

/// Fetch the on-chain deposit address for adding credits via Substrate transfer.
#[tauri::command]
pub async fn get_deposit_address(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.pool()?.clone());
    Ok(client.get::<serde_json::Value>("/api/billing/substrate-address/", &account_id).await?)
}

// ---------------------------------------------------------------------------
// Indexer queries (credits, marketplace, balance history, events)
// ---------------------------------------------------------------------------

/// Fetch free credit allocations from the blockchain indexer.
#[tauri::command]
pub async fn get_indexer_credits(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    Ok(indexer.get::<serde_json::Value>("/credits/free-credits", &params).await?)
}

/// Fetch marketplace credit consumption events (`CreditsConsumed`) from the indexer.
#[tauri::command]
pub async fn get_marketplace_credits(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("event_name", "CreditsConsumed"),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    Ok(indexer.get::<serde_json::Value>("/marketplace/credit", &params).await?)
}

/// Fetch historical system account balance snapshots for charting.
#[tauri::command]
pub async fn get_system_balance_history(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(30).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    Ok(indexer.get::<serde_json::Value>("/system-account-balance", &params).await?)
}

/// Fetch balance transfer events (both sent and received) from the indexer.
#[tauri::command]
pub async fn get_balance_transfers(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    Ok(indexer.get::<serde_json::Value>("/balance-transfers", &params).await?)
}

/// Fetch `MintedAccountCredits` events (credit top-ups) from the indexer.
#[tauri::command]
pub async fn get_add_credit_events(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("event_name", "MintedAccountCredits"),
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    Ok(indexer.get::<serde_json::Value>("/events", &params).await?)
}

/// Fetch total file size stored by an account over a time window.
#[tauri::command]
pub async fn get_files_size(account_id: String, days_ago: Option<i64>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let days_str = days_ago.unwrap_or(30).to_string();
    let params = vec![("account_id", account_id.as_str()), ("days_ago", days_str.as_str())];
    Ok(indexer.get::<serde_json::Value>("/user-total-file-size", &params).await?)
}

/// Fetch total file count for an account over a time window.
#[tauri::command]
pub async fn get_files_count(account_id: String, days_ago: Option<i64>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let days_str = days_ago.unwrap_or(30).to_string();
    let params = vec![("account_id", account_id.as_str()), ("days_ago", days_str.as_str())];
    Ok(indexer.get::<serde_json::Value>("/user-total-files-count", &params).await?)
}

/// Look up which storage miner nodes hold a specific CID.
#[tauri::command]
pub async fn get_file_nodes(cid: String) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let params = vec![("cid", cid.as_str())];
    Ok(indexer.get::<serde_json::Value>("/files", &params).await?)
}

/// Fetch node metric data (location, uptime) for the network map.
#[tauri::command]
pub async fn get_node_locations(page: Option<i64>, limit: Option<i64>, miner_id: Option<String>) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(1).to_string();
    let mut params = vec![("page", page_str.as_str()), ("limit", limit_str.as_str())];
    if let Some(ref id) = miner_id {
        params.push(("miner_id", id.as_str()));
    }
    Ok(indexer.get::<serde_json::Value>("/node-metrics", &params).await?)
}
