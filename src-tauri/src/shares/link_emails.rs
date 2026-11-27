//! A file link's own email setting: which visit emails its owner gets about
//! that one link.
//!
//! - Every visit (`every`): the first-view email, then one email per batch
//!   of new visits.
//! - First visit (`first`, the server's default): the first-view email only.
//! - Off (`off`): no email about the link at all (no first view, visits,
//!   return visits, comments, NDA accepts or refused viewers). The summary
//!   still counts it.
//!
//! The setting is read from the owner listing (`notifications.visits` on
//! each `GET /v1/shares` row; the link's `/meta` never carries it) and set
//! with `PUT /v1/shares/{token}/notifications` `{ "visits": ... }`. Both only
//! on a server that advertises `share_link_notifications`; on any other the
//! setting reads as unknown and the dialog shows nothing for it.
//!
//! The account's First views email still decides whether the first-view and
//! every-visit emails go at all; this setting only picks among them per link.

use serde::{Deserialize, Serialize};

use super::insights::{Api, REQUEST_TIMEOUT, capabilities_or_none, read_ok, transport};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// Said when the server has no per-link email setting.
pub const LINK_EMAILS_UNAVAILABLE: &str = "Emails about one link aren't available yet.";

/// Which visit emails the owner gets about one link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisitEmails {
    Every,
    First,
    Off,
}

impl VisitEmails {
    fn from_wire(raw: &str) -> Option<Self> {
        match raw {
            "every" => Some(Self::Every),
            "first" => Some(Self::First),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
struct WireRow {
    #[serde(default)]
    share_token: String,
    #[serde(default)]
    notifications: Option<WireNotifications>,
}

#[derive(Deserialize)]
struct WireNotifications {
    #[serde(default)]
    visits: Option<String>,
}

/// `token`'s setting in a `GET /v1/shares` body. `None` when the link is not
/// listed, when the row has no `notifications` (a server that predates the
/// setting), or when the value is one this build does not know: never a
/// guess, so the dialog shows nothing rather than a wrong choice.
fn visits_in_listing(body: &str, token: &str) -> Result<Option<VisitEmails>> {
    let rows: Vec<WireRow> = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("share listing parse failed: {e}")))?;
    Ok(rows
        .into_iter()
        .find(|row| row.share_token == token)
        .and_then(|row| row.notifications)
        .and_then(|n| n.visits)
        .as_deref()
        .and_then(VisitEmails::from_wire))
}

fn link_notifications_body(visits: VisitEmails) -> serde_json::Value {
    serde_json::json!({ "visits": visits })
}

async fn get_visits(http: &reqwest::Client, api: &Api, token: &str) -> Result<Option<VisitEmails>> {
    let resp = http
        .get(api.listing_url())
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("share listing", e))?;
    visits_in_listing(&read_ok(resp).await?, token)
}

async fn put_visits(http: &reqwest::Client, api: &Api, token: &str, visits: VisitEmails) -> Result<()> {
    let resp = http
        .put(api.share_url(token, "/notifications")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .json(&link_notifications_body(visits))
        .send()
        .await
        .map_err(|e| transport("link emails", e))?;
    read_ok(resp).await.map(|_| ())
}

/// A file link's email setting, or `None` when this server has none (or
/// does not say), in which case the dialog shows nothing for it.
#[tauri::command]
pub async fn share_get_link_visit_emails(state: tauri::State<'_, AppState>, share_token: String) -> Result<Option<VisitEmails>> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_link_notifications {
        return Ok(None);
    }
    let api = Api::for_account(&state, &account_id).await?;
    get_visits(&state.api_client, &api, &share_token).await
}

/// Set a file link's email setting.
#[tauri::command]
pub async fn share_set_link_visit_emails(state: tauri::State<'_, AppState>, share_token: String, visits: VisitEmails) -> Result<()> {
    let account_id = state.current_account_id()?;
    if !capabilities_or_none(&state, &account_id).await.share_link_notifications {
        return Err(AppError::Validation(LINK_EMAILS_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    put_visits(&state.api_client, &api, &share_token, visits).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shares::insights::tests::mock;

    #[test]
    fn the_setting_is_read_from_the_links_own_row_and_never_guessed() {
        let body = r#"[
            {"share_token":"a","notifications":{"visits":"every"}},
            {"share_token":"b","notifications":{"visits":"off"}},
            {"share_token":"c","notifications":{"visits":"first"}},
            {"share_token":"old"},
            {"share_token":"later","notifications":{"visits":"hourly"}},
            {"share_token":"empty","notifications":{}}
        ]"#;
        assert_eq!(visits_in_listing(body, "a").unwrap(), Some(VisitEmails::Every));
        assert_eq!(visits_in_listing(body, "b").unwrap(), Some(VisitEmails::Off));
        assert_eq!(visits_in_listing(body, "c").unwrap(), Some(VisitEmails::First));
        assert_eq!(visits_in_listing(body, "old").unwrap(), None, "a server without the setting shows none");
        assert_eq!(visits_in_listing(body, "later").unwrap(), None, "an unknown value is not read as another");
        assert_eq!(visits_in_listing(body, "empty").unwrap(), None);
        assert_eq!(visits_in_listing(body, "missing").unwrap(), None, "a link not listed has no setting");
        assert!(visits_in_listing("not json", "a").is_err());
    }

    #[test]
    fn the_setting_crosses_ipc_and_the_wire_in_lowercase() {
        assert_eq!(link_notifications_body(VisitEmails::Every), serde_json::json!({"visits": "every"}));
        assert_eq!(link_notifications_body(VisitEmails::First), serde_json::json!({"visits": "first"}));
        assert_eq!(link_notifications_body(VisitEmails::Off), serde_json::json!({"visits": "off"}));
        assert_eq!(serde_json::to_value(Some(VisitEmails::Every)).unwrap(), serde_json::json!("every"));
        assert_eq!(serde_json::to_value(None::<VisitEmails>).unwrap(), serde_json::Value::Null);
        assert_eq!(serde_json::from_value::<VisitEmails>(serde_json::json!("off")).unwrap(), VisitEmails::Off);
        assert!(serde_json::from_value::<VisitEmails>(serde_json::json!("sometimes")).is_err());
    }

    #[tokio::test]
    async fn the_setting_round_trips_the_server() {
        let (base, seen) = mock(|s| {
            if s.method == "GET" {
                (200, r#"[{"share_token":"tok_1","notifications":{"visits":"first"}}]"#.into())
            } else if s.path == "/v1/shares/gone/notifications" {
                (404, String::new())
            } else {
                (200, r#"{"visits":"every"}"#.into())
            }
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "owner-bearer"));
        assert_eq!(get_visits(&http, &api, "tok_1").await.unwrap(), Some(VisitEmails::First));
        put_visits(&http, &api, "tok_1", VisitEmails::Every).await.unwrap();
        assert!(matches!(
            put_visits(&http, &api, "gone", VisitEmails::Off).await,
            Err(AppError::NotFound(_))
        ));
        assert!(
            matches!(put_visits(&http, &api, "../x", VisitEmails::Off).await, Err(AppError::Validation(_))),
            "a token that is not one never builds a request"
        );

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("GET", "/v1/shares"));
        assert_eq!(seen[0].auth.as_deref(), Some("Bearer owner-bearer"));
        assert_eq!(
            (seen[1].method.as_str(), seen[1].path.as_str()),
            ("PUT", "/v1/shares/tok_1/notifications")
        );
        assert_eq!(seen[1].auth.as_deref(), Some("Bearer owner-bearer"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&seen[1].body).unwrap(),
            serde_json::json!({"visits": "every"})
        );
    }
}
