//! One viewer of a file link, visit by visit (hcfs #1415), for the Insights
//! Viewers tab: a row opens into that viewer's visits and, on a document,
//! their own time per page.
//!
//! `GET /v1/shares/{token}/insights/viewers/{viewer_id}?before=<cursor>`
//! (owner bearer, paid Drive plan, behind `share_insights`) answers the
//! viewer's totals over every visit, their page times, and up to 100 visits
//! newest first with `next_before` for the next page. `viewer_id` is the
//! per-link pseudonym `GET .../insights` lists; nothing here names anyone.
//! The free plan is `403 paid_plan_required`, where the Viewers tab is
//! already the locked sample and never asks.

use serde::{Deserialize, Serialize};

use super::insights::{
    Api, INSIGHTS_UNAVAILABLE, REQUEST_TIMEOUT, SWITCHES_NOT_IN_PLAN, UNREACHABLE, capabilities_checked, path_segment, query_value, read_ok,
    transport,
};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// Said for a viewer the server no longer has visits for.
pub const VIEWER_GONE: &str = "This viewer's visits aren't available any more.";

/// What kind of file a visit opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisitKind {
    Video,
    Image,
    Document,
    /// A kind this build does not know, shown with no time or pages.
    #[serde(other)]
    Other,
}

/// One visit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerVisit {
    /// RFC 3339 UTC.
    pub started_at: String,
    pub last_seen_at: String,
    pub kind: VisitKind,
    /// What Insights counts for the visit; `None` where it counts nothing
    /// (a picture, a video without a length, a document read at another
    /// page count).
    pub time_spent_ms: Option<u64>,
    /// Distinct pages a document visit saw; `None` otherwise.
    pub pages_seen: Option<u32>,
}

/// A page of one viewer's visits, with their totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerVisits {
    pub viewer_id: String,
    /// Every visit counted as this viewer, not only this page.
    pub visits_total: u64,
    /// Their time over every visit.
    pub time_spent_ms: u64,
    /// Milliseconds on each page, page 1 first, `0` for a page they skipped;
    /// `None` without a document visit at the link's page count.
    pub page_time_ms: Option<Vec<u64>>,
    /// Newest first.
    pub visits: Vec<ViewerVisit>,
    /// The cursor of the next page; `None` on the last one.
    pub next_before: Option<String>,
}

#[derive(Deserialize)]
struct WireVisit {
    #[serde(default)]
    started_at: String,
    #[serde(default)]
    last_seen_at: String,
    kind: VisitKind,
    #[serde(default)]
    time_spent_ms: Option<u64>,
    #[serde(default)]
    pages_seen: Option<u32>,
}

#[derive(Deserialize)]
struct Wire {
    #[serde(default)]
    viewer_id: String,
    #[serde(default)]
    visits_total: u64,
    #[serde(default)]
    time_spent_ms: Option<u64>,
    #[serde(default)]
    page_count: Option<u32>,
    #[serde(default)]
    page_time_ms: Option<Vec<u64>>,
    #[serde(default)]
    visits: Vec<WireVisit>,
    #[serde(default)]
    next_before: Option<String>,
}

/// Longest a page list is taken to be: a document of more pages than this
/// is not drawn as bars.
const MAX_PAGES: usize = 1000;

fn parse(body: &str) -> Result<ViewerVisits> {
    let wire: Wire = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("viewer visits parse failed: {e}")))?;
    // Page times go with the page count; a list that disagrees with it, or
    // a count with none, is left out rather than drawn wrong.
    let page_time_ms = match (wire.page_count, wire.page_time_ms) {
        (Some(n), Some(times)) if n > 0 && times.len() == n as usize && times.len() <= MAX_PAGES => Some(times),
        _ => None,
    };
    Ok(ViewerVisits {
        viewer_id: wire.viewer_id,
        visits_total: wire.visits_total,
        time_spent_ms: wire.time_spent_ms.unwrap_or(0),
        page_time_ms,
        visits: wire
            .visits
            .into_iter()
            .filter(|v| !v.started_at.is_empty())
            .map(|v| ViewerVisit {
                last_seen_at: if v.last_seen_at.is_empty() {
                    v.started_at.clone()
                } else {
                    v.last_seen_at
                },
                started_at: v.started_at,
                kind: v.kind,
                time_spent_ms: v.time_spent_ms,
                pages_seen: v.pages_seen.filter(|_| v.kind == VisitKind::Document),
            })
            .collect(),
        next_before: wire.next_before.filter(|c| !c.is_empty()),
    })
}

/// The server's refusals, in the sheet's words.
fn refusal(err: AppError) -> AppError {
    match &err {
        AppError::NotFound(_) => AppError::NotFound(VIEWER_GONE.into()),
        AppError::Api { status: 403, body } if body.contains("paid_plan_required") => AppError::Validation(SWITCHES_NOT_IN_PLAN.into()),
        _ => err,
    }
}

pub(crate) async fn get_viewer_visits(http: &reqwest::Client, api: &Api, token: &str, viewer_id: &str, before: Option<&str>) -> Result<ViewerVisits> {
    let mut url = api.share_url(token, &format!("/insights/viewers/{}", path_segment(viewer_id)?))?;
    if let Some(cursor) = before.filter(|c| !c.is_empty()) {
        url.push_str("?before=");
        url.push_str(&query_value(cursor));
    }
    let resp = http
        .get(url)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("viewer visits", e))?;
    parse(&read_ok(resp).await.map_err(refusal)?)
}

/// One viewer's visits on the file link `share_token`, a page at a time
/// (`before` is the previous page's `nextBefore`).
#[tauri::command]
pub async fn share_viewer_visits(
    state: tauri::State<'_, AppState>,
    share_token: String,
    viewer_id: String,
    before: Option<String>,
) -> Result<ViewerVisits> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_insights {
        return Err(AppError::Validation(INSIGHTS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    get_viewer_visits(&state.api_client, &api, &share_token, &viewer_id, before.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::super::insights::tests::mock;
    use super::*;

    /// The docs' example, as the server sends it.
    const BODY: &str = r#"{
      "viewer_id": "AQEBAQEBAQEBAQEBAQEBAQ",
      "visits_total": 3,
      "time_spent_ms": 540000,
      "page_count": 4,
      "page_time_ms": [42000, 61000, 0, 3000],
      "visits": [
        { "started_at": "2026-11-20T09:12:00Z", "last_seen_at": "2026-11-20T09:20:41Z", "kind": "document", "time_spent_ms": 106000, "pages_seen": 3 },
        { "started_at": "2026-11-19T09:12:00Z", "last_seen_at": "", "kind": "image", "time_spent_ms": null, "pages_seen": 2 },
        { "started_at": "2026-11-18T09:12:00Z", "kind": "hologram" }
      ],
      "next_before": "opaque+cursor/="
    }"#;

    #[tokio::test]
    async fn a_viewers_visits_are_read_with_the_owners_bearer() {
        let (base, seen) = mock(|_| (200, BODY.into())).await;
        let api = Api::new(&base, "owner");
        let got = get_viewer_visits(&reqwest::Client::new(), &api, "tok_1", "AQEBAQEBAQEBAQEBAQEBAQ", Some("opaque+cursor/="))
            .await
            .unwrap();
        assert_eq!((got.visits_total, got.time_spent_ms), (3, 540_000));
        assert_eq!(got.page_time_ms, Some(vec![42_000, 61_000, 0, 3_000]));
        assert_eq!(got.next_before.as_deref(), Some("opaque+cursor/="));
        assert_eq!(got.visits.len(), 3);
        assert_eq!(
            (got.visits[0].kind, got.visits[0].time_spent_ms, got.visits[0].pages_seen),
            (VisitKind::Document, Some(106_000), Some(3))
        );
        // A picture has no pages, and an empty last-seen reads as its start.
        assert_eq!(
            (got.visits[1].pages_seen, got.visits[1].last_seen_at.as_str()),
            (None, "2026-11-19T09:12:00Z")
        );
        assert_eq!(got.visits[2].kind, VisitKind::Other);
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, "/v1/shares/tok_1/insights/viewers/AQEBAQEBAQEBAQEBAQEBAQ");
        assert_eq!(seen[0].query.as_deref(), Some("before=opaque%2Bcursor%2F%3D"));
        assert_eq!(seen[0].auth.as_deref(), Some("Bearer owner"));
        // The IPC shape the panel reads.
        let json = serde_json::to_value(&got).unwrap();
        assert_eq!(json["visitsTotal"], 3);
        assert_eq!(json["visits"][0]["startedAt"], "2026-11-20T09:12:00Z");
        assert_eq!(json["visits"][0]["kind"], "document");
        assert_eq!(json["nextBefore"], "opaque+cursor/=");
    }

    /// Page times that disagree with the page count are not drawn.
    #[test]
    fn page_times_need_the_page_count_they_are_for() {
        let without =
            parse(r#"{"viewer_id":"v","visits_total":1,"time_spent_ms":10,"page_count":null,"page_time_ms":null,"visits":[],"next_before":null}"#)
                .unwrap();
        assert_eq!((without.page_time_ms, without.next_before), (None, None));
        let short = parse(r#"{"viewer_id":"v","page_count":3,"page_time_ms":[1,2]}"#).unwrap();
        assert_eq!(short.page_time_ms, None);
    }

    #[tokio::test]
    async fn refusals_read_in_the_sheets_words_and_ids_are_checked_first() {
        let (base, seen) = mock(|s| {
            if s.path.ends_with("/gone") {
                (404, String::new())
            } else {
                (403, r#"{"error":"paid_plan_required"}"#.into())
            }
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "b"));
        assert!(matches!(get_viewer_visits(&http, &api, "tok", "gone", None).await, Err(AppError::NotFound(m)) if m == VIEWER_GONE));
        assert!(matches!(get_viewer_visits(&http, &api, "tok", "free", None).await, Err(AppError::Validation(m)) if m == SWITCHES_NOT_IN_PLAN));
        let before = seen.lock().unwrap().len();
        assert!(get_viewer_visits(&http, &api, "tok", "../comments", None).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), before, "an id that is not one is never sent");
    }
}
