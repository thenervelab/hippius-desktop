//! Link activity: an OS notification when the owner's file links get new
//! views, a row in the notification center for each, and the last few for the
//! tray popover.
//!
//! While the app runs, the owner's file listing (`GET /v1/shares`) is read
//! every [`POLL_EVERY`]. Each link's `counts.new_views` (visits since the
//! owner last opened its Insights) is compared with the last poll, so a
//! notification says only what is new since then, batched per link
//! ("3 new views on deck.pdf"), never one per view. More than
//! [`MAX_SEPARATE`] links in one poll make one notification for all of them.
//! The first poll for an account only learns where the counts stand, so a
//! restart never replays views already there.
//!
//! Only on a server with `share_insights` and `share_listing_counts`; any
//! other server is sent nothing. Rows go to the notification center under
//! the "Link activity" category, which the center shows only while that
//! category is on (`notifications::crud` seeds it on); the OS notification
//! is shown only then too.
//!
//! The notification plugin reports no click on desktop, but a click brings
//! the app forward. So a notification shown while the main window was not
//! focused is remembered for [`CLICK_WINDOW`], and the main window gaining
//! focus within it opens that link's Insights ([`on_main_window_focused`]).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, warn};

use super::folder_insights::OwnerApi;
use super::insights::capabilities_or_none;
use super::link_activity::get_listing;
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// The preference row (`notification_preferences.id`), seeded on.
pub const PREFERENCE_ID: &str = "link_activity";
/// The category's name: the preference's label and each row's
/// `notification_type`, which the center matches on.
pub const NOTIFICATION_TYPE: &str = "Link activity";
/// How often the listing is read.
pub const POLL_EVERY: Duration = Duration::from_mins(2);
/// How long after a notification a return to the app counts as its click.
pub const CLICK_WINDOW: Duration = Duration::from_secs(90);
/// Links that each get their own notification in one poll; more make one.
pub const MAX_SEPARATE: usize = 3;
/// To the main window: open a link's Insights (`{ shareToken }`), or Shared
/// Links when `shareToken` is `null`. The tray popover sends it too.
pub const OPEN_LINK_INSIGHTS_EVENT: &str = "hippius:open-link-insights";
/// To every window: a new link activity row was saved.
pub const LINK_ACTIVITY_CHANGED_EVENT: &str = "hippius:link-activity-changed";
/// A row's subtype: `LinkViews-<token>` for one link, `LinkViews` for many.
const SUBTYPE: &str = "LinkViews";

const MAIN_WINDOW_LABEL: &str = "main";

/// What the poller remembers between polls.
#[derive(Debug, Default)]
pub struct LinkAlertsState {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    /// The account the counts below are for.
    account: Option<String>,
    /// A poll for that account has been read.
    primed: bool,
    /// `new_views` per link at the last poll.
    seen: HashMap<String, u64>,
    /// The last notification shown while the app was in the background:
    /// the link to open (`None` for many), and when.
    pending_open: Option<(PendingOpen, Instant)>,
}

/// What a notification's click opens: one link's Insights, or Shared Links
/// for many links (`share_token` `None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingOpen {
    share_token: Option<String>,
}

/// One file link as the poller reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingRow {
    pub share_token: String,
    pub file_name: String,
    pub new_views: u64,
}

#[derive(Debug, Deserialize)]
struct WireCounts {
    #[serde(default)]
    new_views: u64,
}

#[derive(Debug, Deserialize)]
struct WireRow {
    #[serde(default)]
    share_token: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    counts: Option<WireCounts>,
}

/// The listing's links, with no new views for one without counts (its
/// Insights are off).
pub fn parse_rows(body: &str) -> Result<Vec<ListingRow>> {
    let rows: Vec<WireRow> = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("share listing parse failed: {e}")))?;
    Ok(rows
        .into_iter()
        .filter(|r| !r.share_token.is_empty())
        .map(|r| ListingRow {
            share_token: r.share_token,
            file_name: r.filename,
            new_views: r.counts.map_or(0, |c| c.new_views),
        })
        .collect())
}

/// Views new since the last poll, on one link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewViews {
    pub share_token: String,
    pub file_name: String,
    pub count: u64,
}

/// What is new since `seen`, which becomes this poll. Before the first poll
/// (`primed` false) nothing is new. A count that went down (the owner looked)
/// is only remembered; a link made since the last poll starts from zero.
pub fn take_new_views<S: std::hash::BuildHasher>(seen: &mut HashMap<String, u64, S>, primed: bool, rows: &[ListingRow]) -> Vec<NewViews> {
    let mut out = Vec::new();
    let mut next = HashMap::with_capacity(rows.len());
    for row in rows {
        let before = seen.get(&row.share_token).copied().unwrap_or(0);
        if primed && row.new_views > before {
            out.push(NewViews {
                share_token: row.share_token.clone(),
                file_name: row.file_name.clone(),
                count: row.new_views - before,
            });
        }
        next.insert(row.share_token.clone(), row.new_views);
    }
    seen.clear();
    seen.extend(next);
    out
}

fn views(n: u64) -> String {
    if n == 1 { "1 new view".into() } else { format!("{n} new views") }
}

/// One notification: its line, and the link it opens (`None`: Shared Links).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    pub share_token: Option<String>,
    pub file_name: Option<String>,
    pub line: String,
}

/// "3 new views on deck.pdf" per link, or one line for them all past
/// [`MAX_SEPARATE`] links.
pub fn alerts_for(new: &[NewViews]) -> Vec<Alert> {
    if new.len() > MAX_SEPARATE {
        let total = new.iter().map(|n| n.count).sum();
        return vec![Alert {
            share_token: None,
            file_name: None,
            line: format!("{} on {} links", views(total), new.len()),
        }];
    }
    new.iter()
        .map(|n| {
            let name = if n.file_name.trim().is_empty() {
                "your link"
            } else {
                n.file_name.as_str()
            };
            Alert {
                share_token: Some(n.share_token.clone()),
                file_name: Some(n.file_name.clone()),
                line: format!("{} on {name}", views(n.count)),
            }
        })
        .collect()
}

/// A token as it may appear in a route: the server's tokens are URL-safe,
/// and anything else is refused rather than escaped.
pub fn route_safe(token: &str) -> bool {
    !token.is_empty() && token.len() <= 128 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Where a row's "Open Insights" goes: Shared Links, opening the link's
/// Insights (`insights` is read by the Shared Links page).
pub fn insights_route(share_token: Option<&str>) -> String {
    match share_token.filter(|t| route_safe(t)) {
        Some(t) => format!("/shares?insights={t}"),
        None => "/shares".into(),
    }
}

// ─── The notification center ───────────────────────────────────────────────

/// Whether the account's "Link activity" category is on. No row counts as
/// on, like every other category before the preferences page seeds it.
pub async fn preference_enabled(pool: &sqlx::SqlitePool, owner: &str) -> Result<bool> {
    let row: Option<(i32,)> = sqlx::query_as("SELECT enabled FROM notification_preferences WHERE owner = ? AND id = ?")
        .bind(owner)
        .bind(PREFERENCE_ID)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_none_or(|(e,)| e != 0))
}

async fn save_row(pool: &sqlx::SqlitePool, owner: &str, alert: &Alert, at_ms: i64) -> Result<()> {
    let subtype = match &alert.share_token {
        Some(t) => format!("{SUBTYPE}-{t}"),
        None => SUBTYPE.to_string(),
    };
    sqlx::query(
        "INSERT INTO notifications (user_address, notification_type, notification_subtype, title_text, description, link_text, link, is_unread, creation_time, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0)",
    )
    .bind(owner)
    .bind(NOTIFICATION_TYPE)
    .bind(subtype)
    .bind(&alert.line)
    .bind(alert.file_name.as_deref().unwrap_or(""))
    .bind("Open Insights")
    .bind(insights_route(alert.share_token.as_deref()))
    .bind(at_ms)
    .execute(pool)
    .await?;
    Ok(())
}

/// One recent event, for the tray popover's Link activity block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentLinkActivity {
    pub id: i64,
    /// The link it is about; `null` for many links at once.
    pub share_token: Option<String>,
    pub line: String,
    /// Milliseconds since the epoch.
    pub at: i64,
}

/// `id, notification_subtype, title_text, creation_time`.
type RecentRow = (i64, Option<String>, Option<String>, Option<i64>);

/// The account's newest link activity rows, newest first.
pub async fn recent(pool: &sqlx::SqlitePool, owner: &str, limit: i64) -> Result<Vec<RecentLinkActivity>> {
    let rows: Vec<RecentRow> = sqlx::query_as(
        "SELECT id, notification_subtype, title_text, creation_time FROM notifications
          WHERE user_address = ? AND notification_type = ? AND COALESCE(is_deleted, 0) = 0
          ORDER BY creation_time DESC, id DESC LIMIT ?",
    )
    .bind(owner)
    .bind(NOTIFICATION_TYPE)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, subtype, line, at)| RecentLinkActivity {
            id,
            share_token: subtype
                .as_deref()
                .and_then(|s| s.strip_prefix(&format!("{SUBTYPE}-")).map(str::to_owned))
                .filter(|t| route_safe(t)),
            line: line.unwrap_or_default(),
            at: at.unwrap_or_default(),
        })
        .collect())
}

/// The tray popover's last few link events (at most 10).
#[tauri::command]
pub async fn link_activity_recent(state: tauri::State<'_, AppState>, limit: Option<i64>) -> Result<Vec<RecentLinkActivity>> {
    let owner = state.current_account_id()?;
    recent(state.pool()?, &owner, limit.unwrap_or(3).clamp(1, 10)).await
}

// ─── The poller ────────────────────────────────────────────────────────────

fn main_window_focused(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

fn show(app: &AppHandle, line: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(NOTIFICATION_TYPE).body(line).show() {
        warn!(error = %e, "link activity notification not shown");
    }
}

/// The new views for `account` in `rows`, against what the state holds.
fn diff(state: &LinkAlertsState, account: &str, rows: &[ListingRow]) -> Vec<NewViews> {
    let Ok(mut inner) = state.inner.lock() else {
        return Vec::new();
    };
    if inner.account.as_deref() != Some(account) {
        inner.account = Some(account.to_string());
        inner.primed = false;
        inner.seen.clear();
        inner.pending_open = None;
    }
    let primed = inner.primed;
    let new = take_new_views(&mut inner.seen, primed, rows);
    inner.primed = true;
    new
}

async fn poll_once(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let Ok(account) = state.current_account_id() else {
        return Ok(());
    };
    let caps = capabilities_or_none(&state, &account).await;
    if !(caps.share_insights && caps.share_listing_counts) {
        return Ok(());
    }
    let api = OwnerApi::for_account(&state, &account).await?;
    let rows = parse_rows(&get_listing(&state.api_client, &api, "shares").await?)?;
    let alerts = alerts_for(&diff(&state.link_alerts, &account, &rows));
    if alerts.is_empty() {
        return Ok(());
    }
    let pool = state.pool()?;
    let now = chrono::Utc::now().timestamp_millis();
    for alert in &alerts {
        save_row(pool, &account, alert, now).await?;
    }
    let _ = app.emit(LINK_ACTIVITY_CHANGED_EVENT, ());
    if !preference_enabled(pool, &account).await? {
        return Ok(());
    }
    let background = !main_window_focused(app);
    for alert in &alerts {
        show(app, &alert.line);
    }
    if background && let Ok(mut inner) = state.link_alerts.inner.lock() {
        // The newest one shown is the one a click most likely meant.
        let last = alerts.last().and_then(|a| a.share_token.clone());
        inner.pending_open = Some((PendingOpen { share_token: last }, Instant::now()));
    }
    Ok(())
}

/// Reads the listing every [`POLL_EVERY`] for as long as the app runs.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_EVERY).await;
            if let Err(e) = poll_once(&app).await {
                debug!(error = %e, "link activity poll failed");
            }
        }
    });
}

/// What a return to the main window opens, if it came within
/// [`CLICK_WINDOW`] of a notification. Taken once.
fn take_pending(state: &LinkAlertsState, now: Instant) -> Option<PendingOpen> {
    let mut inner = state.inner.lock().ok()?;
    let (token, at) = inner.pending_open.take()?;
    (now.duration_since(at) <= CLICK_WINDOW).then_some(token)
}

/// The main window came forward: if a link activity notification was just
/// shown while it was in the background, that was most likely its click, so
/// open what it was about.
pub fn on_main_window_focused(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(open) = take_pending(&state.link_alerts, Instant::now()) {
        let _ = app.emit_to(MAIN_WINDOW_LABEL, OPEN_LINK_INSIGHTS_EVENT, open);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(token: &str, name: &str, new_views: u64) -> ListingRow {
        ListingRow {
            share_token: token.into(),
            file_name: name.into(),
            new_views,
        }
    }

    #[test]
    fn the_listing_is_read_for_tokens_names_and_new_views() {
        let body = r#"[
          {"share_token":"a","filename":"deck.pdf","counts":{"views":12,"new_views":3,"new_comments":1}},
          {"share_token":"b","filename":"x","counts":null},
          {"share_token":"","filename":"y"}
        ]"#;
        assert_eq!(parse_rows(body).unwrap(), vec![row("a", "deck.pdf", 3), row("b", "x", 0)]);
        assert!(parse_rows("nope").is_err());
    }

    #[test]
    fn the_first_poll_only_learns_where_the_counts_stand() {
        let mut seen = HashMap::new();
        assert!(take_new_views(&mut seen, false, &[row("a", "deck.pdf", 5)]).is_empty());
        assert_eq!(seen.get("a"), Some(&5));
    }

    #[test]
    fn later_polls_report_only_what_is_new_per_link() {
        let mut seen = HashMap::from([("a".to_string(), 2), ("b".to_string(), 4)]);
        let new = take_new_views(&mut seen, true, &[row("a", "deck.pdf", 5), row("b", "q3.pdf", 1), row("c", "new.pdf", 2)]);
        assert_eq!(
            new,
            vec![
                NewViews {
                    share_token: "a".into(),
                    file_name: "deck.pdf".into(),
                    count: 3
                },
                // A link made since the last poll starts from zero.
                NewViews {
                    share_token: "c".into(),
                    file_name: "new.pdf".into(),
                    count: 2
                },
            ]
        );
        // "b" went down (the owner looked) and is only remembered.
        assert_eq!(seen.get("b"), Some(&1));
        // Nothing new: nothing said.
        assert!(take_new_views(&mut seen, true, &[row("a", "deck.pdf", 5), row("b", "q3.pdf", 1)]).is_empty());
        // A revoked link is forgotten.
        assert!(!seen.contains_key("c"));
    }

    #[test]
    fn alerts_are_batched_per_link_and_into_one_past_three_links() {
        let n = |t: &str, name: &str, count| NewViews {
            share_token: t.into(),
            file_name: name.into(),
            count,
        };
        assert_eq!(
            alerts_for(&[n("a", "Series A deck.pdf", 3), n("b", "q3.pdf", 1)]),
            vec![
                Alert {
                    share_token: Some("a".into()),
                    file_name: Some("Series A deck.pdf".into()),
                    line: "3 new views on Series A deck.pdf".into()
                },
                Alert {
                    share_token: Some("b".into()),
                    file_name: Some("q3.pdf".into()),
                    line: "1 new view on q3.pdf".into()
                },
            ]
        );
        let many = alerts_for(&[n("a", "1", 1), n("b", "2", 2), n("c", "3", 1), n("d", "4", 1)]);
        assert_eq!(
            many,
            vec![Alert {
                share_token: None,
                file_name: None,
                line: "5 new views on 4 links".into()
            }]
        );
        assert!(alerts_for(&[]).is_empty());
    }

    #[test]
    fn a_row_opens_its_links_insights_from_shared_links() {
        assert_eq!(insights_route(Some("tok_A-1")), "/shares?insights=tok_A-1");
        assert_eq!(insights_route(None), "/shares");
        // Never a token that would change the route.
        assert_eq!(insights_route(Some("a&b=c")), "/shares");
        assert_eq!(insights_route(Some("")), "/shares");
    }

    #[test]
    fn a_return_to_the_app_soon_after_a_notification_opens_it_once() {
        let state = LinkAlertsState::default();
        let at = Instant::now();
        let link = |t: Option<&str>| PendingOpen {
            share_token: t.map(str::to_owned),
        };
        state.inner.lock().unwrap().pending_open = Some((link(Some("a")), at));
        assert_eq!(take_pending(&state, at + Duration::from_secs(5)), Some(link(Some("a"))));
        assert_eq!(take_pending(&state, at + Duration::from_secs(6)), None, "taken once");

        state.inner.lock().unwrap().pending_open = Some((link(None), at));
        // The event's payload is what the main window parses.
        assert_eq!(serde_json::to_value(link(Some("a"))).unwrap(), serde_json::json!({ "shareToken": "a" }));
        assert_eq!(
            take_pending(&state, at + CLICK_WINDOW + Duration::from_secs(1)),
            None,
            "too late to be its click"
        );
    }

    #[test]
    fn a_new_account_starts_over() {
        let state = LinkAlertsState::default();
        assert!(diff(&state, "acct1", &[row("a", "x", 2)]).is_empty());
        assert_eq!(diff(&state, "acct1", &[row("a", "x", 3)]).len(), 1);
        // Another account's first poll is a fresh start, not "3 to 9 new".
        assert!(diff(&state, "acct2", &[row("a", "x", 9)]).is_empty());
    }

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_address TEXT NOT NULL, notification_type TEXT,
             notification_subtype TEXT, title_text TEXT, description TEXT, link_text TEXT, link TEXT, is_unread INTEGER DEFAULT 1,
             creation_time INTEGER, is_deleted INTEGER DEFAULT 0, deleted_at INTEGER, release_notes TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE notification_preferences (owner TEXT, id TEXT, label TEXT, description TEXT, enabled INTEGER, PRIMARY KEY (owner, id))",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn rows_land_in_the_center_and_the_tray_reads_the_newest() {
        let pool = pool().await;
        let one = |t: &str, line: &str| Alert {
            share_token: Some(t.into()),
            file_name: Some("deck.pdf".into()),
            line: line.into(),
        };
        save_row(&pool, "me", &one("a", "1 new view on deck.pdf"), 1_000).await.unwrap();
        save_row(
            &pool,
            "me",
            &Alert {
                share_token: None,
                file_name: None,
                line: "5 new views on 4 links".into(),
            },
            2_000,
        )
        .await
        .unwrap();
        save_row(&pool, "someone else", &one("z", "not mine"), 3_000).await.unwrap();

        let got = recent(&pool, "me", 3).await.unwrap();
        assert_eq!(
            got.iter().map(|r| (r.share_token.as_deref(), r.line.as_str())).collect::<Vec<_>>(),
            [(None, "5 new views on 4 links"), (Some("a"), "1 new view on deck.pdf")]
        );
        let (kind, link, link_text): (String, String, String) =
            sqlx::query_as("SELECT notification_type, link, link_text FROM notifications WHERE user_address = 'me' AND creation_time = 1000")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            (kind.as_str(), link.as_str(), link_text.as_str()),
            (NOTIFICATION_TYPE, "/shares?insights=a", "Open Insights")
        );
    }

    #[tokio::test]
    async fn the_category_is_on_until_turned_off() {
        let pool = pool().await;
        assert!(preference_enabled(&pool, "me").await.unwrap());
        sqlx::query("INSERT INTO notification_preferences VALUES ('me', 'link_activity', 'Link activity', '', 0)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!preference_enabled(&pool, "me").await.unwrap());
    }

    #[test]
    fn the_category_is_seeded_on_with_the_label_rows_carry() {
        assert!(
            crate::notifications::crud::DEFAULT_PREFERENCES
                .iter()
                .any(|(id, label, _)| *id == PREFERENCE_ID && *label == NOTIFICATION_TYPE),
            "seeded in DEFAULT_PREFERENCES"
        );
    }
}
