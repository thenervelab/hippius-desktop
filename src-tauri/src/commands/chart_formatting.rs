//! Chart data formatting commands.
//!
//! Provides Tauri commands that convert raw account/indexer data into
//! [`ChartPoint`] vectors suitable for frontend chart rendering. This replaces
//! the TypeScript formatters in `getFormatDataForCreditsUsageChart.tsx`,
//! `getFormatDataForStorageUsageChart.tsx`, and `getFormatDataForAccountsChart.tsx`.
//!
//! All three chart types share the same core logic ([`build_chart`]):
//! 1. Parse timestamped balance data into dated points
//! 2. Generate an inclusive date range for the requested period
//! 3. Carry-forward fill: days without data inherit the last known balance
//!
//! Also includes [`transform_marketplace_credits`] (cumulative daily running
//! totals) and [`calculate_storage_cost`] (pricing model computation).

use chrono::{Datelike, NaiveDate, Utc, Weekday};
use serde::{Deserialize, Serialize};

/// Raw account snapshot from the indexer, used as input for all chart types.
#[derive(Deserialize, Clone, Debug)]
pub struct AccountInput {
    pub total_balance: String,
    pub processed_timestamp: String,
    pub credit: Option<String>,
}

/// Single data point for frontend chart rendering.
///
/// The `x` field is an ISO 8601 date string used as the chart axis value.
/// Optional fields (`band_label`, `credit`, `formatted_credit`) are only
/// populated for chart types that need them.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChartPoint {
    pub x: String,
    pub balance: f64,
    pub formatted_balance: String,
    pub timestamp: String,
    pub day_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub band_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted_credit: Option<String>,
}

const WEEKDAYS_FULL: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

const MONTHS_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Hippius creation date (March 11, 2025) — lower bound for "max" range.
fn hippius_creation_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2025, 3, 11).unwrap()
}

/// Divide a raw balance string (representing value * 10^18) by 10^18 and
/// format with up to `decimals` fractional digits, trimming trailing zeros.
/// Adds comma grouping to the integer part (matching JS `toLocaleString`).
fn format_balance(raw: &str, decimals: usize) -> String {
    let num: f64 = raw.parse().unwrap_or(0.0);
    let value = num / 1e18;
    if value == 0.0 {
        return "0".to_string();
    }
    let fixed = format!("{:.prec$}", value, prec = decimals);
    let trimmed = trim_trailing_zeros(&fixed);
    add_commas(trimmed)
}

/// Format bytes using SI units (1000-based): B, KB, MB, GB, TB, PB.
fn format_bytes(bytes: f64) -> String {
    if bytes == 0.0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    let k: f64 = 1000.0;
    let i = (bytes.ln() / k.ln())
        .floor()
        .max(0.0)
        .min((units.len() - 1) as f64) as usize;
    let val = bytes / k.powi(i as i32);
    let formatted = format!("{:.2}", val);
    let trimmed = trim_trailing_zeros(&formatted);
    format!("{} {}", trimmed, units[i])
}

/// Generate an inclusive date range from `start` to `end`.
fn get_all_dates_in_range(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    let mut dates = Vec::new();
    let mut cur = start;
    while cur <= end {
        dates.push(cur);
        cur = cur.succ_opt().unwrap_or(cur);
        if cur == start && dates.len() > 1 {
            break;
        }
    }
    dates
}

fn normalize_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn date_to_iso(date: NaiveDate) -> String {
    format!("{}T00:00:00.000Z", normalize_date(date))
}

/// Trim trailing zeros from a decimal string, also removing a trailing dot.
fn trim_trailing_zeros(s: &str) -> &str {
    if !s.contains('.') {
        return s;
    }
    let s = s.trim_end_matches('0');
    s.trim_end_matches('.')
}

/// Add comma grouping to the integer part of a number string.
fn add_commas(s: &str) -> String {
    let (int_part, frac_part) = match s.find('.') {
        Some(pos) => (&s[..pos], Some(&s[pos..])),
        None => (s, None),
    };
    let int_with_commas = add_commas_to_int(int_part);
    match frac_part {
        Some(f) => format!("{}{}", int_with_commas, f),
        None => int_with_commas,
    }
}

fn add_commas_to_int(s: &str) -> String {
    let (neg, digits) = if s.starts_with('-') {
        (true, &s[1..])
    } else {
        (false, s)
    };
    let mut result = String::new();
    for (i, ch) in digits.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(ch);
    }
    let ordered: String = result.chars().rev().collect();
    if neg {
        format!("-{}", ordered)
    } else {
        ordered
    }
}

/// Parse an ISO timestamp string to a `NaiveDate`, trying multiple formats.
fn parse_timestamp_to_date(ts: &str) -> Option<NaiveDate> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
        return Some(dt.date_naive());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.fZ") {
        return Some(dt.date());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%SZ") {
        return Some(dt.date());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(dt.date());
    }
    if let Ok(d) = NaiveDate::parse_from_str(ts, "%Y-%m-%d") {
        return Some(d);
    }
    None
}

/// Convert `chrono::Weekday` (Mon=0) to JS-style weekday index (Sun=0).
fn weekday_index(d: NaiveDate) -> usize {
    match d.weekday() {
        Weekday::Sun => 0,
        Weekday::Mon => 1,
        Weekday::Tue => 2,
        Weekday::Wed => 3,
        Weekday::Thu => 4,
        Weekday::Fri => 5,
        Weekday::Sat => 6,
    }
}

fn weekday_name(d: NaiveDate) -> &'static str {
    WEEKDAYS_FULL[weekday_index(d)]
}

fn dd_mon_label(d: NaiveDate) -> String {
    format!("{} {}", d.day(), MONTHS_SHORT[d.month0() as usize])
}

/// Compute the start date for a given range keyword.
fn range_start(range: &str, today: NaiveDate) -> Option<NaiveDate> {
    match range {
        "last7days" => today.checked_sub_signed(chrono::Duration::days(6)),
        "last30days" => today.checked_sub_signed(chrono::Duration::days(29)),
        "last60days" => today.checked_sub_signed(chrono::Duration::days(59)),
        "year" => today.checked_sub_signed(chrono::Duration::days(365)),
        "max" => Some(hippius_creation_date()),
        _ => None,
    }
}

struct RawPoint {
    date: NaiveDate,
    balance: f64,
    credit: Option<f64>,
}

fn accounts_to_raw_points(accounts: &[AccountInput], divide_by_1e18: bool) -> Vec<RawPoint> {
    let mut points: Vec<RawPoint> = accounts
        .iter()
        .filter_map(|acc| {
            let date = parse_timestamp_to_date(&acc.processed_timestamp)?;
            let raw_val: f64 = acc.total_balance.parse().unwrap_or(0.0);
            let balance = if divide_by_1e18 {
                raw_val / 1e18
            } else {
                raw_val
            };
            let credit = acc.credit.as_ref().map(|c| {
                let v: f64 = c.parse().unwrap_or(0.0);
                if divide_by_1e18 { v / 1e18 } else { v }
            });
            Some(RawPoint {
                date,
                balance,
                credit,
            })
        })
        .collect();
    points.sort_by_key(|p| p.date);
    points
}

/// Map data to a date range with carry-forward fill (cumulative).
///
/// For each day in the range, uses the last known balance if no data point
/// exists for that day. This produces a smooth step-chart suitable for
/// displaying cumulative metrics like balance or storage usage.
fn map_to_range_carry_forward(
    points: &[RawPoint],
    date_range: &[NaiveDate],
    range: &str,
    divide_by_1e18: bool,
    include_credit: bool,
) -> Vec<ChartPoint> {
    if date_range.is_empty() {
        return Vec::new();
    }

    let mut by_date = std::collections::HashMap::new();
    for p in points {
        by_date.insert(normalize_date(p.date), p);
    }

    let first_key = normalize_date(date_range[0]);
    let mut last_balance: f64 = 0.0;
    let mut last_credit: Option<f64> = if include_credit { Some(0.0) } else { None };
    for p in points {
        let pk = normalize_date(p.date);
        if pk <= first_key {
            if p.balance > last_balance {
                last_balance = p.balance;
            }
            if include_credit {
                if let Some(c) = p.credit {
                    last_credit = Some(c);
                }
            }
        }
    }

    let is_last7 = range == "last7days";

    date_range
        .iter()
        .map(|&date| {
            let key = normalize_date(date);
            let has_data = by_date.contains_key(&key);

            if has_data {
                let p = by_date[&key];
                last_balance = p.balance;
                if include_credit {
                    if let Some(c) = p.credit {
                        last_credit = Some(c);
                    }
                }
            }

            let day_label = if is_last7 {
                weekday_name(date).to_string()
            } else {
                dd_mon_label(date)
            };

            let band_label = if is_last7 {
                Some(weekday_name(date).to_string())
            } else {
                None
            };

            let formatted_balance = if divide_by_1e18 {
                format_balance(&format!("{}", (last_balance * 1e18) as u128), 6)
            } else {
                format_bytes(last_balance)
            };

            let (credit_val, formatted_credit_val) = if include_credit {
                let c = last_credit.unwrap_or(0.0);
                let fc = format_balance(&format!("{}", (c * 1e18) as u128), 6);
                (Some(c), Some(fc))
            } else {
                (None, None)
            };

            ChartPoint {
                x: date_to_iso(date),
                balance: last_balance,
                formatted_balance,
                timestamp: if has_data { key } else { String::new() },
                day_label,
                band_label,
                credit: credit_val,
                formatted_credit: formatted_credit_val,
            }
        })
        .collect()
}

/// Build chart points for a given range (shared logic for all chart types).
fn build_chart(
    accounts: &[AccountInput],
    range: &str,
    divide_by_1e18: bool,
    include_credit: bool,
) -> Vec<ChartPoint> {
    if accounts.is_empty() {
        return Vec::new();
    }

    let points = accounts_to_raw_points(accounts, divide_by_1e18);
    if points.is_empty() {
        return Vec::new();
    }

    let today = Utc::now().date_naive();
    let start = match range_start(range, today) {
        Some(s) => s,
        None => return Vec::new(),
    };

    let date_range = get_all_dates_in_range(start, today);
    map_to_range_carry_forward(&points, &date_range, range, divide_by_1e18, include_credit)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Format account data for a credits usage chart.
///
/// Divides `total_balance` by 10^18 to get credit values.
/// Uses carry-forward fill for missing days.
#[tauri::command]
pub fn format_credits_chart(
    accounts: Vec<AccountInput>,
    range: String,
) -> Result<Vec<ChartPoint>, String> {
    Ok(build_chart(&accounts, &range, true, false))
}

/// Format account data for a storage usage chart.
///
/// `total_balance` represents raw bytes (no division).
/// Uses carry-forward fill for missing days.
#[tauri::command]
pub fn format_storage_chart(
    accounts: Vec<AccountInput>,
    range: String,
) -> Result<Vec<ChartPoint>, String> {
    Ok(build_chart(&accounts, &range, false, false))
}

/// Format account data for a balance chart (includes credit field).
///
/// Divides both `total_balance` and `credit` by 10^18.
/// Uses carry-forward fill for missing days.
#[tauri::command]
pub fn format_balance_chart(
    accounts: Vec<AccountInput>,
    range: String,
) -> Result<Vec<ChartPoint>, String> {
    Ok(build_chart(&accounts, &range, true, true))
}

// ---------------------------------------------------------------------------
// Marketplace credits transformation
// ---------------------------------------------------------------------------

/// Raw marketplace credit event from the indexer.
#[derive(Deserialize, Clone, Debug)]
pub struct MarketplaceCreditInput {
    pub amount: String,
    pub date: String,
}

/// Cumulative daily credit total, shaped to match the `Account` struct
/// the frontend chart components expect.
#[derive(Serialize, Clone, Debug)]
pub struct MarketplaceCreditOutput {
    pub account_id: String,
    pub block_number: u64,
    pub nonce: u64,
    pub consumers: u64,
    pub providers: u64,
    pub sufficients: u64,
    pub free_balance: String,
    pub reserved_balance: String,
    pub misc_frozen_balance: String,
    pub fee_frozen_balance: String,
    pub total_balance: String,
    pub processed_timestamp: String,
}

/// Transform marketplace credits into cumulative daily running totals.
///
/// Groups credits by date, fills date gaps, and computes cumulative sums.
/// Returns an `Account`-shaped vec so the result can be fed directly into
/// the same chart components as balance data.
#[tauri::command]
pub fn transform_marketplace_credits(
    credits: Vec<MarketplaceCreditInput>,
) -> Result<Vec<MarketplaceCreditOutput>, String> {
    if credits.is_empty() {
        return Ok(vec![]);
    }

    let mut daily: std::collections::BTreeMap<String, (u128, String)> =
        std::collections::BTreeMap::new();

    for credit in &credits {
        let date_key = parse_date_key(&credit.date);
        let raw_amount = credit.amount.parse::<u128>().unwrap_or(0);
        let entry = daily.entry(date_key).or_insert((0, credit.date.clone()));
        entry.0 += raw_amount;
    }

    if daily.is_empty() {
        return Ok(vec![]);
    }

    let first_key = daily.keys().next().unwrap().clone();
    let last_key = daily.keys().last().unwrap().clone();

    let start_date = NaiveDate::parse_from_str(&first_key, "%Y-%m-%d")
        .map_err(|e| format!("Invalid start date: {e}"))?;
    let end_date = NaiveDate::parse_from_str(&last_key, "%Y-%m-%d")
        .map_err(|e| format!("Invalid end date: {e}"))?;

    let mut results = Vec::new();
    let mut cumulative: u128 = 0;
    let mut current = start_date;
    let fallback_ts = credits[0].date.clone();

    while current <= end_date {
        let key = current.format("%Y-%m-%d").to_string();
        let timestamp = if let Some((amount, ts)) = daily.get(&key) {
            cumulative += amount;
            ts.clone()
        } else {
            fallback_ts.clone()
        };

        results.push(MarketplaceCreditOutput {
            account_id: String::new(),
            block_number: 0,
            nonce: 0,
            consumers: 0,
            providers: 0,
            sufficients: 0,
            free_balance: "0".to_string(),
            reserved_balance: "0".to_string(),
            misc_frozen_balance: "0".to_string(),
            fee_frozen_balance: "0".to_string(),
            total_balance: cumulative.to_string(),
            processed_timestamp: timestamp,
        });

        current += chrono::Duration::days(1);
    }

    Ok(results)
}

fn parse_date_key(date_str: &str) -> String {
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M:%S%.fZ") {
        return dt.format("%Y-%m-%d").to_string();
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M:%S") {
        return dt.format("%Y-%m-%d").to_string();
    }
    date_str.chars().take(10).collect()
}

// ---------------------------------------------------------------------------
// Storage cost calculation
// ---------------------------------------------------------------------------

/// Calculate storage cost for a given storage type, timeframe, and number of GB.
///
/// Embeds the pricing constants from `pricing-cfg.json`. The cost model
/// charges a flat first-hour rate plus per-block charges for the remainder
/// of the timeframe (block time = 6 seconds).
#[tauri::command]
pub fn calculate_storage_cost(
    storage_type: String,
    timeframe: String,
    num_of_gb: f64,
) -> Result<f64, String> {
    let per_block_time: f64 = 6.0;
    let (per_block_charge, first_hour_charge) = match storage_type.as_str() {
        "s3" | "ipfs" => (6.7878e-9, 0.0000315),
        _ => return Err(format!("Unknown storage type: {storage_type}")),
    };

    let timeframe_duration = match timeframe.as_str() {
        "first-hour" => 3600.0,
        "per-month" => 2.628e6,
        "per-year" => 3.154e7,
        _ => return Err(format!("Unknown timeframe: {timeframe}")),
    };
    let first_hour_duration = 3600.0;

    let first_hour_cost = first_hour_charge * num_of_gb;
    let timeframe_minus_first_hour = timeframe_duration - first_hour_duration;
    let single_block_charge = per_block_charge * num_of_gb;
    let block_charge_count = timeframe_minus_first_hour / per_block_time;
    let subsequent_time_cost = single_block_charge * block_charge_count;

    Ok(first_hour_cost + subsequent_time_cost)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_balance_basic() {
        assert_eq!(format_balance("1000000000000000000", 6), "1");
        assert_eq!(format_balance("0", 6), "0");
        assert_eq!(format_balance("500000000000000000", 6), "0.5");
        assert_eq!(format_balance("1234567890000000000000", 6), "1,234.56789");
    }

    #[test]
    fn test_format_bytes_basic() {
        assert_eq!(format_bytes(0.0), "0 B");
        assert_eq!(format_bytes(500.0), "500 B");
        assert_eq!(format_bytes(1000.0), "1 KB");
        assert_eq!(format_bytes(1500.0), "1.5 KB");
        assert_eq!(format_bytes(1_000_000.0), "1 MB");
        assert_eq!(format_bytes(1_500_000.0), "1.5 MB");
        assert_eq!(format_bytes(1_000_000_000.0), "1 GB");
    }

    #[test]
    fn test_get_all_dates_in_range() {
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2025, 1, 3).unwrap();
        let dates = get_all_dates_in_range(start, end);
        assert_eq!(dates.len(), 3);
        assert_eq!(dates[0], start);
        assert_eq!(dates[2], end);
    }

    #[test]
    fn test_normalize_date() {
        let d = NaiveDate::from_ymd_opt(2025, 3, 5).unwrap();
        assert_eq!(normalize_date(d), "2025-03-05");
    }

    #[test]
    fn test_date_to_iso() {
        let d = NaiveDate::from_ymd_opt(2025, 3, 15).unwrap();
        assert_eq!(date_to_iso(d), "2025-03-15T00:00:00.000Z");
    }

    #[test]
    fn test_empty_accounts() {
        let result = build_chart(&[], "last7days", true, false);
        assert!(result.is_empty());
    }

    #[test]
    fn test_credits_chart_single_account() {
        let accounts = vec![AccountInput {
            total_balance: "2000000000000000000".to_string(),
            processed_timestamp: Utc::now().format("%Y-%m-%dT%H:%M:%S.000Z").to_string(),
            credit: None,
        }];
        let result = build_chart(&accounts, "last7days", true, false);
        assert_eq!(result.len(), 7);
        // Last day should have balance 2.0
        assert!((result.last().unwrap().balance - 2.0).abs() < f64::EPSILON);
        // Should have weekday labels
        assert!(!result[0].day_label.is_empty());
        // Should have band labels for last7days
        assert!(result[0].band_label.is_some());
    }

    #[test]
    fn test_balance_chart_includes_credit() {
        let accounts = vec![AccountInput {
            total_balance: "1000000000000000000".to_string(),
            processed_timestamp: Utc::now().format("%Y-%m-%dT%H:%M:%S.000Z").to_string(),
            credit: Some("500000000000000000".to_string()),
        }];
        let result = build_chart(&accounts, "last7days", true, true);
        assert_eq!(result.len(), 7);
        let last = result.last().unwrap();
        assert!(last.credit.is_some());
        assert!((last.credit.unwrap() - 0.5).abs() < f64::EPSILON);
        assert!(last.formatted_credit.is_some());
    }

    #[test]
    fn test_storage_chart_no_division() {
        let accounts = vec![AccountInput {
            total_balance: "1500000".to_string(),
            processed_timestamp: Utc::now().format("%Y-%m-%dT%H:%M:%S.000Z").to_string(),
            credit: None,
        }];
        let result = build_chart(&accounts, "last7days", false, false);
        assert_eq!(result.len(), 7);
        let last = result.last().unwrap();
        assert!((last.balance - 1_500_000.0).abs() < f64::EPSILON);
        assert!(last.formatted_balance.contains("MB"));
    }

    #[test]
    fn test_add_commas() {
        assert_eq!(add_commas("1234567"), "1,234,567");
        assert_eq!(add_commas("123"), "123");
        assert_eq!(add_commas("1234.56"), "1,234.56");
    }

    #[test]
    fn test_parse_timestamp() {
        let d = parse_timestamp_to_date("2025-03-15T10:30:00.000Z");
        assert_eq!(d, Some(NaiveDate::from_ymd_opt(2025, 3, 15).unwrap()));

        let d2 = parse_timestamp_to_date("2025-03-15");
        assert_eq!(d2, Some(NaiveDate::from_ymd_opt(2025, 3, 15).unwrap()));
    }

    #[test]
    fn transform_empty_input() {
        let result = transform_marketplace_credits(vec![]).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn transform_single_day() {
        let credits = vec![MarketplaceCreditInput {
            amount: "1000000000000000000".into(),
            date: "2025-03-15T10:00:00.000Z".into(),
        }];
        let result = transform_marketplace_credits(credits).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].total_balance, "1000000000000000000");
    }

    #[test]
    fn transform_fills_gaps() {
        let credits = vec![
            MarketplaceCreditInput {
                amount: "100".into(),
                date: "2025-03-10T00:00:00.000Z".into(),
            },
            MarketplaceCreditInput {
                amount: "200".into(),
                date: "2025-03-13T00:00:00.000Z".into(),
            },
        ];
        let result = transform_marketplace_credits(credits).unwrap();
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].total_balance, "100");
        assert_eq!(result[1].total_balance, "100");
        assert_eq!(result[2].total_balance, "100");
        assert_eq!(result[3].total_balance, "300");
    }

    #[test]
    fn transform_duplicate_dates() {
        let credits = vec![
            MarketplaceCreditInput {
                amount: "100".into(),
                date: "2025-03-15T10:00:00.000Z".into(),
            },
            MarketplaceCreditInput {
                amount: "200".into(),
                date: "2025-03-15T14:00:00.000Z".into(),
            },
        ];
        let result = transform_marketplace_credits(credits).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].total_balance, "300");
    }

    #[test]
    fn transform_large_values() {
        let credits = vec![MarketplaceCreditInput {
            amount: "999999999999999999999".into(),
            date: "2025-03-15T00:00:00.000Z".into(),
        }];
        let result = transform_marketplace_credits(credits).unwrap();
        assert_eq!(result[0].total_balance, "999999999999999999999");
    }

    #[test]
    fn storage_cost_per_month() {
        let cost = calculate_storage_cost("ipfs".into(), "per-month".into(), 1.0).unwrap();
        assert!(cost > 0.0);
    }

    #[test]
    fn storage_cost_zero_gb() {
        let cost = calculate_storage_cost("ipfs".into(), "per-month".into(), 0.0).unwrap();
        assert!((cost - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn storage_cost_fractional_gb() {
        let cost = calculate_storage_cost("s3".into(), "per-year".into(), 0.5).unwrap();
        assert!(cost > 0.0);
    }

    #[test]
    fn storage_cost_unknown_type() {
        assert!(calculate_storage_cost("unknown".into(), "per-month".into(), 1.0).is_err());
    }

    #[test]
    fn storage_cost_unknown_timeframe() {
        assert!(calculate_storage_cost("ipfs".into(), "weekly".into(), 1.0).is_err());
    }

    #[test]
    fn storage_cost_first_hour() {
        let cost = calculate_storage_cost("ipfs".into(), "first-hour".into(), 1.0).unwrap();
        assert!((cost - 0.0000315).abs() < 1e-10);
    }
}
