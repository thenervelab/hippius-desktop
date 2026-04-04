//! Billing API proxy queries and UI-ready transforms.
//!
//! Thin wrappers around Hippius API and indexer endpoints, plus
//! typed/bucketed transforms for the frontend billing page.

use crate::api::client::ApiClient;
use crate::api::indexer::IndexerClient;
use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;

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

// ---------------------------------------------------------------------------
// UI-ready typed commands (replace frontend select callbacks)
// ---------------------------------------------------------------------------

/// Normalize a timestamp — API sometimes sends seconds instead of milliseconds.
fn unit_safe_ms(t: i64) -> i64 {
    if t < 1_000_000_000_000 { t * 1000 } else { t }
}

/// Parse an ISO timestamp string to epoch milliseconds.
fn parse_iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").map(|n| n.and_utc().fixed_offset()))
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Get the best timestamp for a row (prefer processed_timestamp over numeric).
fn best_timestamp(processed: Option<&str>, numeric: i64) -> i64 {
    processed.and_then(parse_iso_ms).unwrap_or_else(|| unit_safe_ms(numeric))
}

/// Build a local date key (YYYY-MM-DD) from epoch milliseconds using UTC.
fn day_key(ms: i64) -> String {
    let dt = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default();
    dt.format("%Y-%m-%d").to_string()
}

// ── Credits (deduplicated, day-bucketed) ────────────────────────────────

/// UI-ready credit data point, deduplicated to latest per day.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditObject {
    pub id: String,
    pub block: i64,
    pub amount: String,
    pub account_id: String,
    pub date: String,
}

/// Fetch credits from the indexer, deduplicate to latest-per-day, and return
/// UI-ready objects. Replaces the `select` callback in `useCredits.ts`.
#[tauri::command]
pub async fn get_credits_ui(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<Vec<CreditObject>, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(100_000).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: serde_json::Value = indexer.get("/credits/free-credits", &params).await?;
    let rows = resp.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();

    // Deduplicate: keep latest entry per day
    let mut by_day: HashMap<String, (i64, &serde_json::Value)> = HashMap::new();
    for row in &rows {
        let ts = best_timestamp(
            row.get("processed_timestamp").and_then(|v| v.as_str()),
            row.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0),
        );
        let key = day_key(ts);
        let entry = by_day.entry(key).or_insert((ts, row));
        if ts > entry.0 {
            *entry = (ts, row);
        }
    }

    // Sort by recency
    let mut deduped: Vec<_> = by_day.into_values().collect();
    deduped.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(deduped
        .into_iter()
        .map(|(ts, row)| CreditObject {
            id: row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            block: row.get("block_number").and_then(|v| v.as_i64()).unwrap_or(0),
            amount: row.get("credits").and_then(|v| v.as_str()).unwrap_or("0").to_string(),
            account_id: row.get("account_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            date: chrono::DateTime::from_timestamp_millis(ts).map(|d| d.to_rfc3339()).unwrap_or_default(),
        })
        .collect())
}

// ── System balance (deduplicated, day-bucketed) ─────────────────────────

/// UI-ready balance data point, deduplicated to latest per day.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceObject {
    pub account_id: String,
    pub block_number: i64,
    pub free_balance: String,
    pub total_balance: String,
    pub timestamp: String,
}

/// Fetch balance history, deduplicate to latest-per-day, return UI-ready.
/// Replaces the `select` callback in `useSystemBalance.ts`.
#[tauri::command]
pub async fn get_system_balance_ui(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<Vec<BalanceObject>, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(20_000).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: serde_json::Value = indexer.get("/system-account-balance", &params).await?;
    let rows = resp.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();

    let mut by_day: HashMap<String, (i64, &serde_json::Value)> = HashMap::new();
    for row in &rows {
        let ts = best_timestamp(
            row.get("processed_timestamp").and_then(|v| v.as_str()),
            row.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0),
        );
        let key = day_key(ts);
        let entry = by_day.entry(key).or_insert((ts, row));
        if ts > entry.0 {
            *entry = (ts, row);
        }
    }

    let mut deduped: Vec<_> = by_day.into_values().collect();
    deduped.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(deduped
        .into_iter()
        .map(|(ts, row)| {
            let free = row.get("free_balance").and_then(|v| v.as_str()).unwrap_or("0").to_string();
            BalanceObject {
                account_id: row.get("account_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                block_number: row.get("block_number").and_then(|v| v.as_i64()).unwrap_or(0),
                free_balance: free.clone(),
                total_balance: free,
                timestamp: chrono::DateTime::from_timestamp_millis(ts).map(|d| d.to_rfc3339()).unwrap_or_default(),
            }
        })
        .collect())
}

// ── Balance transfers (parsed amounts, composite IDs) ───────────────────

/// UI-ready balance transfer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferObject {
    pub id: String,
    pub block: i64,
    pub amount: f64,
    pub from: String,
    pub to: String,
    pub date: String,
    /// "Sent", "Received", or "-" based on the querying account.
    pub direction: String,
}

/// Fetch balance transfers with parsed amounts and composite IDs.
/// Replaces the `select` callback in `useBalanceTransactions.ts`.
#[tauri::command]
pub async fn get_balance_transfers_ui(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<Vec<TransferObject>, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: serde_json::Value = indexer.get("/balance-transfers", &params).await?;
    let rows = resp.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();

    Ok(rows
        .iter()
        .map(|row| {
            let block = row.get("block_number").and_then(|v| v.as_i64()).unwrap_or(0);
            let event_idx = row.get("event_index").and_then(|v| v.as_i64()).unwrap_or(0);
            let from = row.get("from_account").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let to = row.get("to_account").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let direction = if from == account_id {
                "Sent"
            } else if to == account_id {
                "Received"
            } else {
                "-"
            }
            .to_string();
            TransferObject {
                id: format!("{block}-{event_idx}"),
                block,
                amount: row
                    .get("amount")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0),
                from,
                to,
                date: row.get("processed_timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                direction,
            }
        })
        .collect())
}

// ── Billing transactions (payment type classified) ──────────────────────

/// UI-ready billing transaction. Field names match existing frontend table columns.
#[derive(Serialize)]
pub struct BillingTransactionObject {
    pub id: i64,
    pub transaction_type: String,
    pub amount: f64,
    pub transaction_date: String,
    pub status: String,
}

/// Fetch billing transactions with payment type classified.
/// Replaces the `select` callback in `useBillingTransactions.ts`.
#[tauri::command]
pub async fn get_billing_transactions_ui(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<BillingTransactionObject>, AppError> {
    let client = ApiClient::new(state.pool()?.clone());
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![("page", page_str.as_str()), ("limit", limit_str.as_str())];
    let resp: serde_json::Value = client.get_with_params("/api/billing/transactions/", &params, &account_id).await?;

    let results = resp.get("results").and_then(|r| r.as_array()).cloned().unwrap_or_default();

    Ok(results
        .iter()
        .map(|t| {
            let payment_type = t.get("payment_type").and_then(|v| v.as_str()).unwrap_or("");
            let tx_type = if payment_type.to_lowercase().contains("stripe") { "card" } else { "tao" };
            let amount = t
                .get("amount")
                .map(|v| {
                    if let Some(s) = v.as_str() {
                        s.parse::<f64>().unwrap_or(0.0)
                    } else {
                        v.as_f64().unwrap_or(0.0)
                    }
                })
                .unwrap_or(0.0);

            BillingTransactionObject {
                id: t.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                transaction_type: tx_type.to_string(),
                amount,
                transaction_date: t.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                status: t.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }
        })
        .collect())
}

// ── Credit events (field remapped) ──────────────────────────────────────

/// UI-ready credit event.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditEventObject {
    pub id: i64,
    pub block_number: i64,
    pub amount: String,
    pub account_id: String,
    pub timestamp: String,
    pub hash: String,
}

/// Fetch credit events with fields remapped for the UI.
/// Replaces the `select` callback in `useAddCreditEvent.ts`.
#[tauri::command]
pub async fn get_add_credit_events_ui(account_id: String, page: Option<i64>, limit: Option<i64>) -> Result<Vec<CreditEventObject>, AppError> {
    let indexer = IndexerClient::from_env()?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("event_name", "MintedAccountCredits"),
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: serde_json::Value = indexer.get("/events", &params).await?;
    let events = resp.get("events").and_then(|e| e.as_array()).cloned().unwrap_or_default();

    Ok(events
        .iter()
        .map(|e| CreditEventObject {
            id: e.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
            block_number: e.get("block_number").and_then(|v| v.as_i64()).unwrap_or(0),
            amount: e
                .get("event_data")
                .and_then(|d| d.get("amount"))
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string(),
            account_id: e.get("account_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            timestamp: e.get("processed_timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            hash: e.get("extrinsic_hash").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
        .collect())
}
