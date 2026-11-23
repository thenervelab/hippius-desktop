//! "Ends on a chosen date" for a file link (hcfs #1412), beside the 24 hour,
//! 7 day, 30 day and never presets.
//!
//! `PATCH /v1/shares/{token}` `{expires_at}` (owner bearer) sets the link's
//! end to that instant, an RFC 3339 time with an offset. The server takes it
//! only between 2 hours and 365 days from its own clock and answers
//! `{share_token, expires_at}`; outside that, or on a server without
//! `share_expiry_date`, it is a `400` / `422` and nothing changes. The app
//! checks the same bounds first, so the owner reads why at once.
//!
//! The picker gives a day; the link ends at the last second of that day in
//! this computer's zone ([`end_of_day`]). Which days the picker offers is
//! decided here too ([`day_range`]), so the frontend only draws them.
//!
//! During a deploy an older server can answer beside a newer one, so the
//! answer's `expires_at` is compared with the one sent: a mismatch is an
//! error rather than a date the owner did not choose.

use chrono::{DateTime, Duration, FixedOffset, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::insights::{Api, REQUEST_TIMEOUT, UNREACHABLE, capabilities_checked, read_ok, transport};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// The soonest a chosen date may be: the server's bound.
const MIN_AHEAD: Duration = Duration::hours(2);
/// The latest: the server's bound. A link meant to last longer is "never".
const MAX_AHEAD: Duration = Duration::days(365);

pub const NOT_A_DATE: &str = "Choose a date for the link to end.";
pub const TOO_SOON: &str = "Choose a date at least 2 hours from now.";
pub const TOO_LATE: &str = "Choose a date within a year. For longer, choose Until I revoke it.";
pub const DATES_UNAVAILABLE: &str = "Ending a link on a chosen date isn't available yet.";
pub const LINK_GONE: &str = "This link is no longer active, so its expiry cannot be changed.";
/// The server answered with another end than the one sent.
pub const NOT_SAVED: &str = "The new date wasn't saved. Try again.";

/// `expires_at` read and checked against the server's bounds at `now`.
pub fn check(expires_at: &str, now: DateTime<Utc>) -> Result<DateTime<FixedOffset>> {
    let at = DateTime::parse_from_rfc3339(expires_at.trim()).map_err(|_| AppError::Validation(NOT_A_DATE.into()))?;
    let utc = at.with_timezone(&Utc);
    if utc < now + MIN_AHEAD {
        return Err(AppError::Validation(TOO_SOON.into()));
    }
    if utc > now + MAX_AHEAD {
        return Err(AppError::Validation(TOO_LATE.into()));
    }
    Ok(at)
}

/// The last second of `day` ("2026-12-20") in `zone`, as an instant with
/// that zone's offset. A day whose last second is skipped by a clock change
/// takes the latest second that exists.
pub fn end_of_day<Tz: TimeZone>(day: &str, zone: &Tz) -> Result<DateTime<FixedOffset>> {
    let date = NaiveDate::parse_from_str(day.trim(), "%Y-%m-%d").map_err(|_| AppError::Validation(NOT_A_DATE.into()))?;
    let mut time = date.and_time(NaiveTime::from_hms_opt(23, 59, 59).unwrap_or_default());
    // A clock change can skip the last hour; step back until a time exists.
    for _ in 0..4 {
        if let Some(at) = zone.from_local_datetime(&time).latest() {
            return Ok(at.fixed_offset());
        }
        time -= Duration::hours(1);
    }
    Err(AppError::Validation(NOT_A_DATE.into()))
}

/// The days the picker offers at `now` in `zone`: the first whose end is at
/// least 2 hours away, through the last whose end is within a year.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayRange {
    /// "YYYY-MM-DD".
    pub min: String,
    pub max: String,
}

pub fn day_range<Tz: TimeZone>(now: DateTime<Utc>, zone: &Tz) -> DayRange {
    let fits = |d: NaiveDate| {
        end_of_day(&d.format("%Y-%m-%d").to_string(), zone)
            .ok()
            .map(|at| at.with_timezone(&Utc))
            .is_some_and(|at| at >= now + MIN_AHEAD && at <= now + MAX_AHEAD)
    };
    let today = now.with_timezone(zone).date_naive();
    let mut min = today;
    while !fits(min) && min < today + Duration::days(2) {
        min += Duration::days(1);
    }
    let mut max = (now + MAX_AHEAD).with_timezone(zone).date_naive();
    while !fits(max) && max > min {
        max -= Duration::days(1);
    }
    DayRange {
        min: min.format("%Y-%m-%d").to_string(),
        max: max.format("%Y-%m-%d").to_string(),
    }
}

/// The server's refusals, in the app's words.
fn refusal(err: AppError) -> AppError {
    match err {
        AppError::NotFound(_) => AppError::Validation(LINK_GONE.into()),
        // The bounds are the server's clock, a few minutes off this one.
        AppError::Api { status: 400, .. } => AppError::Validation(TOO_SOON_OR_LATE.into()),
        // An older server, which takes only `ttl` here.
        AppError::Api { status: 422, .. } => AppError::Validation(DATES_UNAVAILABLE.into()),
        other => other,
    }
}

const TOO_SOON_OR_LATE: &str = "Choose a date between 2 hours and a year from now.";

/// Sends `at` as the link's end and answers the end the server stored.
pub(crate) async fn patch_expiry_date(http: &reqwest::Client, api: &Api, token: &str, at: DateTime<FixedOffset>) -> Result<String> {
    #[derive(Deserialize)]
    struct Answer {
        #[serde(default)]
        expires_at: Option<String>,
    }
    let resp = http
        .patch(api.share_url(token, "")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .json(&serde_json::json!({ "expires_at": at.to_rfc3339() }))
        .send()
        .await
        .map_err(|e| transport("share expiry", e))?;
    let body = read_ok(resp).await.map_err(refusal)?;
    let answer: Answer = serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("share expiry parse failed: {e}")))?;
    let stored = answer.expires_at.as_deref().and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    // The server may write the instant in another offset or precision; it
    // is the same end when it names the same second.
    match stored {
        Some(s) if s.timestamp() == at.timestamp() => Ok(s.with_timezone(&Utc).to_rfc3339()),
        _ => {
            warn!("share expiry: the server stored another end than the one sent");
            Err(AppError::Validation(NOT_SAVED.into()))
        }
    }
}

/// The days the expiry picker offers, in this computer's zone.
#[tauri::command]
pub fn share_expiry_day_range() -> DayRange {
    day_range(Utc::now(), &Local)
}

/// End the file link `share_token` at the end of `day` ("YYYY-MM-DD") in
/// this computer's zone. Answers the stored end, RFC 3339 in UTC.
#[tauri::command]
pub async fn share_set_expiry_date(state: tauri::State<'_, AppState>, share_token: String, day: String) -> Result<String> {
    let account_id = state.current_account_id()?;
    let at = check(&end_of_day(&day, &Local)?.to_rfc3339(), Utc::now())?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_expiry_date {
        return Err(AppError::Validation(DATES_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    patch_expiry_date(&state.api_client, &api, &share_token, at).await
}

#[cfg(test)]
mod tests {
    use super::super::insights::tests::mock;
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-23T12:00:00Z").unwrap().with_timezone(&Utc)
    }

    #[test]
    fn a_date_is_checked_against_the_servers_bounds() {
        let ok = |s: &str| check(s, now()).is_ok();
        assert!(ok("2026-12-20T23:59:59-05:00"));
        assert!(ok("2026-11-23T14:00:00Z"), "exactly 2 hours ahead");
        assert!(ok("2027-11-23T12:00:00Z"), "exactly a year ahead");
        let refused = |s: &str| match check(s, now()) {
            Err(AppError::Validation(m)) => m,
            other => panic!("{s}: {other:?}"),
        };
        assert_eq!(refused("2026-11-23T13:59:59Z"), TOO_SOON);
        assert_eq!(refused("2026-11-20T00:00:00Z"), TOO_SOON);
        assert_eq!(refused("2027-11-23T12:00:01Z"), TOO_LATE);
        assert_eq!(refused("2026-12-20"), NOT_A_DATE, "a day without a time is not an instant");
        assert_eq!(refused("2026-12-20T23:59:59"), NOT_A_DATE, "a time without an offset is not an instant");
        assert_eq!(refused(""), NOT_A_DATE);
    }

    #[test]
    fn a_day_ends_at_its_last_second_in_the_zone() {
        let zone = FixedOffset::west_opt(5 * 3600).unwrap();
        assert_eq!(end_of_day("2026-12-20", &zone).unwrap().to_rfc3339(), "2026-12-20T23:59:59-05:00");
        assert_eq!(end_of_day("2026-12-20", &Utc).unwrap().to_rfc3339(), "2026-12-20T23:59:59+00:00");
        assert!(end_of_day("20 Dec", &Utc).is_err());
    }

    /// The picker starts on the first day that ends 2 hours from now or
    /// later, and stops on the last day that ends within a year.
    #[test]
    fn the_picker_offers_the_days_the_server_takes() {
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        let range = day_range(at("2026-11-23T12:00:00Z"), &Utc);
        assert_eq!(
            range,
            DayRange {
                min: "2026-11-23".into(),
                max: "2027-11-22".into()
            }
        );
        // Late in the day, today ends too soon.
        let late = day_range(at("2026-11-23T22:30:00Z"), &Utc);
        assert_eq!(late.min, "2026-11-24");
        // Every offered day is one the server takes.
        for day in [&range.min, &range.max, &late.min, &late.max] {
            let now = if day.as_str() == late.min || day.as_str() == late.max {
                at("2026-11-23T22:30:00Z")
            } else {
                at("2026-11-23T12:00:00Z")
            };
            assert!(check(&end_of_day(day, &Utc).unwrap().to_rfc3339(), now).is_ok(), "{day}");
        }
    }

    #[tokio::test]
    async fn the_chosen_end_is_patched_with_the_owners_bearer() {
        let (base, seen) = mock(|_| (200, r#"{"share_token":"tok","expires_at":"2026-12-21T04:59:59+00:00"}"#.into())).await;
        let at = check("2026-12-20T23:59:59-05:00", now()).unwrap();
        let stored = patch_expiry_date(&reqwest::Client::new(), &Api::new(&base, "owner"), "tok", at)
            .await
            .unwrap();
        assert_eq!(stored, "2026-12-21T04:59:59+00:00");
        let seen = seen.lock().unwrap();
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("PATCH", "/v1/shares/tok"));
        assert_eq!(seen[0].auth.as_deref(), Some("Bearer owner"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&seen[0].body).unwrap(),
            serde_json::json!({"expires_at": "2026-12-20T23:59:59-05:00"})
        );
    }

    /// An older server beside a newer one during a deploy may keep another
    /// end; that is not the date the owner chose.
    #[tokio::test]
    async fn another_stored_end_is_not_a_success() {
        let (base, _) = mock(|_| (200, r#"{"share_token":"tok","expires_at":"2026-11-24T12:00:00Z"}"#.into())).await;
        let at = check("2026-12-20T23:59:59Z", now()).unwrap();
        assert!(matches!(
            patch_expiry_date(&reqwest::Client::new(), &Api::new(&base, "b"), "tok", at).await,
            Err(AppError::Validation(m)) if m == NOT_SAVED
        ));
    }

    #[tokio::test]
    async fn the_servers_refusals_read_in_the_apps_words() {
        let at = check("2026-12-20T23:59:59Z", now()).unwrap();
        for (status, want) in [(404, LINK_GONE), (400, TOO_SOON_OR_LATE), (422, DATES_UNAVAILABLE)] {
            let (base, _) = mock(move |_| (status, String::new())).await;
            let got = patch_expiry_date(&reqwest::Client::new(), &Api::new(&base, "b"), "tok", at).await;
            assert!(matches!(&got, Err(AppError::Validation(m)) if m == want), "{status}: {got:?}");
        }
    }
}
