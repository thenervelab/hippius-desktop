//! Available-credit balance history for the home page's Available Credits chart.
//!
//! Backed by the indexer's `/credits/free-credits` — the `credits_free_credits`
//! table, written by a dedicated poller that samples the chain's credit
//! profiles every ~8s and inserts a row **only when the balance actually
//! changed**. So the endpoint is a compact balance *change-log*, not a sample
//! stream, and two properties follow:
//!
//! * Quiet days carry **no rows**, so the chart must carry the last known
//!   balance forward — the same shape as [`crate::billing::drive_storage`]
//!   (a level series), NOT [`crate::billing::drive_credits`] (which accumulates
//!   spend events).
//! * Per-account row volume is low, so paging the whole history is cheap.
//!
//! This is deliberately a different series from the drive credit *usage* chart
//! on the Billing page: that one answers "how much have I spent on Drive",
//! this one answers "how much did I have left". A card headlined with the live
//! balance needs the latter, so its line and its headline move together.
//!
//! Note the line is not *strictly* declining: a top-up
//! (`MintedAccountCredits`) steps it up. That is correct — the series is the
//! balance, and the balance goes up when credits are bought.

use crate::api::indexer::IndexerClient;
use crate::billing::charts::{
    ChartPoint, date_to_iso, dd_mon_label, format_balance, get_all_dates_in_range, normalize_date, parse_timestamp_to_datetime,
    planck_str_to_credits, range_start, weekday_name,
};
use crate::error::AppError;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use std::collections::BTreeMap;

const ENDPOINT: &str = "/credits/free-credits";
const PAGE_LIMIT: u32 = 100;

/// Defensive page cap — 10_000 rows at [`PAGE_LIMIT`]. Because the upstream
/// poller only writes on a *change* of balance, a row is roughly one spend or
/// top-up event, so this is orders of magnitude above a real account's history.
/// It exists to bound a runaway `total_pages` from the indexer, not as an
/// expected ceiling.
const MAX_PAGES: u32 = 100;

/// One row of `/credits/free-credits`.
///
/// `credits` is planck. It arrives as a JSON **string**: the indexer types the
/// column as Postgres `NUMERIC` surfaced as `bigdecimal::BigDecimal`, whose
/// `Serialize` impl is `collect_str`. It is `Option` because the column is
/// nullable.
///
/// Both timestamps are present on the wire: `processed_timestamp` is the
/// indexer's insert time, `timestamp` the chain profile's update time in epoch
/// ms. We prefer the former to match the convention in
/// [`crate::billing::queries`], and fall back to the latter so a null can't
/// drop an otherwise good row. They differ by at most one poll interval, which
/// cannot change a day bucket except within ~8s of midnight.
///
/// Every field defaults: a chart must not fail to render because the indexer
/// omitted a field.
#[derive(Deserialize, Default, Clone, Debug)]
struct FreeCreditRow {
    #[serde(default)]
    credits: Option<String>,
    #[serde(default)]
    processed_timestamp: Option<String>,
    #[serde(default)]
    timestamp: i64,
}

#[derive(Deserialize, Default)]
struct Pagination {
    #[serde(default)]
    total_pages: u32,
}

#[derive(Deserialize, Default)]
struct FreeCreditsPage {
    #[serde(default)]
    data: Vec<FreeCreditRow>,
    #[serde(default)]
    pagination: Pagination,
}

/// Walk the indexer's pages and collect every balance row for the account.
///
/// Note the endpoint paginates with `ORDER BY block_number DESC` + `OFFSET`
/// while the poller appends concurrently, so a row can in principle be skipped
/// or duplicated across a page boundary. Harmless here: the series collapses to
/// one reading per day, so losing one intra-day row of many changes nothing.
async fn fetch_all_rows(state: &crate::app_state::AppState, account_id: &str) -> Result<Vec<FreeCreditRow>, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let limit_str = PAGE_LIMIT.to_string();
    let mut all = Vec::new();

    for page in 1..=MAX_PAGES {
        let page_str = page.to_string();
        let params = [("account_id", account_id), ("page", page_str.as_str()), ("limit", limit_str.as_str())];
        let response: FreeCreditsPage = indexer.get(ENDPOINT, &params).await?;
        let total_pages = response.pagination.total_pages.max(1);
        all.extend(response.data);
        if page >= total_pages {
            return Ok(all);
        }
    }

    tracing::warn!(account_id, max_pages = MAX_PAGES, "credit balance history exceeded page cap; truncating");
    Ok(all)
}

/// The planck string a row reports, or `"0"` when the column was null.
fn row_planck(row: &FreeCreditRow) -> &str {
    row.credits.as_deref().unwrap_or("0")
}

/// Resolve a row's instant, preferring `processed_timestamp` and falling back
/// to the numeric epoch-ms `timestamp`.
///
/// A non-positive `timestamp` counts as ABSENT, not as the epoch. The field is
/// `#[serde(default)]`, so a row missing both timestamps would otherwise date
/// itself 1970-01-01 and be silently kept — which defeats the `data_start`
/// clamp in [`build_balance_chart`], since a 1970 first-reading makes
/// `window_start.max(data_start)` a no-op and `max` goes back to painting the
/// flat plateau that clamp exists to prevent. The upstream column is
/// `BIGINT NOT NULL`, so this is a guard against a wire-shape change rather
/// than an observed payload.
fn row_instant(row: &FreeCreditRow) -> Option<DateTime<Utc>> {
    if let Some(parsed) = row.processed_timestamp.as_deref().and_then(parse_timestamp_to_datetime) {
        return Some(parsed);
    }
    if row.timestamp <= 0 {
        return None;
    }
    DateTime::from_timestamp_millis(row.timestamp)
}

/// Coerce a wire planck value into the pure-digit string [`format_balance`]
/// requires.
///
/// `format_balance` documents that ANY non-digit input — `"1.5"`, `"1e18"`,
/// `""` — formats as `"0"`, and notes that every other caller satisfies that by
/// building the string from a `u128`. Ours comes straight off the wire from a
/// Postgres `NUMERIC`, so a fractional or exponent-bearing rendering would
/// silently print `0` beside a correctly plotted line. Truncate a fractional
/// tail (sub-planck precision is far below the 6 decimals displayed) and, if
/// what remains still is not pure digits, rebuild from the f64 the way
/// `drive_credits` does.
fn planck_digits(raw: &str, hip: f64) -> String {
    let mut parts = raw.splitn(2, '.');
    let head = parts.next().unwrap_or_default();
    let tail = parts.next().unwrap_or_default();
    // The TAIL must be validated too, not just the head: `"1.5E+18"` has the
    // perfectly-digit head `"1"`, so accepting it on the head alone would
    // silently drop the exponent and render 1.5 HIP as 1e-18 — the very
    // near-zero display this helper exists to prevent.
    let plain_decimal = !head.is_empty() && head.bytes().all(|b| b.is_ascii_digit()) && tail.bytes().all(|b| b.is_ascii_digit());
    if plain_decimal {
        return head.to_string();
    }
    let clamped = hip.max(0.0).min(u128::MAX as f64 / 1e18);
    format!("{}", (clamped * 1e18) as u128)
}

/// Parse, sort by full instant ascending, drop rows with no usable timestamp.
///
/// Sorting by the full instant rather than the date is required, not cosmetic:
/// the indexer returns rows newest-first (`block_number DESC`) and
/// `Vec::sort_by_key` is stable, so equal-date rows would keep that descending
/// order and the last-insert-wins collapse below would end up keeping each
/// day's **oldest** reading instead of its latest.
fn rows_sorted(rows: &[FreeCreditRow]) -> Vec<(DateTime<Utc>, &FreeCreditRow)> {
    let mut typed: Vec<(DateTime<Utc>, &FreeCreditRow)> = rows.iter().filter_map(|r| row_instant(r).map(|dt| (dt, r))).collect();
    typed.sort_by_key(|(dt, _)| *dt);
    typed
}

/// Daily available-credit balance, carry-forward across the requested range.
///
/// Several readings on the same day collapse to the latest — closest to an
/// end-of-day balance.
fn build_balance_chart(rows: &[FreeCreditRow], range: &str) -> Vec<ChartPoint> {
    let typed = rows_sorted(rows);
    if typed.is_empty() {
        return Vec::new();
    }

    // `typed` is ascending, so successive inserts overwrite older same-day
    // entries and `by_day` ends up holding each date's latest reading. The
    // planck string is kept alongside the f64 so formatting needs no float
    // round-trip: f64 drives the plot geometry, the raw string drives the label.
    let mut by_day: BTreeMap<NaiveDate, (f64, &str)> = BTreeMap::new();
    for (dt, row) in &typed {
        by_day.insert(dt.date_naive(), (planck_str_to_credits(row_planck(row)), row_planck(row)));
    }

    let today = Utc::now().date_naive();
    let Some(window_start) = range_start(range, today) else {
        return Vec::new();
    };

    // Clamp the window to the first day we actually have a reading for. Before
    // that the balance is genuinely unknown — carry-forward has nothing to
    // carry — and `max` is the worst case, since `range_start("max")` is the
    // hardcoded service-creation date (2025-03-11), typically long before this
    // table's first row for an account. Without the clamp those windows paint a
    // misleading flat-zero plateau. Also clamped to `today` so a future-dated
    // row (clock skew) can't invert the range.
    let data_start = typed[0].0.date_naive();
    let start = window_start.max(data_start).min(today);
    let dates = get_all_dates_in_range(start, today);

    // Seed from the latest reading strictly before the window so a window
    // opening on a quiet day shows the balance already in place, not 0.
    let seed = typed
        .iter()
        .take_while(|(dt, _)| dt.date_naive() < start)
        .last()
        .map_or((0.0, "0"), |(_, r)| (planck_str_to_credits(row_planck(r)), row_planck(r)));

    render_points(&dates, &by_day, range, seed)
}

fn render_points(dates: &[NaiveDate], by_day: &BTreeMap<NaiveDate, (f64, &str)>, range: &str, seed: (f64, &str)) -> Vec<ChartPoint> {
    let is_last7 = range == "last7days";
    let mut last = seed;
    dates
        .iter()
        .map(|&date| {
            let entry = by_day.get(&date).copied();
            let has_data = entry.is_some();
            if let Some(v) = entry {
                last = v;
            }
            let day_label = if is_last7 { weekday_name(date).to_string() } else { dd_mon_label(date) };
            let band_label = if is_last7 { Some(weekday_name(date).to_string()) } else { None };
            ChartPoint {
                x: date_to_iso(date),
                balance: last.0,
                formatted_balance: format_balance(&planck_digits(last.1, last.0), 6),
                timestamp: if has_data { normalize_date(date) } else { String::new() },
                day_label,
                band_label,
                credit: None,
                formatted_credit: None,
            }
        })
        .collect()
}

// --- Tauri commands -------------------------------------------------------

/// Available-credit balance time series for the home page's Available Credits
/// chart.
///
/// The frontend-supplied `account_id` is validated against the session rather
/// than trusted. The sibling indexer chart commands are exempted from that rule
/// (`tests/account_authority_guard.rs`'s `BROAD_ALLOWLIST`) on the grounds that
/// the FE hands them the header-selected `activeWallet`, but that does not apply
/// here: `useCreditBalanceChart` leaves `addressSource` at its `"auth"` default,
/// so the only address it ever sends IS the session account. The guard is
/// therefore free, and it stops a crafted IPC call from reading another
/// account's balance history.
///
/// # Errors
/// [`AppError::Auth`] if `account_id` is not the active session account;
/// otherwise propagates [`AppError::Api`] from the indexer request.
#[tauri::command]
pub async fn get_credit_balance_chart(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    range: String,
) -> Result<Vec<ChartPoint>, AppError> {
    let account_id = state.require_session_account(&account_id)?;
    let rows = fetch_all_rows(&state, &account_id).await?;
    Ok(build_balance_chart(&rows, &range))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(credits: &str, ts: &str) -> FreeCreditRow {
        FreeCreditRow {
            credits: Some(credits.to_string()),
            processed_timestamp: Some(ts.to_string()),
            timestamp: 0,
        }
    }

    const ONE_HIP: &str = "1000000000000000000";

    #[test]
    fn rows_returned_in_chronological_order() {
        // The indexer returns newest-first (`block_number DESC`); carry-forward
        // needs oldest-first.
        let rows = vec![
            row(ONE_HIP, "2026-05-03T00:00:00Z"),
            row(ONE_HIP, "2026-05-01T00:00:00Z"),
            row(ONE_HIP, "2026-05-02T00:00:00Z"),
        ];
        let dates: Vec<NaiveDate> = rows_sorted(&rows).iter().map(|(dt, _)| dt.date_naive()).collect();
        assert!(dates.windows(2).all(|w| w[0] <= w[1]), "not sorted: {dates:?}");
    }

    #[test]
    fn latest_reading_of_day_wins() {
        // Three same-day readings in shuffled input order. A date-only sort
        // would silently keep the 08:00 reading, because `sort_by_key` is
        // stable and the indexer's order is descending — see `rows_sorted`.
        let rows = vec![
            row("100", "2026-05-01T08:00:00Z"),
            row("300", "2026-05-01T18:00:00Z"),
            row("200", "2026-05-01T12:00:00Z"),
        ];
        let typed = rows_sorted(&rows);
        let mut by_day: BTreeMap<NaiveDate, &str> = BTreeMap::new();
        for (dt, r) in &typed {
            by_day.insert(dt.date_naive(), row_planck(r));
        }
        let date = NaiveDate::from_ymd_opt(2026, 5, 1).expect("valid date");
        assert_eq!(by_day[&date], "300");
    }

    #[test]
    fn sub_second_timestamps_order_correctly() {
        // Real payloads mix `.001Z` and bare `Z` in the same second. A
        // lexicographic sort would invert them ('.' < 'Z' in ASCII).
        let rows = vec![row("100", "2026-05-08T07:50:18.001Z"), row("200", "2026-05-08T07:50:18Z")];
        let typed = rows_sorted(&rows);
        assert_eq!(row_planck(typed[0].1), "200");
        assert_eq!(row_planck(typed[1].1), "100");
    }

    #[test]
    fn spend_only_history_is_non_increasing() {
        // The headline requirement: with no top-ups the line must decline.
        let rows = vec![
            row("5000000000000000000", "2026-05-01T00:00:00Z"),
            row("3000000000000000000", "2026-05-02T00:00:00Z"),
            row("1000000000000000000", "2026-05-03T00:00:00Z"),
        ];
        let chart = build_balance_chart(&rows, "max");
        assert!(!chart.is_empty());
        let balances: Vec<f64> = chart.iter().map(|p| p.balance).collect();
        assert!(
            balances.windows(2).all(|w| w[0] >= w[1]),
            "balance series should never rise without a top-up: {balances:?}"
        );
        assert!((balances[0] - 5.0).abs() < 1e-12, "got {}", balances[0]);
    }

    #[test]
    fn top_up_steps_the_series_up() {
        // Deliberate counterpart to the test above: the series tracks the
        // balance, so buying credits raises it. Pins that we are NOT forcing
        // monotonic decline.
        let rows = vec![
            row("1000000000000000000", "2026-05-01T00:00:00Z"),
            row("9000000000000000000", "2026-05-02T00:00:00Z"),
        ];
        let chart = build_balance_chart(&rows, "max");
        let last = chart.last().expect("non-empty").balance;
        assert!((last - 9.0).abs() < 1e-12, "got {last}");
    }

    #[test]
    fn quiet_days_carry_the_last_balance_forward() {
        // The poller writes only on change, so a flat stretch has no rows and
        // MUST NOT read as 0.
        let today = Utc::now().date_naive();
        let start = today.checked_sub_signed(chrono::Duration::days(3)).expect("subtract 3 days");
        let rows = vec![row(ONE_HIP, &format!("{start}T00:00:00Z"))];

        let chart = build_balance_chart(&rows, "last7days");
        assert!(!chart.is_empty());
        assert!(
            chart.iter().all(|p| (p.balance - 1.0).abs() < 1e-12),
            "every day should carry the single known reading, got {:?}",
            chart.iter().map(|p| p.balance).collect::<Vec<_>>()
        );
    }

    #[test]
    fn pre_window_reading_seeds_the_first_day() {
        // Only reading is older than the window. Every point should carry it
        // rather than starting at 0.
        let today = Utc::now().date_naive();
        let pre = today.checked_sub_signed(chrono::Duration::days(30)).expect("subtract 30 days");
        let rows = vec![row("2000000000000000000", &format!("{pre}T00:00:00Z"))];

        let chart = build_balance_chart(&rows, "last7days");
        assert_eq!(chart.len(), 7, "a 7-day window seeded from before it should still fill");
        assert!(chart.iter().all(|p| (p.balance - 2.0).abs() < 1e-12), "got {chart:?}");
    }

    #[test]
    fn max_range_starts_at_first_row_not_service_creation() {
        // `range_start("max")` is the hardcoded 2025-03-11 service-creation
        // date. Without the clamp, `max` paints a flat-zero plateau back to it.
        let rows = vec![row(ONE_HIP, "2026-05-06T00:00:00Z")];
        let chart = build_balance_chart(&rows, "max");
        assert!(!chart.is_empty(), "max chart should not be empty");
        assert_eq!(chart[0].x, "2026-05-06T00:00:00.000Z", "first point should be the first reading's day");
        assert!((chart[0].balance - 1.0).abs() < 1e-12, "got {}", chart[0].balance);
    }

    #[test]
    fn formatted_balance_avoids_float_round_trip() {
        // The raw planck string formats directly, so a value with more
        // precision than f64 arithmetic would preserve still renders exactly.
        let rows = vec![row("1234567890123456789", "2026-05-01T00:00:00Z")];
        let chart = build_balance_chart(&rows, "max");
        assert_eq!(chart[0].formatted_balance, format_balance("1234567890123456789", 6));
    }

    #[test]
    fn fractional_wire_value_still_formats_non_zero() {
        // `format_balance` maps any non-digit input to "0". A NUMERIC rendered
        // with a fractional tail would therefore have labelled the chart 0
        // while the line plotted correctly.
        let rows = vec![row("1500000000000000000.00", "2026-05-01T00:00:00Z")];
        let chart = build_balance_chart(&rows, "max");
        assert_eq!(chart[0].formatted_balance, format_balance("1500000000000000000", 6));
        assert_ne!(chart[0].formatted_balance, "0");
    }

    #[test]
    fn exponent_wire_value_falls_back_to_the_f64_path() {
        // "1.5E+18" has no usable digit head, so the display is rebuilt from
        // the parsed f64 rather than collapsing to "0".
        assert_eq!(planck_digits("1.5E+18", 1.5), "1500000000000000000");
        assert_eq!(planck_digits("1500000000000000000", 1.5), "1500000000000000000");
        assert_eq!(planck_digits("", 0.0), "0");
    }

    #[test]
    fn empty_history_yields_empty_chart() {
        assert!(build_balance_chart(&[], "last7days").is_empty());
    }

    #[test]
    fn null_credits_column_reads_as_zero() {
        let rows = vec![FreeCreditRow {
            credits: None,
            processed_timestamp: Some("2026-05-01T00:00:00Z".to_string()),
            timestamp: 0,
        }];
        let chart = build_balance_chart(&rows, "max");
        assert!((chart[0].balance - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn numeric_timestamp_is_used_when_processed_is_absent() {
        // `timestamp` is NOT NULL upstream while `processed_timestamp` is
        // nullable, so the fallback keeps an otherwise good row.
        let rows = vec![FreeCreditRow {
            credits: Some(ONE_HIP.to_string()),
            processed_timestamp: None,
            timestamp: 1_777_978_926_000,
        }];
        let typed = rows_sorted(&rows);
        assert_eq!(typed.len(), 1, "row with only a numeric timestamp must survive");
    }

    #[test]
    fn row_with_no_usable_timestamp_is_dropped() {
        let rows = vec![
            FreeCreditRow {
                credits: Some(ONE_HIP.to_string()),
                processed_timestamp: Some("not-a-date".to_string()),
                timestamp: 0,
            },
            row("200", "2026-05-01T00:00:00Z"),
        ];
        let typed = rows_sorted(&rows);
        assert_eq!(typed.len(), 1, "a row with neither timestamp must not survive");
        assert_eq!(row_planck(typed[0].1), "200");
    }

    #[test]
    fn undated_row_cannot_defeat_the_data_start_clamp() {
        // Regression: `timestamp` is `#[serde(default)]`, so a row missing both
        // timestamps used to resolve to 1970-01-01 and be kept. That made
        // `data_start` 1970, which turns `window_start.max(data_start)` into a
        // no-op — so `max` silently reverted to plotting from the hardcoded
        // 2025-03-11 service-creation date, the exact plateau the clamp exists
        // to prevent.
        let rows = vec![
            FreeCreditRow {
                credits: Some(ONE_HIP.to_string()),
                processed_timestamp: None,
                timestamp: 0,
            },
            row("2000000000000000000", "2026-05-06T00:00:00Z"),
        ];
        let chart = build_balance_chart(&rows, "max");
        assert_eq!(chart[0].x, "2026-05-06T00:00:00.000Z", "chart must start at the only real reading");
    }

    #[test]
    fn page_deserializes_real_indexer_shape() {
        // Field set mirrors `FreeCredits` in hippius-indexer-api
        // (src/db/models.rs:779). `credits` is a BigDecimal, which serializes
        // via `collect_str` — hence a JSON string, not a number. Fields we do
        // not read (id, block_number, account_id) must be ignored silently.
        let json = r#"{
            "data":[{
                "id": 42,
                "block_number": 5647319,
                "account_id": "5DL9k",
                "credits": "93189525824488310000",
                "timestamp": 1777978926000,
                "processed_timestamp": "2026-05-06T09:44:26.726178Z"
            }],
            "pagination":{"page":1,"limit":100,"total":1,"total_pages":1}
        }"#;
        let page: FreeCreditsPage = serde_json::from_str(json).expect("parse");
        assert_eq!(page.data.len(), 1);
        assert_eq!(page.pagination.total_pages, 1);
        assert_eq!(page.data[0].credits.as_deref(), Some("93189525824488310000"));
    }

    #[test]
    fn page_tolerates_missing_pagination() {
        let page: FreeCreditsPage = serde_json::from_str(r#"{"data":[]}"#).expect("parse");
        assert_eq!(page.pagination.total_pages, 0);
        assert!(page.data.is_empty());
    }
}
