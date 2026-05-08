//! Billing API proxy queries and UI-ready transforms.
//!
//! Thin wrappers around Hippius API and indexer endpoints, plus
//! typed/bucketed transforms for the frontend billing page.

use crate::api::client::ApiClient;
use crate::api::indexer::IndexerClient;
use crate::error::AppError;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Hard cap on indexer `limit` query-param values for chart endpoints.
///
/// The downstream dedup-by-day pipeline collapses any practical range
/// (longest is "all-time", which is ≤ 2 years × 365 days = 730 daily
/// points) to a small fixed-size series. 2000 covers that with margin.
/// Server-side clamp lives here, not in the FE — see CLAUDE.md
/// "Business logic MUST live in the Rust backend."
const INDEXER_MAX_LIMIT: i64 = 2000;

// ---------------------------------------------------------------------------
// Typed response structs for indexer API deserialization
// ---------------------------------------------------------------------------

/// Generic wrapper for indexer API responses that use a `data` array.
#[derive(Deserialize)]
struct IndexerResponse<T> {
    #[serde(default)]
    data: Vec<T>,
}

/// Row from the credits endpoint (`/credits/free-credits`).
#[derive(Deserialize, Default)]
struct CreditRow {
    id: Option<String>,
    block_number: Option<i64>,
    credits: Option<String>,
    account_id: Option<String>,
    processed_timestamp: Option<String>,
    #[serde(default)]
    timestamp: i64,
}

/// Row from the system balance endpoint (`/system-account-balance`).
#[derive(Deserialize, Default)]
struct BalanceRow {
    account_id: Option<String>,
    free_balance: Option<String>,
    processed_timestamp: Option<String>,
    #[serde(default)]
    block_number: i64,
    #[serde(default)]
    timestamp: i64,
}

/// Row from the balance transfers endpoint (`/balance-transfers`).
#[derive(Deserialize, Default)]
struct TransferRow {
    from_account: Option<String>,
    to_account: Option<String>,
    amount: Option<String>,
    block_number: Option<i64>,
    event_index: Option<i64>,
    processed_timestamp: Option<String>,
}

/// Nested event data within a credit event row.
#[derive(Deserialize)]
struct EventData {
    amount: Option<String>,
}

/// Row from the events endpoint (e.g. `MintedAccountCredits`).
#[derive(Deserialize)]
struct CreditEventRow {
    id: Option<i64>,
    block_number: Option<i64>,
    event_data: Option<EventData>,
    account_id: Option<String>,
    processed_timestamp: Option<String>,
    extrinsic_hash: Option<String>,
}

/// Wrapper for the events endpoint which uses `events` instead of `data`.
#[derive(Deserialize)]
struct EventsResponse {
    #[serde(default)]
    events: Vec<CreditEventRow>,
}

/// Row from the billing transactions endpoint (`/api/billing/transactions/`).
///
/// `id` is `Option<serde_json::Value>` rather than `Option<i64>` because the
/// billing API returns UUID strings (e.g. "4b05fe16-2e49-4042-bc86-643e2504e132")
/// in some environments. Using `Value` tolerates both integers and strings and
/// avoids a JSON parse error that would silently drop the entire response.
#[derive(Deserialize)]
struct BillingTransactionRow {
    id: Option<serde_json::Value>,
    payment_type: Option<String>,
    amount: Option<serde_json::Value>,
    created_at: Option<String>,
    status: Option<String>,
}

/// Wrapper for the billing transactions endpoint which uses `results`.
#[derive(Deserialize)]
struct BillingTransactionsResponse {
    #[serde(default)]
    results: Vec<BillingTransactionRow>,
}

/// Row from the marketplace credits endpoint (`/marketplace/credit`).
#[derive(Deserialize)]
struct MarketplaceCreditRow {
    block_number: Option<i64>,
    event_index: Option<i64>,
    account_id: Option<String>,
    event_name: Option<String>,
    /// Raw integer string in 10^-18 units — converted before returning to the FE.
    credits_amount: Option<String>,
    transaction_type: Option<String>,
    processed_timestamp: Option<String>,
}

/// Wrapper for marketplace credits response which uses `events`.
#[derive(Deserialize)]
struct MarketplaceCreditsApiResponse {
    #[serde(default)]
    events: Vec<MarketplaceCreditRow>,
}

/// UI-ready marketplace credit event sent to the frontend.
///
/// `credits_amount` is already converted from raw 10^-18 units to a
/// human-readable decimal string (e.g. "13.0115" instead of "13011545100000000000").
#[derive(Serialize)]
struct MarketplaceCreditEventObject {
    block_number: i64,
    event_index: i64,
    account_id: String,
    event_name: String,
    credits_amount: String,
    transaction_type: Option<String>,
    processed_timestamp: String,
}

/// Wrapper matching the shape the frontend hook expects (`{ events: [...] }`).
#[derive(Serialize)]
pub struct MarketplaceCreditsResult {
    events: Vec<MarketplaceCreditEventObject>,
}

/// Convert a raw credits_amount string (in 10^-18 units) to a 4-decimal display string.
///
/// Uses `u128` arithmetic to avoid floating-point rounding on large integers.
/// Falls back to `f64` for non-integer strings (e.g. already-divided values).
fn credits_raw_to_display(raw: &str) -> String {
    let s = raw.trim();
    if let Ok(val) = s.parse::<u128>() {
        const DIVISOR: u128 = 1_000_000_000_000_000_000; // 10^18
        let whole = val / DIVISOR;
        let frac = val % DIVISOR;
        // Keep 4 decimal places: drop the last 14 digits of the 18-digit fraction.
        let frac_4 = frac / 100_000_000_000_000u128;
        format!("{whole}.{frac_4:04}")
    } else {
        s.parse::<f64>()
            .map(|v| format!("{:.4}", v / 1e18))
            .unwrap_or_else(|_| "0.0000".to_string())
    }
}

/// Fetch the on-chain deposit address for adding credits via Substrate transfer.
#[tauri::command]
pub async fn get_deposit_address(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    Ok(client.get::<serde_json::Value>("/api/billing/substrate-address/", &account_id).await?)
}

// ---------------------------------------------------------------------------
// Indexer queries (credits, marketplace, balance history, events)
// ---------------------------------------------------------------------------

/// Fetch marketplace credit consumption events (`CreditsConsumed`) from the indexer.
///
/// `credits_amount` is converted from raw 10^-18 units to a human-readable
/// decimal string before returning — the raw integer is too large for JS `Number`
/// and would display as scientific notation or lose precision.
#[tauri::command]
pub async fn get_marketplace_credits(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<MarketplaceCreditsResult, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(INDEXER_MAX_LIMIT).min(INDEXER_MAX_LIMIT).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("event_name", "CreditsConsumed"),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];
    let resp: MarketplaceCreditsApiResponse = indexer.get("/marketplace/credit", &params).await?;
    let events = resp.events.into_iter().map(|e| MarketplaceCreditEventObject {
        block_number: e.block_number.unwrap_or(0),
        event_index: e.event_index.unwrap_or(0),
        account_id: e.account_id.unwrap_or_default(),
        event_name: e.event_name.unwrap_or_default(),
        credits_amount: credits_raw_to_display(e.credits_amount.as_deref().unwrap_or("0")),
        transaction_type: e.transaction_type,
        processed_timestamp: e.processed_timestamp.unwrap_or_default(),
    }).collect();
    Ok(MarketplaceCreditsResult { events })
}

/// Fetch total file size stored by an account over a time window.
#[tauri::command]
pub async fn get_files_size(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    days_ago: Option<i64>,
) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let days_str = days_ago.unwrap_or(30).to_string();
    let params = vec![("account_id", account_id.as_str()), ("days_ago", days_str.as_str())];
    Ok(indexer.get::<serde_json::Value>("/user-total-file-size", &params).await?)
}

/// Fetch total file count for an account over a time window.
#[tauri::command]
pub async fn get_files_count(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    days_ago: Option<i64>,
) -> Result<serde_json::Value, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let days_str = days_ago.unwrap_or(30).to_string();
    let params = vec![("account_id", account_id.as_str()), ("days_ago", days_str.as_str())];
    Ok(indexer.get::<serde_json::Value>("/user-total-files-count", &params).await?)
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

/// Convert epoch milliseconds to a `NaiveDate` for use as HashMap key.
fn day_date(ms: i64) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().date_naive()
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
pub async fn get_credits(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<CreditObject>, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let page_str = page.unwrap_or(1).to_string();
    // The chart pipeline downstream deduplicates to latest-per-day, so we
    // only ever need enough rows to cover the longest range the FE asks
    // for. A year is 365 days, two years 730; INDEXER_MAX_LIMIT covers any
    // practical chart range with margin and avoids pulling MBs of JSON
    // the dedup loop will throw away.
    //
    // Server-side cap: per CLAUDE.md "Business logic MUST live in the
    // Rust backend." Even when the frontend passes an explicit
    // `Some(100_000)` (today's `useCredits.ts` default), we clamp here
    // so the over-fetch can't bypass the cap from the IPC boundary.
    let limit_str = limit.unwrap_or(INDEXER_MAX_LIMIT).min(INDEXER_MAX_LIMIT).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: IndexerResponse<CreditRow> = indexer.get("/credits/free-credits", &params).await?;

    // Deduplicate: keep latest entry per day
    let mut by_day: HashMap<NaiveDate, (i64, &CreditRow)> = HashMap::new();
    for row in &resp.data {
        let ts = best_timestamp(row.processed_timestamp.as_deref(), row.timestamp);
        let key = day_date(ts);
        let entry = by_day.entry(key).or_insert((ts, row));
        if ts > entry.0 {
            *entry = (ts, row);
        }
    }

    let mut results: Vec<CreditObject> = by_day
        .into_iter()
        .map(|(date, (ts, row))| CreditObject {
            id: row.id.clone().unwrap_or_default(),
            block: row.block_number.unwrap_or(0),
            amount: row.credits.clone().unwrap_or_else(|| "0".into()),
            account_id: row.account_id.clone().unwrap_or_default(),
            date: chrono::DateTime::from_timestamp_millis(ts).map_or_else(|| date.format("%Y-%m-%d").to_string(), |d| d.to_rfc3339()),
        })
        .collect();
    results.sort_by(|a, b| b.block.cmp(&a.block));
    Ok(results)
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
pub async fn get_system_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<BalanceObject>, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let page_str = page.unwrap_or(1).to_string();
    // Same reasoning + same server-side cap as `get_credits` above. The
    // FE's `useSystemBalance.ts` default of 20_000 is silently clamped
    // to INDEXER_MAX_LIMIT here.
    let limit_str = limit.unwrap_or(INDEXER_MAX_LIMIT).min(INDEXER_MAX_LIMIT).to_string();
    let params = vec![
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: IndexerResponse<BalanceRow> = indexer.get("/system-account-balance", &params).await?;

    let mut by_day: HashMap<NaiveDate, (i64, &BalanceRow)> = HashMap::new();
    for row in &resp.data {
        let ts = best_timestamp(row.processed_timestamp.as_deref(), row.timestamp);
        let key = day_date(ts);
        let entry = by_day.entry(key).or_insert((ts, row));
        if ts > entry.0 {
            *entry = (ts, row);
        }
    }

    let mut results: Vec<BalanceObject> = by_day
        .into_iter()
        .map(|(_date, (ts, row))| {
            let free = row.free_balance.clone().unwrap_or_else(|| "0".into());
            BalanceObject {
                account_id: row.account_id.clone().unwrap_or_default(),
                block_number: row.block_number,
                free_balance: free.clone(),
                total_balance: free,
                timestamp: chrono::DateTime::from_timestamp_millis(ts).map(|d| d.to_rfc3339()).unwrap_or_default(),
            }
        })
        .collect();
    results.sort_by(|a, b| b.block_number.cmp(&a.block_number));
    Ok(results)
}

// ── Balance transfers (parsed amounts, composite IDs) ───────────────────

/// UI-ready balance transfer.
///
/// `amount_planck` carries the raw indexer value (planck digits as a
/// decimal string) so no precision is lost above 2^53 planck (~9 HIP).
/// The frontend renders `amount_hip`, which is the same value run
/// through [`crate::blockchain::convert::planck_to_hip`] — the prior
/// `amount: f64` field silently rounded large transfers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferObject {
    pub id: String,
    pub block: i64,
    pub amount_planck: String,
    pub amount_hip: String,
    pub from: String,
    pub to: String,
    pub date: String,
    /// "Sent", "Received", or "-" based on the querying account.
    pub direction: String,
}

/// Fetch balance transfers with parsed amounts and composite IDs.
/// Replaces the `select` callback in `useBalanceTransactions.ts`.
#[tauri::command]
pub async fn get_balance_transfers(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<TransferObject>, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("account", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: IndexerResponse<TransferRow> = indexer.get("/balance-transfers", &params).await?;

    Ok(resp
        .data
        .iter()
        .map(|row| {
            let block = row.block_number.unwrap_or(0);
            let event_idx = row.event_index.unwrap_or(0);
            let from = row.from_account.clone().unwrap_or_default();
            let to = row.to_account.clone().unwrap_or_default();
            let direction = if from == account_id {
                "Sent"
            } else if to == account_id {
                "Received"
            } else {
                "-"
            }
            .to_string();
            // The indexer returns scientific-notation strings for large
            // amounts (e.g. "1.23e+20"). Normalize to plain decimal digits
            // so the planck→HIP divmod and bigint comparisons downstream
            // never see an "e" that would fail the digit check.
            let raw_amount = row.amount.as_deref().unwrap_or("0");
            let amount_planck = crate::blockchain::convert::normalize_decimal_digits(raw_amount);
            let amount_hip = crate::blockchain::convert::planck_to_hip(&amount_planck);
            TransferObject {
                id: format!("{block}-{event_idx}"),
                block,
                amount_planck,
                amount_hip,
                from,
                to,
                date: row.processed_timestamp.clone().unwrap_or_default(),
                direction,
            }
        })
        .collect())
}

// ── Billing transactions (payment type classified) ──────────────────────

/// UI-ready billing transaction. Field names match existing frontend table columns.
#[derive(Serialize)]
pub struct BillingTransactionObject {
    pub id: String,
    pub transaction_type: String,
    pub amount: f64,
    pub transaction_date: String,
    pub status: String,
}

/// Fetch billing transactions with payment type classified.
/// Replaces the `select` callback in `useBillingTransactions.ts`.
#[tauri::command]
pub async fn get_billing_transactions(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<BillingTransactionObject>, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![("page", page_str.as_str()), ("limit", limit_str.as_str())];
    let resp: BillingTransactionsResponse = client.get_with_params("/api/billing/transactions/", &params, &account_id).await?;

    Ok(resp
        .results
        .iter()
        .map(|t| {
            let payment_type = t.payment_type.as_deref().unwrap_or("");
            let tx_type = if payment_type.to_lowercase().contains("stripe") { "card" } else { "tao" };
            let amount = t.amount.as_ref().map_or(0.0, |v| {
                if let Some(s) = v.as_str() {
                    s.parse::<f64>().unwrap_or(0.0)
                } else {
                    v.as_f64().unwrap_or(0.0)
                }
            });

            // Coerce UUID strings or integer IDs to a String.
            let id = t.id.as_ref().map_or_else(String::new, |v| {
                v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.as_i64().map_or_else(String::new, |n| n.to_string()))
            });
            BillingTransactionObject {
                id,
                transaction_type: tx_type.to_string(),
                amount,
                transaction_date: t.created_at.clone().unwrap_or_default(),
                status: t.status.clone().unwrap_or_default(),
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
pub async fn get_add_credit_events(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<CreditEventObject>, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let params = vec![
        ("event_name", "MintedAccountCredits"),
        ("account_id", account_id.as_str()),
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
    ];

    let resp: EventsResponse = indexer.get("/events", &params).await?;

    Ok(resp
        .events
        .iter()
        .map(|e| CreditEventObject {
            id: e.id.unwrap_or(0),
            block_number: e.block_number.unwrap_or(0),
            amount: e.event_data.as_ref().and_then(|d| d.amount.as_deref()).unwrap_or("0").to_string(),
            account_id: e.account_id.clone().unwrap_or_default(),
            timestamp: e.processed_timestamp.clone().unwrap_or_default(),
            hash: e.extrinsic_hash.clone().unwrap_or_default(),
        })
        .collect())
}
