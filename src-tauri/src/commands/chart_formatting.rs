//! Chart data formatting commands.
//!
//! Provides three Tauri commands that convert raw `Account` data into
//! `ChartPoint` vectors suitable for frontend chart rendering. This replaces
//! the TypeScript formatters in `getFormatDataForCreditsUsageChart.tsx`,
//! `getFormatDataForStorageUsageChart.tsx`, and `getFormatDataForAccountsChart.tsx`.

use chrono::{Datelike, NaiveDate, Utc, Weekday};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
pub struct AccountInput {
    pub total_balance: String,
    pub processed_timestamp: String,
    pub credit: Option<String>,
}

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
    "Nov", "Dec",
];

/// Hippius creation date (March 11, 2025).
fn hippius_creation_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2025, 3, 11).unwrap()
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Divide a raw balance string (representing value × 10^18) by 10^18 and
/// format with up to `decimals` fractional digits, trimming trailing zeros.
/// Adds comma grouping to the integer part (matching JS `toLocaleString`).
fn format_balance(raw: &str, decimals: usize) -> String {
    let num: f64 = raw.parse().unwrap_or(0.0);
    let value = num / 1e18;
    if value == 0.0 {
        return "0".to_string();
    }
    // Format with fixed decimal places then trim trailing zeros.
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
    let i = (bytes.ln() / k.ln()).floor().max(0.0).min((units.len() - 1) as f64) as usize;
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
            break; // safety: avoid infinite loop on overflow
        }
    }
    dates
}

/// Format a `NaiveDate` as `YYYY-MM-DD`.
fn normalize_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// Format a `NaiveDate` as an ISO 8601 string with `T00:00:00.000Z` suffix.
fn date_to_iso(date: NaiveDate) -> String {
    format!("{}T00:00:00.000Z", normalize_date(date))
}

/// Trim trailing zeros from a decimal string. Also removes a trailing dot.
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

/// Parse an ISO timestamp string to a `NaiveDate`, extracting the UTC date.
fn parse_timestamp_to_date(ts: &str) -> Option<NaiveDate> {
    // Try full ISO 8601 datetime first
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
        return Some(dt.date_naive());
    }
    // Try `YYYY-MM-DDTHH:MM:SS.sssZ` (common JS format)
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.fZ") {
        return Some(dt.date());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%SZ") {
        return Some(dt.date());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(dt.date());
    }
    // Try plain date
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

/// "DD Mon" label, e.g. "5 Mar".
fn dd_mon_label(d: NaiveDate) -> String {
    format!("{} {}", d.day(), MONTHS_SHORT[d.month0() as usize])
}

/// Compute the start date for a given range.
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

// ---------------------------------------------------------------------------
// Core chart logic (shared between commands)
// ---------------------------------------------------------------------------

/// Internal chart point used during computation.
struct RawPoint {
    date: NaiveDate,
    balance: f64,
    credit: Option<f64>,
}

fn accounts_to_raw_points(
    accounts: &[AccountInput],
    divide_by_1e18: bool,
) -> Vec<RawPoint> {
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

    // Build a map of date -> last point on that date
    let mut by_date = std::collections::HashMap::new();
    for p in points {
        by_date.insert(normalize_date(p.date), p);
    }

    // Find the last known balance before or on the first date in range
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
                format_balance(
                    &format!("{}", (last_balance * 1e18) as u128),
                    6,
                )
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

/// Build chart points for a given range (shared logic).
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
/// - Divides `total_balance` by 10^18 to get credit values.
/// - Uses carry-forward fill for missing days.
#[tauri::command]
pub fn format_credits_chart(
    accounts: Vec<AccountInput>,
    range: String,
) -> Result<Vec<ChartPoint>, String> {
    Ok(build_chart(&accounts, &range, true, false))
}

/// Format account data for a storage usage chart.
///
/// - `total_balance` represents bytes (no division).
/// - Uses carry-forward fill for missing days.
#[tauri::command]
pub fn format_storage_chart(
    accounts: Vec<AccountInput>,
    range: String,
) -> Result<Vec<ChartPoint>, String> {
    Ok(build_chart(&accounts, &range, false, false))
}

/// Format account data for a balance chart (includes credit field).
///
/// - Divides `total_balance` and `credit` by 10^18.
/// - Uses carry-forward fill for missing days.
#[tauri::command]
pub fn format_balance_chart(
    accounts: Vec<AccountInput>,
    range: String,
) -> Result<Vec<ChartPoint>, String> {
    Ok(build_chart(&accounts, &range, true, true))
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
}
