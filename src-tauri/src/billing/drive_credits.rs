//! Drive-scoped credit history feeding the home page's credit trend
//! chart and Total Credit Used card.
//!
//! Both commands hit a single indexer endpoint
//! (`/user-credits-by-storage-history?storage_type=drive`) and project
//! a different view onto the same response. The Storage Usage chart
//! used to share this endpoint too, but moved to the snapshot-driven
//! `/user-extended-storage-metrics` on 2026-05-08 — see
//! [`crate::billing::drive_storage`] — because the credits-history
//! endpoint only updates on a `CreditsConsumed` block, leaving the
//! chart hours behind reality after a deletion.
//!
//! The indexer emits each charge as a paired `(CreditsConsumed,
//! PointTransactionRecorded)` event at the same block; filtering to
//! `CreditsConsumed` matches the existing `/marketplace/credit`
//! consumer and avoids double-counting.

use crate::api::indexer::IndexerClient;
use crate::billing::charts::{ChartPoint, date_to_iso, dd_mon_label, format_balance, get_all_dates_in_range, normalize_date, parse_timestamp_to_date, range_start, weekday_name};
use crate::error::AppError;
use chrono::NaiveDate;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const ENDPOINT: &str = "/user-credits-by-storage-history";
const DRIVE_STORAGE_TYPE: &str = "drive";
const PAGE_LIMIT: u32 = 100;

/// Defensive page cap. At 100 events/page that's 5000 events, orders of
/// magnitude above what a heavily-billed account produces in a year
/// (the reference 5Ft4… account had 68 events total when this was
/// written). The cap is a safety net against a runaway `total_pages`
/// from the indexer, not a real expected ceiling.
const MAX_PAGES: u32 = 50;

/// The actual debit half of the paired `(CreditsConsumed,
/// PointTransactionRecorded)` events. Filtering keeps each charge
/// counted exactly once; mirrors the existing `/marketplace/credit`
/// query convention.
const CREDITS_CONSUMED_EVENT: &str = "CreditsConsumed";

/// Cache window for the per-account event slice. Aligns with the FE's
/// 30 s `useInvokeQuery` `staleTime` so a tile and its sibling chart
/// see the same data without an extra round-trip.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// One row of `/user-credits-by-storage-history`.
///
/// `credits_amount` is a planck value, but the indexer applies
/// `total_credits_amount * storage_percentage` server-side and emits
/// the result as a string that may be fractional
/// (`"93189525824488.31"`). That makes `String → f64` the only correct
/// parse path — `u128::from_str` rejects the dot. f64 has ~16 digits
/// of mantissa, well above the 6-decimal-credit floor the chart
/// displays, so the lossy conversion is bounded.
///
/// Every field defaults for resilience: a header tile shouldn't fail
/// to render because of a missing field, and `event_name == ""` is
/// dropped naturally by the `CreditsConsumed` predicate downstream.
/// `drive_files_size` is also present on the wire but unused here —
/// the storage chart now reads it from `/user-extended-storage-metrics`
/// instead. Serde tolerates the extra field by default.
#[derive(Deserialize, Default, Clone, Debug)]
struct DriveCreditEvent {
    #[serde(default)]
    credits_amount: String,
    #[serde(default)]
    event_name: String,
    #[serde(default)]
    processed_timestamp: String,
}

#[derive(Deserialize, Default)]
struct Pagination {
    #[serde(default)]
    total_pages: u32,
}

#[derive(Deserialize, Default)]
struct HistoryPage {
    #[serde(default)]
    data: Vec<DriveCreditEvent>,
    #[serde(default)]
    pagination: Pagination,
}

/// One cache slot per account.
struct CacheEntry {
    fetched_at: Instant,
    events: Vec<DriveCreditEvent>,
}

/// Process-wide event cache. The mutex is `tokio::sync::Mutex` so
/// holding it across the indexer fetch is sound; that's deliberate —
/// the lock acts as a single-flight gate so when the home page mounts
/// and fires `get_drive_storage_chart`, `get_drive_credits_chart`, and
/// `get_drive_credits_total` concurrently, only the first call hits
/// the indexer and the other two wait briefly then read the freshly
/// cached entry. Without this they'd issue three independent fetches
/// of the same data on every page render.
fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached wrapper around [`fetch_all_drive_events`]. Returns the cached
/// vector on hit; on miss, fetches under the lock so concurrent callers
/// serialize and share one round-trip.
async fn cached_drive_events(state: &crate::app_state::AppState, account_id: &str) -> Result<Vec<DriveCreditEvent>, AppError> {
    let mut guard = cache().lock().await;
    if let Some(entry) = guard.get(account_id)
        && entry.fetched_at.elapsed() < CACHE_TTL
    {
        return Ok(entry.events.clone());
    }
    let events = fetch_all_drive_events(state, account_id).await?;
    guard.insert(
        account_id.to_string(),
        CacheEntry {
            fetched_at: Instant::now(),
            events: events.clone(),
        },
    );
    Ok(events)
}

/// Walk the indexer's pages and collect every drive-scoped event for
/// the account. Stops as soon as `page >= total_pages`; bails at
/// [`MAX_PAGES`] with a warning rather than looping forever if the
/// indexer ever returns a runaway count.
async fn fetch_all_drive_events(state: &crate::app_state::AppState, account_id: &str) -> Result<Vec<DriveCreditEvent>, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let limit_str = PAGE_LIMIT.to_string();
    let mut all = Vec::new();

    for page in 1..=MAX_PAGES {
        let page_str = page.to_string();
        let params = [
            ("account_id", account_id),
            ("storage_type", DRIVE_STORAGE_TYPE),
            ("page", page_str.as_str()),
            ("limit", limit_str.as_str()),
        ];
        let response: HistoryPage = indexer.get(ENDPOINT, &params).await?;
        let total_pages = response.pagination.total_pages.max(1);
        all.extend(response.data);
        if page >= total_pages {
            return Ok(all);
        }
    }

    tracing::warn!(account_id, max_pages = MAX_PAGES, "drive credit history exceeded page cap; truncating");
    Ok(all)
}

/// Parse a (possibly fractional) planck string into HIP credits.
///
/// A malformed value is logged (not silently dropped) and treated as `0.0`:
/// the credit total is a display figure that must not fail, but coercing an
/// unparseable amount to zero with no trace undercounts the user's usage, so
/// the offending value is surfaced at warn level (audit 2026-06-05, finding C3).
fn planck_str_to_credits(raw: &str) -> f64 {
    raw.parse::<f64>().map_or_else(
        |_| {
            tracing::warn!(value = %raw, "unparseable planck amount in drive-credit total; treating as 0");
            0.0
        },
        |v| v / 1e18,
    )
}

/// Filter to `CreditsConsumed` rows, parse timestamps, sort ascending.
/// Rows with malformed timestamps drop out — they can't contribute to
/// a dated chart without a date.
fn consumed_events_by_date(events: &[DriveCreditEvent]) -> Vec<(NaiveDate, &DriveCreditEvent)> {
    let mut typed: Vec<(NaiveDate, &DriveCreditEvent)> = events
        .iter()
        .filter(|e| e.event_name == CREDITS_CONSUMED_EVENT)
        .filter_map(|e| parse_timestamp_to_date(&e.processed_timestamp).map(|d| (d, e)))
        .collect();
    typed.sort_by_key(|(d, _)| *d);
    typed
}

/// Cumulative drive credit usage per day.
///
/// Sum daily spend, then accumulate through the range, seeded by all
/// spend strictly before the window so the first point reflects "spent
/// so far" rather than "spent in window so far". Mirrors the prior
/// wallet-wide chart's semantics, just scoped to drive.
fn build_credits_chart(events: &[DriveCreditEvent], range: &str) -> Vec<ChartPoint> {
    let consumed = consumed_events_by_date(events);
    if consumed.is_empty() {
        return Vec::new();
    }

    let mut daily: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    for (date, event) in &consumed {
        *daily.entry(*date).or_insert(0.0) += planck_str_to_credits(&event.credits_amount);
    }

    let today = chrono::Utc::now().date_naive();
    let Some(start) = range_start(range, today) else {
        return Vec::new();
    };
    let dates = get_all_dates_in_range(start, today);

    let pre_range_total: f64 = consumed
        .iter()
        .take_while(|(d, _)| *d < start)
        .map(|(_, e)| planck_str_to_credits(&e.credits_amount))
        .sum();

    let mut running = pre_range_total;
    let mut cumulative: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    for date in &dates {
        running += daily.get(date).copied().unwrap_or(0.0);
        cumulative.insert(*date, running);
    }

    render_credit_points(&dates, &cumulative, range, pre_range_total)
}

fn render_credit_points(dates: &[NaiveDate], cumulative: &BTreeMap<NaiveDate, f64>, range: &str, seed: f64) -> Vec<ChartPoint> {
    let is_last7 = range == "last7days";
    dates
        .iter()
        .map(|&date| {
            let value = cumulative.get(&date).copied().unwrap_or(seed);
            let day_label = if is_last7 { weekday_name(date).to_string() } else { dd_mon_label(date) };
            let band_label = if is_last7 { Some(weekday_name(date).to_string()) } else { None };
            // The chart's stack-formatter expects an integer planck
            // string (`format_balance` contract). Convert through the
            // same `value * 1e18 as u128` round-trip the existing
            // wallet-wide chart uses so the formatted output stays
            // visually identical to what users saw before this swap.
            let clamped = value.max(0.0).min(u128::MAX as f64 / 1e18);
            let planck_str = format!("{}", (clamped * 1e18) as u128);
            ChartPoint {
                x: date_to_iso(date),
                balance: value,
                formatted_balance: format_balance(&planck_str, 6),
                timestamp: normalize_date(date),
                day_label,
                band_label,
                credit: None,
                formatted_credit: None,
            }
        })
        .collect()
}

// --- Tauri commands -------------------------------------------------------

/// Cumulative drive credit usage time series.
///
/// # Errors
/// Propagates [`AppError::Api`] from the underlying indexer request.
#[tauri::command]
pub async fn get_drive_credits_chart(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    range: String,
) -> Result<Vec<ChartPoint>, AppError> {
    let events = cached_drive_events(&state, &account_id).await?;
    Ok(build_credits_chart(&events, &range))
}

/// All-time drive credit usage in HIP. Powers the "Total Credit Used"
/// home-page card.
///
/// # Errors
/// Propagates [`AppError::Api`] from the underlying indexer request.
#[tauri::command]
pub async fn get_drive_credits_total(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<f64, AppError> {
    let events = cached_drive_events(&state, &account_id).await?;
    Ok(events
        .iter()
        .filter(|e| e.event_name == CREDITS_CONSUMED_EVENT)
        .map(|e| planck_str_to_credits(&e.credits_amount))
        .sum())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evt(event_name: &str, credits: &str, ts: &str) -> DriveCreditEvent {
        DriveCreditEvent {
            credits_amount: credits.to_string(),
            event_name: event_name.to_string(),
            processed_timestamp: ts.to_string(),
        }
    }

    #[test]
    fn fractional_planck_parses_via_f64_path() {
        // The sample payload contains `"93189525824488.31"`. `u128`
        // would reject the dot — that's why the field is `String` and
        // the parse goes through f64.
        let v = planck_str_to_credits("93189525824488.31");
        assert!((v - 9.318_952_582_448_831e-5).abs() < 1e-12, "got {v}");
    }

    #[test]
    fn integer_planck_parses_correctly() {
        let v = planck_str_to_credits("180000000000000");
        assert!((v - 1.8e-4).abs() < 1e-12, "got {v}");
    }

    #[test]
    fn empty_or_garbage_planck_is_zero() {
        // `assert_eq!` on f64 trips clippy::float_cmp; the parsed-zero
        // path is exact-bitwise (no arithmetic), so the strict compare
        // is the right test even though clippy can't tell.
        assert!(planck_str_to_credits("").to_bits() == 0.0_f64.to_bits());
        assert!(planck_str_to_credits("not-a-number").to_bits() == 0.0_f64.to_bits());
    }

    #[test]
    fn consumed_filter_drops_paired_point_transaction() {
        // Each charge is recorded twice — once as `CreditsConsumed` and
        // once as `PointTransactionRecorded` at the same block. Without
        // the filter every total in the UI would double.
        let events = vec![
            evt("CreditsConsumed", "100", "2026-05-01T00:00:00Z"),
            evt("PointTransactionRecorded", "100", "2026-05-01T00:00:00Z"),
        ];
        let kept = consumed_events_by_date(&events);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].1.event_name, "CreditsConsumed");
    }

    #[test]
    fn malformed_timestamp_drops_event() {
        let events = vec![
            evt("CreditsConsumed", "100", "not-a-date"),
            evt("CreditsConsumed", "200", "2026-05-01T00:00:00Z"),
        ];
        let kept = consumed_events_by_date(&events);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].1.credits_amount, "200");
    }

    #[test]
    fn consumed_events_returned_in_chronological_order() {
        // Indexer returns newest-first; charts need oldest-first to
        // run carry-forward correctly.
        let events = vec![
            evt("CreditsConsumed", "0", "2026-05-03T00:00:00Z"),
            evt("CreditsConsumed", "0", "2026-05-01T00:00:00Z"),
            evt("CreditsConsumed", "0", "2026-05-02T00:00:00Z"),
        ];
        let kept = consumed_events_by_date(&events);
        let dates: Vec<NaiveDate> = kept.iter().map(|(d, _)| *d).collect();
        assert!(dates.windows(2).all(|w| w[0] <= w[1]), "not sorted: {dates:?}");
    }

    #[test]
    fn total_sums_only_consumed_events() {
        // Mirrors the body of `get_drive_credits_total` so the
        // double-count guard is pinned even if the IPC plumbing
        // changes.
        let events = [
            evt("CreditsConsumed", "1000000000000000000", "2026-05-01T00:00:00Z"),
            evt("PointTransactionRecorded", "1000000000000000000", "2026-05-01T00:00:00Z"),
            evt("CreditsConsumed", "2000000000000000000", "2026-05-02T00:00:00Z"),
        ];
        let total: f64 = events
            .iter()
            .filter(|e| e.event_name == CREDITS_CONSUMED_EVENT)
            .map(|e| planck_str_to_credits(&e.credits_amount))
            .sum();
        assert!((total - 3.0).abs() < 1e-12, "got {total}");
    }

    #[test]
    fn history_page_deserializes_with_missing_pagination() {
        // The pagination block uses `#[serde(default)]` so an indexer
        // that ever omits the wrapper still parses to "page 1 of 1".
        let json = r#"{"data":[]}"#;
        let page: HistoryPage = serde_json::from_str(json).expect("parse");
        assert_eq!(page.pagination.total_pages, 0);
        assert!(page.data.is_empty());
    }

    #[test]
    fn history_page_deserializes_real_indexer_shape() {
        // Trimmed-down copy of one row from the live response (account
        // 5Ft4…6Q on 2026-05-06). Pins both the field set and the
        // fractional-planck handling end-to-end. `drive_files_size`
        // remains in the wire payload — Serde silently ignores it
        // since DriveCreditEvent stopped reading it.
        let json = r#"{
            "data":[{
                "credits_amount":"93189525824488.31",
                "drive_files_size":"53809050314",
                "event_name":"CreditsConsumed",
                "processed_timestamp":"2026-05-06T09:44:26.726178Z"
            }],
            "pagination":{"page":1,"limit":100,"total":1,"total_pages":1}
        }"#;
        let page: HistoryPage = serde_json::from_str(json).expect("parse");
        assert_eq!(page.data.len(), 1);
        assert_eq!(page.pagination.total_pages, 1);
        assert_eq!(page.data[0].credits_amount, "93189525824488.31");
    }
}
