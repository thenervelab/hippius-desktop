//! Drive-storage time series for the home page's Storage Usage chart.
//!
//! Backed by `/user-extended-storage-metrics?storage=drive` — the same
//! endpoint that powers the "Total Storage Used" tile via
//! [`crate::billing::queries::get_drive_storage_stats`]. Tile and chart
//! now read the same source, so the drift that existed up to
//! 2026-05-08 — chart pulled from `/user-credits-by-storage-history`
//! (event-driven, only updates on a `CreditsConsumed` block) while the
//! tile pulled from `/user-extended-storage-metrics` (snapshot-driven,
//! ~30 s freshness) — cannot recur. A deletion that drops the tile
//! to 21 MB will land on the chart's "today" point at the next
//! snapshot poll instead of waiting for the next billing event hours
//! later.
//!
//! The endpoint emits one row per indexer snapshot. The chart
//! collapses to one point per day using the **latest** snapshot of
//! that day, then carry-forwards to fill quiet days, mirroring the
//! prior credits-event-based logic so the visible chart shape is
//! unchanged.

use crate::api::indexer::IndexerClient;
use crate::billing::charts::{
    ChartPoint, date_to_iso, dd_mon_label, format_bytes, get_all_dates_in_range, normalize_date, parse_timestamp_to_datetime, range_start,
    weekday_name,
};
use crate::error::AppError;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const ENDPOINT: &str = "/user-extended-storage-metrics";
const DRIVE_STORAGE_FILTER: &str = "drive";
const PAGE_LIMIT: u32 = 100;

/// Defensive page cap. At 100 snapshots/page that's 50_000 rows — far
/// beyond what an account produces in a year of ~30 s snapshots
/// (~1M/yr theoretical, but the indexer aggregates so observed volume
/// is well under 10k for active accounts). Plays the same safety-net
/// role as `MAX_PAGES` in `drive_credits.rs`; tuned higher because
/// snapshot frequency is much higher than billing-event frequency.
const MAX_PAGES: u32 = 500;

/// Cache window. Aligns with `useDriveStorageStats`'s 30 s
/// `refetchInterval` so the home page's tile and chart fetch on mount
/// in lockstep and the second-arriving call hits cache.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// One snapshot row from `/user-extended-storage-metrics?storage=drive`.
///
/// `drive_files_size` arrives as a numeric string for the same reason
/// `DriveCreditEvent.drive_files_size` did: total bytes can exceed
/// JSON's 53-bit safe-integer ceiling. `processed_timestamp` is the
/// only non-size field we need here — bucketing happens by date and
/// we share `parse_timestamp_to_date` with the credits chart.
#[derive(Deserialize, Default, Clone, Debug)]
struct DriveStorageSnapshot {
    #[serde(default)]
    drive_files_size: String,
    #[serde(default)]
    processed_timestamp: String,
}

#[derive(Deserialize, Default)]
struct Pagination {
    #[serde(default)]
    total_pages: u32,
}

#[derive(Deserialize, Default)]
struct MetricsPage {
    #[serde(default)]
    data: Vec<DriveStorageSnapshot>,
    #[serde(default)]
    pagination: Pagination,
}

struct CacheEntry {
    fetched_at: Instant,
    snapshots: Vec<DriveStorageSnapshot>,
}

/// Process-wide cache. The `tokio::sync::Mutex` is held across the
/// indexer fetch deliberately — it acts as a single-flight gate so
/// the home page's near-simultaneous tile + chart mounts do one
/// round-trip instead of two.
fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn cached_drive_snapshots(state: &crate::app_state::AppState, account_id: &str) -> Result<Vec<DriveStorageSnapshot>, AppError> {
    let mut guard = cache().lock().await;
    if let Some(entry) = guard.get(account_id)
        && entry.fetched_at.elapsed() < CACHE_TTL
    {
        return Ok(entry.snapshots.clone());
    }
    let snapshots = fetch_all_drive_snapshots(state, account_id).await?;
    guard.insert(
        account_id.to_string(),
        CacheEntry {
            fetched_at: Instant::now(),
            snapshots: snapshots.clone(),
        },
    );
    Ok(snapshots)
}

/// Walk the indexer's pages and collect every drive-scoped snapshot
/// for the account. Stops as soon as `page >= total_pages`; bails at
/// [`MAX_PAGES`] with a warning rather than looping forever if the
/// indexer ever returns a runaway count.
async fn fetch_all_drive_snapshots(state: &crate::app_state::AppState, account_id: &str) -> Result<Vec<DriveStorageSnapshot>, AppError> {
    let indexer = IndexerClient::from_env(state.api_client.clone())?;
    let limit_str = PAGE_LIMIT.to_string();
    let mut all = Vec::new();

    for page in 1..=MAX_PAGES {
        let page_str = page.to_string();
        let params = [
            ("account_id", account_id),
            ("storage", DRIVE_STORAGE_FILTER),
            ("page", page_str.as_str()),
            ("limit", limit_str.as_str()),
        ];
        let response: MetricsPage = indexer.get(ENDPOINT, &params).await?;
        let total_pages = response.pagination.total_pages.max(1);
        all.extend(response.data);
        if page >= total_pages {
            return Ok(all);
        }
    }

    tracing::warn!(account_id, max_pages = MAX_PAGES, "drive storage history exceeded page cap; truncating");
    Ok(all)
}

fn bytes_str_to_f64(raw: &str) -> f64 {
    raw.parse::<f64>().unwrap_or(0.0)
}

/// Parse, sort by full timestamp ascending, drop malformed rows.
///
/// Sorting by date alone is **not** sufficient: the indexer emits many
/// snapshots per day and `Vec::sort_by_key` is stable, so equal-date
/// rows would retain the indexer's newest-first input order and the
/// downstream `BTreeMap::insert` collapse would end up keeping the
/// **oldest** same-day reading instead of the latest. Sorting by the
/// full datetime fixes this — last-insert-wins on a chronologically
/// ascending stream collapses each day to its latest snapshot.
fn snapshots_sorted(snapshots: &[DriveStorageSnapshot]) -> Vec<(DateTime<Utc>, &DriveStorageSnapshot)> {
    let mut typed: Vec<(DateTime<Utc>, &DriveStorageSnapshot)> = snapshots
        .iter()
        .filter_map(|s| parse_timestamp_to_datetime(&s.processed_timestamp).map(|dt| (dt, s)))
        .collect();
    typed.sort_by_key(|(dt, _)| *dt);
    typed
}

/// Daily snapshot of drive storage, carry-forward across the
/// requested range. Multiple snapshots on the same day collapse to
/// the latest reading — closest to an end-of-day total.
fn build_storage_chart(snapshots: &[DriveStorageSnapshot], range: &str) -> Vec<ChartPoint> {
    let typed = snapshots_sorted(snapshots);
    if typed.is_empty() {
        return Vec::new();
    }

    // `typed` is sorted ascending by full timestamp; successive
    // `BTreeMap::insert` overwrites older same-day entries with newer
    // ones, so `by_day` ends up holding the latest reading for each
    // date.
    let mut by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    for (dt, snap) in &typed {
        by_day.insert(dt.date_naive(), bytes_str_to_f64(&snap.drive_files_size));
    }

    let today = chrono::Utc::now().date_naive();
    let Some(window_start) = range_start(range, today) else {
        return Vec::new();
    };

    // Clamp the window to the first day we actually have a snapshot for, the
    // same way `drive_credits::build_credits_chart` does. Before that day the
    // account's storage is genuinely unknown, and `max` is the worst case:
    // `range_start("max")` is the hardcoded service-creation date (2025-03-11),
    // typically long before this endpoint's first snapshot for an account, so
    // an unclamped window paints a flat-zero plateau back to it. That was
    // invisible while this series was rendered as downsampled delta bars; as a
    // cumulative line it shows up as a long dead-flat prefix. Clamped to
    // `today` as well, so a future-dated snapshot (clock skew) can't invert the
    // range. We only ever clamp *up*, so the pre-window seed below still
    // carries earlier storage into windows that open after `data_start`.
    let data_start = typed[0].0.date_naive();
    let start = window_start.max(data_start).min(today);
    let dates = get_all_dates_in_range(start, today);

    // Pre-range seed: latest snapshot strictly before the window.
    // Otherwise a window that opens on a quiet day would draw 0 B
    // until the next snapshot, which misrepresents storage that was
    // already in place.
    let pre_range_seed = typed
        .iter()
        .take_while(|(dt, _)| dt.date_naive() < start)
        .last()
        .map_or(0.0, |(_, s)| bytes_str_to_f64(&s.drive_files_size));

    render_storage_points(&dates, &by_day, range, pre_range_seed)
}

fn render_storage_points(dates: &[NaiveDate], by_day: &BTreeMap<NaiveDate, f64>, range: &str, seed: f64) -> Vec<ChartPoint> {
    let is_last7 = range == "last7days";
    let mut last_balance = seed;
    dates
        .iter()
        .map(|&date| {
            let entry = by_day.get(&date).copied();
            let has_data = entry.is_some();
            if let Some(v) = entry {
                last_balance = v;
            }
            let day_label = if is_last7 { weekday_name(date).to_string() } else { dd_mon_label(date) };
            let band_label = if is_last7 { Some(weekday_name(date).to_string()) } else { None };
            ChartPoint {
                x: date_to_iso(date),
                balance: last_balance,
                formatted_balance: format_bytes(last_balance),
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

/// Drive storage time series for the home page's Storage Usage chart.
///
/// # Errors
/// Propagates [`AppError::Api`] from the underlying indexer request.
#[tauri::command]
pub async fn get_drive_storage_chart(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    range: String,
) -> Result<Vec<ChartPoint>, AppError> {
    let snapshots = cached_drive_snapshots(&state, &account_id).await?;
    Ok(build_storage_chart(&snapshots, &range))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(size: &str, ts: &str) -> DriveStorageSnapshot {
        DriveStorageSnapshot {
            drive_files_size: size.to_string(),
            processed_timestamp: ts.to_string(),
        }
    }

    #[test]
    fn malformed_timestamp_drops_snapshot() {
        let snaps = vec![snap("100", "not-a-date"), snap("200", "2026-05-01T00:00:00Z")];
        let kept = snapshots_sorted(&snaps);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].1.drive_files_size, "200");
    }

    #[test]
    fn snapshots_returned_in_chronological_order() {
        // Indexer returns newest-first; carry-forward needs oldest-first.
        let snaps = vec![
            snap("30", "2026-05-03T00:00:00Z"),
            snap("10", "2026-05-01T00:00:00Z"),
            snap("20", "2026-05-02T00:00:00Z"),
        ];
        let kept = snapshots_sorted(&snaps);
        let dates: Vec<NaiveDate> = kept.iter().map(|(dt, _)| dt.date_naive()).collect();
        assert!(dates.windows(2).all(|w| w[0] <= w[1]), "not sorted: {dates:?}");
    }

    #[test]
    fn last_snapshot_of_day_wins_in_by_day_map() {
        // Three same-day snapshots fed in random input order. The
        // sort-by-full-timestamp + overwriting-insert pipeline must
        // end with the latest (18:00) reading in by_day, not the
        // first (08:00). Sorting by date alone would silently fail
        // this test because `Vec::sort_by_key` is stable — see the
        // comment on `snapshots_sorted`.
        let snaps = vec![
            snap("100", "2026-05-01T08:00:00Z"),
            snap("300", "2026-05-01T18:00:00Z"),
            snap("200", "2026-05-01T12:00:00Z"),
        ];
        let typed = snapshots_sorted(&snaps);
        let mut by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
        for (dt, snap) in &typed {
            by_day.insert(dt.date_naive(), bytes_str_to_f64(&snap.drive_files_size));
        }
        let date = NaiveDate::from_ymd_opt(2026, 5, 1).expect("valid date");
        assert!((by_day[&date] - 300.0).abs() < f64::EPSILON, "got {}", by_day[&date]);
    }

    #[test]
    fn sub_second_timestamps_order_correctly() {
        // Real indexer payloads include `.001Z`-suffixed timestamps
        // alongside `Z` ones in the same minute. Verify the parser
        // orders them chronologically — naive lexicographic sort on
        // the raw string would put `.001Z` before `Z` because `.` <
        // `Z` in ASCII, reversing the actual order.
        let snaps = vec![snap("100", "2026-05-08T07:50:18.001Z"), snap("200", "2026-05-08T07:50:18Z")];
        let typed = snapshots_sorted(&snaps);
        // After sort: 07:50:18Z (no fraction) then 07:50:18.001Z.
        assert_eq!(typed[0].1.drive_files_size, "200");
        assert_eq!(typed[1].1.drive_files_size, "100");
    }

    #[test]
    fn metrics_page_deserializes_real_indexer_shape() {
        // Real row trimmed from account 5E4Z…ah on 2026-05-08. Pins
        // the field names and the string-typed bytes parse so a
        // future indexer schema change fails this test loudly.
        let json = r#"{
            "data":[{
                "drive_files_size":"21339640",
                "processed_timestamp":"2026-05-08T07:50:18.001Z"
            }],
            "pagination":{"page":1,"limit":1,"total":248,"total_pages":248}
        }"#;
        let page: MetricsPage = serde_json::from_str(json).expect("parse");
        assert_eq!(page.data.len(), 1);
        assert_eq!(page.pagination.total_pages, 248);
        assert_eq!(page.data[0].drive_files_size, "21339640");
    }

    #[test]
    fn metrics_page_tolerates_missing_pagination() {
        // The pagination block uses `#[serde(default)]` so an indexer
        // that ever omits the wrapper still parses to "page 1 of 1".
        let json = r#"{"data":[]}"#;
        let page: MetricsPage = serde_json::from_str(json).expect("parse");
        assert_eq!(page.pagination.total_pages, 0);
        assert!(page.data.is_empty());
    }

    #[test]
    fn empty_snapshots_yield_empty_chart() {
        let out = build_storage_chart(&[], "last7days");
        assert!(out.is_empty());
    }

    #[test]
    fn max_range_starts_at_first_snapshot_not_service_creation() {
        // `range_start("max")` is the hardcoded 2025-03-11 service-creation
        // date. Unclamped, `max` prefixes the series with a flat-zero run back
        // to it — harmless-looking as downsampled bars, but a long dead-flat
        // stretch once this renders as a cumulative line.
        let snaps = vec![snap("21339640", "2026-05-06T00:00:00Z")];
        let chart = build_storage_chart(&snaps, "max");
        assert!(!chart.is_empty(), "max chart should not be empty");
        assert_eq!(chart[0].x, "2026-05-06T00:00:00.000Z", "first point should be the first snapshot's day");
        assert!(
            (chart[0].balance - 21_339_640.0).abs() < f64::EPSILON,
            "first point should carry the snapshot, got {}",
            chart[0].balance
        );
    }

    #[test]
    fn pre_window_seed_carries_into_first_day() {
        // Only one snapshot, dated *before* a 7-day window opens on
        // today. Every chart point should carry that pre-window
        // value, not 0 — that was the original bug fix the credits
        // chart shipped with and the new storage path must preserve.
        let today = chrono::Utc::now().date_naive();
        let pre = today.checked_sub_signed(chrono::Duration::days(30)).expect("subtract 30 days from today");
        let ts = format!("{pre}T00:00:00Z");
        let snaps = vec![snap("12345", &ts)];

        let out = build_storage_chart(&snaps, "last7days");
        assert!(!out.is_empty());
        assert!(
            out.iter().all(|p| (p.balance - 12345.0).abs() < f64::EPSILON),
            "expected all points to seed from pre-window snapshot, got {out:?}"
        );
    }
}
