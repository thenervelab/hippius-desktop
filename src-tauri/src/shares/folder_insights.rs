//! A folder link's Insights for its owner: which files of the folder were
//! opened, how often and by how many people, for a document its pages and
//! the time on them, and who opened what (the folder as a room). Plus the
//! link's one switch, Insights on or off, and Export CSV.
//!
//! Server routes (HCFS, owner bearer, gated on `folder_share_insights`):
//!
//! - `GET /v1/folder-shares/by-hash/{token_hash}/insights`: the link's
//!   numbers over every file, and one entry per file with a visit. A free
//!   plan gets counts and the NAMES of what is locked (`locked`); every
//!   locked value leaves here as [`Gated::Locked`], so the screen can only
//!   draw a sample for it.
//! - `PATCH /v1/folder-shares/by-hash/{token_hash}/settings` with
//!   `{"insights": bool}`. Turning it on needs the link's minter on a paid
//!   Drive plan (`403 paid_plan_required`); turning it off is never checked.
//!
//! Both are addressed by the listing's `token_hash`, so they need no key and
//! work for a link minted on another device. Folder links have no comments
//! and no names: every viewer is anonymous, told apart by the start of their
//! id ([`viewer_label`]), which stays the same across the link's files.
//!
//! Everything the panel shows is worked out here: the order of the files,
//! each file's time, the room. The panel only draws it.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use hcfs_client::client::folder_share::folder_share_token_hash;
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use super::insights::{
    Gated, InsightsPages, InsightsPlan, MAX_PAGES, PLAN_UNREADABLE, REQUEST_TIMEOUT, UNREACHABLE, capabilities_checked, capabilities_or_none,
    read_ok, read_switches_in_plan, transport,
};
use crate::app_state::AppState;
use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};

/// Shown when the server does not have folder link Insights. The row's
/// button is hidden on such a server, so this only reaches someone who got
/// there some other way.
pub const FOLDER_INSIGHTS_UNAVAILABLE: &str = "Insights for folder links aren't available yet.";
/// Export CSV on a plan that does not include the viewer list: there are no
/// rows to write, and an empty file would read as "nobody opened anything".
pub const NOTHING_TO_EXPORT: &str = "There's no viewer activity to export on this plan.";
const NOT_A_LINK: &str = "That link isn't valid.";

// ─── What the panel draws ──────────────────────────────────────────────────

/// The owner's Insights for one folder link.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInsights {
    pub plan: InsightsPlan,
    pub total_views: u64,
    pub unique_viewers: u64,
    /// The files that were opened, most viewed first, then by path.
    pub files: Vec<FolderFile>,
    /// Everyone who opened something, most recent first, each with the
    /// files they opened. Locked on a plan without the viewer list.
    pub people: Gated<Vec<RoomPerson>>,
}

/// One file of the folder that was opened.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFile {
    /// Share-relative path, as the share page names it.
    pub path: String,
    /// The path's last part.
    pub name: String,
    /// The folder it sits in, `""` at the link's top.
    pub folder: String,
    pub total_views: u64,
    pub unique_viewers: u64,
    /// For a document, the share of visits that read to its end, 0 to 1.
    pub read: Option<f64>,
    /// Time on the document's pages over its viewers. `None` when none was
    /// counted (not a document, or a plan without it).
    pub time_ms: Option<u64>,
    /// Page by page numbers, only for a document of more than one page that
    /// was viewed, and only on a plan that shows them.
    pub pages: Option<InsightsPages>,
    /// Who opened it, most recent first. Locked on a plan without viewers.
    pub viewers: Gated<Vec<FolderViewer>>,
}

/// One viewer of one file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderViewer {
    pub viewer_id: String,
    /// "Viewer 3fa9": folder links carry no names.
    pub label: String,
    pub visits: u64,
    /// RFC 3339.
    pub last_viewed_at: Option<String>,
    /// For a video, how much of it they watched, 0 to 1.
    pub completion: Option<f64>,
    /// For a document, how many of its pages they saw, and how many it has.
    pub pages_seen: Option<u32>,
    pub page_count: Option<u32>,
    /// Time on the document's pages over this viewer's visits.
    pub page_time_ms: Option<u64>,
}

/// One person across the folder.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPerson {
    pub viewer_id: String,
    pub label: String,
    /// Visits over every file.
    pub visits: u64,
    pub last_viewed_at: Option<String>,
    /// Time on document pages over every file. `None` when no document was read.
    pub page_time_ms: Option<u64>,
    /// The files they opened, most recent first.
    pub files: Vec<RoomFile>,
}

/// One file a person opened.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomFile {
    pub path: String,
    pub name: String,
    pub visits: u64,
    pub last_viewed_at: Option<String>,
    pub pages_seen: Option<u32>,
    pub page_count: Option<u32>,
    pub page_time_ms: Option<u64>,
}

// ─── The wire ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct WireFolderInsights {
    #[serde(default)]
    plan: String,
    #[serde(default)]
    total_views: u64,
    #[serde(default)]
    unique_viewers: u64,
    #[serde(default)]
    files: Vec<WireFile>,
    #[serde(default)]
    locked: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct WireFile {
    #[serde(default)]
    path: String,
    #[serde(default)]
    total_views: u64,
    #[serde(default)]
    unique_viewers: u64,
    #[serde(default)]
    pages: Option<WireFilePages>,
    #[serde(default)]
    viewers: Option<Vec<WireViewer>>,
}

#[derive(Debug, Deserialize)]
struct WireFilePages {
    #[serde(default)]
    page_count: u32,
    #[serde(default)]
    completion_rate: Option<f64>,
    #[serde(default)]
    reach: Vec<f64>,
    #[serde(default)]
    median_ms: Vec<u64>,
}

#[derive(Debug, Deserialize)]
struct WireViewer {
    #[serde(default)]
    viewer_id: String,
    #[serde(default)]
    visits: u64,
    #[serde(default)]
    completion: Option<f64>,
    #[serde(default)]
    last_viewed_at: Option<String>,
    #[serde(default)]
    pages_seen: Option<u32>,
    #[serde(default)]
    page_time_ms: Option<u64>,
}

fn unit(x: f64) -> Option<f64> {
    x.is_finite().then(|| x.clamp(0.0, 1.0))
}

fn percent(x: f64) -> f64 {
    if x.is_finite() { x.clamp(0.0, 100.0) } else { 0.0 }
}

/// A file's pages block as it may be drawn: a valid page count, one reach
/// (a percentage) and one median time per page.
fn pages_block(wire: &WireFilePages) -> Option<InsightsPages> {
    let page_count = Some(wire.page_count).filter(|n| (1..=MAX_PAGES).contains(n))?;
    let n = page_count as usize;
    let mut reach: Vec<f64> = wire.reach.iter().copied().take(n).map(percent).collect();
    reach.resize(n, 0.0);
    let mut median_ms = wire.median_ms.clone();
    median_ms.truncate(n);
    median_ms.resize(n, 0);
    Some(InsightsPages {
        page_count,
        reach,
        median_ms,
    })
}

/// The name a path shows: its last part.
pub fn file_name_of(path: &str) -> String {
    path.split('/').rfind(|p| !p.is_empty()).unwrap_or(path).to_string()
}

/// The folder a path sits in, `""` at the link's top.
pub fn folder_of(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    parts[..parts.len().saturating_sub(1)].join("/")
}

/// A folder link's viewers are anonymous: each is "Viewer" and the first
/// four letters or digits of their id, the same on every file they opened.
pub fn viewer_label(viewer_id: &str) -> String {
    let code: String = viewer_id.chars().filter(char::is_ascii_alphanumeric).take(4).collect();
    if code.is_empty() {
        "Viewer".to_string()
    } else {
        format!("Viewer {code}")
    }
}

/// An RFC 3339 time as a number to sort by; an unreadable or missing one
/// sorts as the oldest.
fn instant(at: Option<&str>) -> i64 {
    at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map_or(i64::MIN, |t| t.timestamp_millis())
}

/// Read the server's answer and decide what may be shown.
///
/// The viewer list, pages and times are locked on any plan that is not paid,
/// and whenever the server names them in `locked`: whatever arrives for them
/// then is dropped here and never reaches the screen.
pub fn parse_folder_insights(body: &str) -> Result<FolderInsights> {
    let wire: WireFolderInsights = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("folder insights parse failed: {e}")))?;
    let plan = if wire.plan == "paid" { InsightsPlan::Paid } else { InsightsPlan::Free };
    let locked: HashSet<&str> = wire.locked.iter().map(String::as_str).collect();
    let is_locked = |metric: &str| plan != InsightsPlan::Paid || locked.contains(metric);
    let viewers_locked = is_locked("viewers");
    let pages_locked = is_locked("pages");

    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for f in wire.files {
        if f.path.is_empty() || !seen.insert(f.path.clone()) {
            continue;
        }
        let block = if pages_locked { None } else { f.pages.as_ref() };
        let page_count = block.and_then(pages_block).map(|p| p.page_count);
        let read = block.and_then(|p| p.completion_rate).and_then(unit).filter(|_| page_count.is_some());
        let viewers = if viewers_locked {
            Gated::Locked
        } else {
            let mut rows: Vec<FolderViewer> = f
                .viewers
                .unwrap_or_default()
                .into_iter()
                .filter(|v| !v.viewer_id.is_empty())
                .map(|v| {
                    // The server sends a viewer's pages seen without the
                    // page count: it is the file's.
                    let pages_seen = page_count.and_then(|n| v.pages_seen.map(|s| s.min(n)));
                    FolderViewer {
                        label: viewer_label(&v.viewer_id),
                        viewer_id: v.viewer_id,
                        visits: v.visits,
                        last_viewed_at: v.last_viewed_at,
                        completion: v.completion.and_then(unit),
                        pages_seen,
                        page_count: pages_seen.and(page_count),
                        page_time_ms: if pages_locked { None } else { v.page_time_ms },
                    }
                })
                .collect();
            rows.sort_by_key(|r| std::cmp::Reverse(instant(r.last_viewed_at.as_deref())));
            Gated::Shown(rows)
        };
        let time_ms = match &viewers {
            Gated::Shown(rows) => rows.iter().filter_map(|v| v.page_time_ms).reduce(u64::saturating_add),
            Gated::Locked => None,
        };
        // A one-page document has no drop-off to draw, and a file nobody
        // viewed has nothing to show page by page.
        let pages = block.and_then(pages_block).filter(|p| p.page_count > 1 && f.total_views > 0);
        files.push(FolderFile {
            name: file_name_of(&f.path),
            folder: folder_of(&f.path),
            path: f.path,
            total_views: f.total_views,
            unique_viewers: f.unique_viewers,
            read,
            time_ms,
            pages,
            viewers,
        });
    }
    files.sort_by(|a, b| b.total_views.cmp(&a.total_views).then_with(|| a.path.cmp(&b.path)));
    let people = if viewers_locked { Gated::Locked } else { Gated::Shown(room(&files)) };

    Ok(FolderInsights {
        plan,
        total_views: wire.total_views,
        unique_viewers: wire.unique_viewers,
        files,
        people,
    })
}

/// The room: every viewer of the link with the files they opened, most
/// recent first, and each person's files most recent first.
fn room(files: &[FolderFile]) -> Vec<RoomPerson> {
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, RoomPerson> = HashMap::new();
    for file in files {
        let Gated::Shown(viewers) = &file.viewers else { continue };
        for v in viewers {
            let person = by_id.entry(v.viewer_id.clone()).or_insert_with(|| {
                order.push(v.viewer_id.clone());
                RoomPerson {
                    viewer_id: v.viewer_id.clone(),
                    label: v.label.clone(),
                    visits: 0,
                    last_viewed_at: None,
                    page_time_ms: None,
                    files: Vec::new(),
                }
            });
            person.visits = person.visits.saturating_add(v.visits);
            if instant(v.last_viewed_at.as_deref()) > instant(person.last_viewed_at.as_deref()) {
                person.last_viewed_at.clone_from(&v.last_viewed_at);
            }
            if let Some(ms) = v.page_time_ms {
                person.page_time_ms = Some(person.page_time_ms.unwrap_or(0).saturating_add(ms));
            }
            person.files.push(RoomFile {
                path: file.path.clone(),
                name: file.name.clone(),
                visits: v.visits,
                last_viewed_at: v.last_viewed_at.clone(),
                pages_seen: v.pages_seen,
                page_count: v.page_count,
                page_time_ms: v.page_time_ms,
            });
        }
    }
    let mut people: Vec<RoomPerson> = order.into_iter().filter_map(|id| by_id.remove(&id)).collect();
    for p in &mut people {
        p.files.sort_by_key(|f| std::cmp::Reverse(instant(f.last_viewed_at.as_deref())));
    }
    people.sort_by(|a, b| {
        instant(b.last_viewed_at.as_deref())
            .cmp(&instant(a.last_viewed_at.as_deref()))
            .then_with(|| a.viewer_id.cmp(&b.viewer_id))
    });
    people
}

// ─── Export CSV ────────────────────────────────────────────────────────────

/// A CSV cell before it is written.
#[derive(Debug, Clone, PartialEq)]
enum Cell {
    Empty,
    Number(u64),
    Text(String),
}

impl Cell {
    fn text(s: impl Into<String>) -> Self {
        Cell::Text(s.into())
    }
    fn opt_text(s: Option<&str>) -> Self {
        s.map_or(Cell::Empty, Cell::text)
    }
    fn opt_num(n: Option<impl Into<u64>>) -> Self {
        n.map_or(Cell::Empty, |n| Cell::Number(n.into()))
    }
}

/// One cell: quoted when it must be, and never a live formula. A text cell
/// starting with `=`, `+`, `-`, `@`, a tab or a carriage return is read as a
/// formula by common spreadsheet apps, and file names come from other
/// people, so it gets a leading `'`. Numbers are ours and stay numbers.
fn csv_cell(value: &Cell) -> String {
    let s = match value {
        Cell::Empty => return String::new(),
        Cell::Number(n) => return n.to_string(),
        Cell::Text(t) if t.starts_with(['=', '+', '-', '@', '\t', '\r']) => format!("'{t}"),
        Cell::Text(t) => t.clone(),
    };
    if s.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

fn to_csv(rows: &[Vec<Cell>]) -> String {
    let mut out = String::new();
    for row in rows {
        out.push_str(&row.iter().map(csv_cell).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out
}

/// A folder link's activity as CSV, the console's columns: one row per
/// person per file they opened, files in path order. Refused when the plan
/// locks the viewer list.
pub fn folder_link_csv(folder_name: &str, insights: &FolderInsights) -> Result<String> {
    if matches!(insights.people, Gated::Locked) {
        return Err(AppError::Validation(NOTHING_TO_EXPORT.into()));
    }
    let header = [
        "Folder",
        "File",
        "Path",
        "Viewer",
        "Viewer ID",
        "Visits",
        "Last viewed",
        "Watched (%)",
        "Pages seen",
        "Pages",
        "Time on pages (s)",
    ]
    .into_iter()
    .map(Cell::text)
    .collect();
    let mut rows = vec![header];
    let mut files: Vec<&FolderFile> = insights.files.iter().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    for file in files {
        let Gated::Shown(viewers) = &file.viewers else { continue };
        for v in viewers {
            rows.push(vec![
                Cell::text(folder_name),
                Cell::text(&file.name),
                Cell::text(&file.path),
                Cell::text(&v.label),
                Cell::text(&v.viewer_id),
                Cell::Number(v.visits),
                Cell::opt_text(v.last_viewed_at.as_deref()),
                Cell::opt_num(v.completion.map(|c| (c * 100.0).round() as u64)),
                Cell::opt_num(v.pages_seen),
                Cell::opt_num(v.page_count),
                Cell::opt_num(v.page_time_ms.map(|ms| (ms + 500) / 1000)),
            ]);
        }
    }
    Ok(to_csv(&rows))
}

/// "Q3 report" on 2026-11-10 to "Q3 report activity 2026-11-10.csv": a
/// trailing extension-like part off, characters no file system takes turned
/// to spaces, at most 80 characters of name. The console's `csvFilename`.
pub fn csv_file_name(name: &str, day: &str) -> String {
    let stem = match name.rfind('.') {
        Some(i) if (1..=8).contains(&(name.len() - i - 1)) && name[i + 1..].chars().all(|c| c.is_ascii_alphanumeric()) => &name[..i],
        _ => name,
    };
    let mut cleaned = String::with_capacity(stem.len());
    let mut in_bad = false;
    for c in stem.chars() {
        let bad = matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20;
        if bad && !in_bad {
            cleaned.push(' ');
        } else if !bad {
            cleaned.push(c);
        }
        in_bad = bad;
    }
    let base = cleaned.trim();
    let base: String = if base.is_empty() { "Insights" } else { base }.chars().take(80).collect();
    format!("{} activity {day}.csv", base.trim_end())
}

/// Writes `csv` to `destination` through a sibling temp file and a rename,
/// with a byte-order mark so spreadsheet apps read it as UTF-8. Replaces a
/// file already there: the save dialog asked about that.
fn write_csv(destination: &Path, csv: &str) -> Result<()> {
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::Validation("Destination has no parent directory".into()))?;
    if !parent.is_dir() {
        return Err(AppError::Validation("That folder doesn't exist any more.".into()));
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".hippius-folder-insights-")
        .suffix(".part")
        .tempfile_in(parent)?;
    std::io::Write::write_all(&mut temp, "\u{FEFF}".as_bytes())?;
    std::io::Write::write_all(&mut temp, csv.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(destination).map_err(|e| AppError::Io(e.error))?;
    Ok(())
}

// ─── Requests ──────────────────────────────────────────────────────────────

/// The server's base URL and the owner's bearer.
#[derive(Debug, Clone)]
pub(super) struct OwnerApi {
    base: String,
    bearer: String,
}

impl OwnerApi {
    #[cfg(test)]
    pub(super) fn new(base: &str, bearer: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            bearer: bearer.to_string(),
        }
    }

    pub(super) async fn for_account(state: &AppState, account_id: &str) -> Result<Self> {
        let pool = state.pool()?;
        let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
        let base = crate::sync::region::resolve_base_url(&server_url).trim_end_matches('/').to_string();
        let bearer = get_api_token(pool, account_id)
            .await?
            .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
        Ok(Self { base, bearer })
    }

    /// `{base}/v1/{rest}`.
    pub(super) fn url(&self, rest: &str) -> String {
        format!("{}/v1/{rest}", self.base)
    }

    pub(super) fn bearer(&self) -> &str {
        &self.bearer
    }

    /// A by-hash route of one folder link. The hash is checked first, so
    /// nothing else can reach another route.
    fn by_hash(&self, token_hash: &str, tail: &str) -> Result<String> {
        Ok(self.url(&format!("folder-shares/by-hash/{}/{tail}", checked_hash(token_hash)?)))
    }
}

/// A listing `token_hash`: 64 lowercase hex characters.
fn checked_hash(token_hash: &str) -> Result<&str> {
    let ok = token_hash.len() == 64 && token_hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if ok {
        Ok(token_hash)
    } else {
        Err(AppError::Validation(NOT_A_LINK.into()))
    }
}

async fn get_insights_body(http: &reqwest::Client, api: &OwnerApi, token_hash: &str) -> Result<String> {
    let resp = http
        .get(api.by_hash(token_hash, "insights")?)
        .bearer_auth(api.bearer())
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("folder insights", e))?;
    read_ok(resp).await
}

/// What turning the switch did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum SwitchOutcome {
    /// The server took it; `insights` is the switch as it now stands.
    Saved { insights: bool },
    /// Turning it on needs a paid Drive plan. Nothing changed.
    NeedsPaidPlan,
}

async fn patch_insights(http: &reqwest::Client, api: &OwnerApi, token_hash: &str, on: bool) -> Result<SwitchOutcome> {
    let resp = http
        .patch(api.by_hash(token_hash, "settings")?)
        .bearer_auth(api.bearer())
        .timeout(REQUEST_TIMEOUT)
        .json(&serde_json::json!({ "insights": on }))
        .send()
        .await
        .map_err(|e| transport("folder link settings", e))?;
    let body = match read_ok(resp).await {
        Ok(body) => body,
        Err(AppError::Api { status, body }) => {
            let code = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(serde_json::Value::as_str).map(str::to_owned));
            return match (status, code.as_deref()) {
                (403, Some("paid_plan_required")) => Ok(SwitchOutcome::NeedsPaidPlan),
                (502, Some("billing_unavailable")) => Err(AppError::Validation(PLAN_UNREADABLE.into())),
                _ => Err(AppError::Api { status, body }),
            };
        }
        Err(e) => return Err(e),
    };
    // The answer is the switch as it now stands; an answer without it is
    // taken as what was asked for.
    let insights = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("insights").and_then(serde_json::Value::as_bool))
        .unwrap_or(on);
    Ok(SwitchOutcome::Saved { insights })
}

async fn checked_api(state: &AppState) -> Result<OwnerApi> {
    let account_id = state.current_account_id()?;
    let caps = capabilities_checked(state, &account_id, UNREACHABLE).await?;
    if !caps.folder_share_insights {
        return Err(AppError::Validation(FOLDER_INSIGHTS_UNAVAILABLE.into()));
    }
    OwnerApi::for_account(state, &account_id).await
}

async fn read_insights(state: &AppState, token_hash: &str) -> Result<FolderInsights> {
    let api = checked_api(state).await?;
    parse_folder_insights(&get_insights_body(&state.api_client, &api, token_hash).await?)
}

// ─── A new link ────────────────────────────────────────────────────────────

/// Whether a new folder link starts with Insights on: the plan rule file
/// links follow (on for a paid Drive plan, off on the free plan or when the
/// plan can't be read), where the server has folder link Insights.
#[must_use]
pub(crate) const fn new_link_insights_on(server_has_them: bool, switches_in_plan: Option<bool>) -> bool {
    server_has_them && matches!(switches_in_plan, Some(true))
}

/// Turn a new folder link's Insights on where [`new_link_insights_on`] says
/// so. The server starts every folder link off. Never fails the share: the
/// link works either way, and a failure is logged.
pub(crate) async fn apply_new_link_default(state: &AppState, account_id: &str, share_token: &str) {
    let (caps, in_plan) = tokio::join!(capabilities_or_none(state, account_id), read_switches_in_plan(state, account_id));
    if !new_link_insights_on(caps.share_insights && caps.folder_share_insights, in_plan) {
        return;
    }
    let api = match OwnerApi::for_account(state, account_id).await {
        Ok(api) => api,
        Err(e) => {
            warn!(error = %e, "new folder link: insights left off");
            return;
        }
    };
    match patch_insights(&state.api_client, &api, &folder_share_token_hash(share_token), true).await {
        Ok(outcome) => info!(?outcome, "new folder link: insights default"),
        Err(e) => warn!(error = %e, "new folder link: insights left off"),
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// The owner's Insights for a folder link, by its listing `token_hash`.
#[tauri::command]
pub async fn folder_share_get_insights(state: tauri::State<'_, AppState>, token_hash: String) -> Result<FolderInsights> {
    read_insights(&state, &token_hash).await
}

/// Turn a folder link's Insights on or off. Turning it on from a plan that
/// does not include it answers [`SwitchOutcome::NeedsPaidPlan`] without
/// asking the server; a plan that could not be read leaves the server to
/// decide, and it checks the plan itself.
#[tauri::command]
pub async fn folder_share_set_insights(state: tauri::State<'_, AppState>, token_hash: String, on: bool) -> Result<SwitchOutcome> {
    let api = checked_api(&state).await?;
    if on {
        let account_id = state.current_account_id()?;
        if read_switches_in_plan(&state, &account_id).await == Some(false) {
            debug!("folder insights: not turned on, not on this plan");
            return Ok(SwitchOutcome::NeedsPaidPlan);
        }
    }
    let outcome = patch_insights(&state.api_client, &api, &token_hash, on).await?;
    info!(?outcome, "folder link insights switch");
    Ok(outcome)
}

/// The name the save dialog suggests for a folder link's CSV, dated today.
#[tauri::command]
pub async fn folder_share_insights_csv_name(folder_name: String) -> Result<String> {
    Ok(csv_file_name(&folder_name, &chrono::Local::now().format("%Y-%m-%d").to_string()))
}

/// Saves a folder link's activity as CSV at `destination`, the path the save
/// dialog returned. The rows are read fresh here, never handed over by the
/// page.
#[tauri::command]
pub async fn folder_share_export_insights_csv(
    state: tauri::State<'_, AppState>,
    token_hash: String,
    folder_name: String,
    destination: String,
) -> Result<()> {
    let destination = crate::chat::attachments::validate_destination(&destination)?;
    let insights = read_insights(&state, &token_hash).await?;
    let csv = folder_link_csv(&folder_name, &insights)?;
    let path = destination.clone();
    tauri::async_runtime::spawn_blocking(move || write_csv(&path, &csv))
        .await
        .map_err(|e| AppError::Other(format!("save task failed: {e}")))??;
    info!("folder insights csv saved");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shares::insights::tests::mock;

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// A new folder link follows the plan rule: Insights on for a paid plan
    /// only, and only where the server has them.
    #[test]
    fn a_new_folder_link_starts_with_insights_on_for_a_paid_plan_only() {
        assert!(new_link_insights_on(true, Some(true)));
        assert!(!new_link_insights_on(true, Some(false)), "free plan");
        assert!(!new_link_insights_on(true, None), "a plan that can't be read");
        assert!(!new_link_insights_on(false, Some(true)), "a server without folder insights");
    }

    const PAID: &str = r#"{
      "plan":"paid","total_views":5,"unique_viewers":2,"completion_rate":null,"retention":[],"pages":null,
      "viewers":[],
      "files":[
        {"path":"a/report.pdf","total_views":3,"unique_viewers":2,
         "pages":{"page_count":4,"completion_rate":0.75,"reach":[100,100,100,0,55],"median_ms":[4200,3100,900]},
         "viewers":[
           {"viewer_id":"q1w2e3r4","visits":2,"last_viewed_at":"2026-11-06T10:00:00Z","pages_seen":9,"page_time_ms":8200},
           {"viewer_id":"zz-99xx","visits":1,"last_viewed_at":"2026-11-07T10:00:00+00:00","pages_seen":1,"page_time_ms":1000}
         ]},
        {"path":"clip.mp4","total_views":2,"unique_viewers":1,"pages":null,
         "viewers":[{"viewer_id":"q1w2e3r4","visits":2,"completion":0.5,"last_viewed_at":"2026-11-08T09:00:00Z"}]},
        {"path":"clip.mp4","total_views":9,"unique_viewers":9}
      ],
      "locked":[]}"#;

    const FREE: &str = r#"{
      "plan":"free","total_views":5,"unique_viewers":2,
      "files":[
        {"path":"b.pdf","total_views":1,"unique_viewers":1,"pages":{"page_count":3,"completion_rate":1,"reach":[1,1,1],"median_ms":[1,1,1]},
         "viewers":[{"viewer_id":"leak","visits":1,"page_time_ms":5}]},
        {"path":"a.pdf","total_views":4,"unique_viewers":2}
      ],
      "locked":["viewers","pages","completion_rate","retention"]}"#;

    #[test]
    fn files_are_most_viewed_first_with_their_names_folders_and_time() {
        let i = parse_folder_insights(PAID).unwrap();
        assert_eq!(i.plan, InsightsPlan::Paid);
        assert_eq!((i.total_views, i.unique_viewers), (5, 2));
        let paths: Vec<_> = i.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a/report.pdf", "clip.mp4"], "a repeated path is read once");
        let doc = &i.files[0];
        assert_eq!((doc.name.as_str(), doc.folder.as_str()), ("report.pdf", "a"));
        assert_eq!(doc.read, Some(0.75));
        assert_eq!(doc.time_ms, Some(9200), "the time over its viewers");
        let pages = doc.pages.as_ref().expect("a document's pages");
        assert_eq!(pages.reach, vec![100.0, 100.0, 100.0, 0.0], "a long array is cut to the page count");
        assert_eq!(pages.median_ms, vec![4200, 3100, 900, 0], "a short one is filled");
        let Gated::Shown(viewers) = &doc.viewers else { panic!("viewers shown") };
        assert_eq!(viewers[0].label, "Viewer zz99", "newest first, whatever the offset's spelling");
        assert_eq!(
            (viewers[1].pages_seen, viewers[1].page_count),
            (Some(4), Some(4)),
            "never more pages than it has"
        );
        let clip = &i.files[1];
        assert_eq!((clip.read, clip.time_ms, clip.pages.as_ref()), (None, None, None));
    }

    #[test]
    fn the_room_lists_each_person_once_with_the_files_they_opened() {
        let i = parse_folder_insights(PAID).unwrap();
        let Gated::Shown(people) = i.people else { panic!("people shown") };
        assert_eq!(people.len(), 2);
        let first = &people[0];
        assert_eq!(first.label, "Viewer q1w2");
        assert_eq!(first.visits, 4);
        assert_eq!(first.last_viewed_at.as_deref(), Some("2026-11-08T09:00:00Z"));
        assert_eq!(first.page_time_ms, Some(8200));
        let names: Vec<_> = first.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["clip.mp4", "report.pdf"], "their most recent file first");
        assert_eq!(people[1].page_time_ms, Some(1000));
    }

    /// A free plan gets counts per file; viewers, pages and times sent anyway
    /// are dropped, so the panel can only draw its sample.
    #[test]
    fn a_free_plan_gets_counts_and_nothing_it_does_not_include() {
        let i = parse_folder_insights(FREE).unwrap();
        assert_eq!(i.people, Gated::Locked);
        assert_eq!(i.files[0].path, "a.pdf");
        for f in &i.files {
            assert_eq!(f.viewers, Gated::Locked);
            assert_eq!((f.read, f.time_ms, f.pages.as_ref()), (None, None, None));
        }
        let json = serde_json::to_value(&i).unwrap();
        assert_eq!(json["people"], serde_json::json!({ "state": "locked" }));
        assert!(!json.to_string().contains("leak"));
        // A paid answer that names a metric locked drops it too.
        let partly = PAID.replace(r#""locked":[]"#, r#""locked":["pages"]"#);
        let i = parse_folder_insights(&partly).unwrap();
        assert_eq!(i.files[0].pages, None);
        assert_eq!(i.files[0].time_ms, None);
        assert!(matches!(i.people, Gated::Shown(_)));
    }

    #[test]
    fn paths_names_and_labels() {
        assert_eq!(file_name_of("a/b/c.pdf"), "c.pdf");
        assert_eq!(file_name_of("c.pdf"), "c.pdf");
        assert_eq!(folder_of("a/b/c.pdf"), "a/b");
        assert_eq!(folder_of("c.pdf"), "");
        assert_eq!(viewer_label("-_-"), "Viewer");
        assert_eq!(viewer_label("ab-cd-ef"), "Viewer abcd");
    }

    #[test]
    fn the_csv_has_a_row_per_person_and_file_and_never_a_live_formula() {
        let mut i = parse_folder_insights(PAID).unwrap();
        if let Gated::Shown(v) = &mut i.files[0].viewers {
            v[0].viewer_id = "=cmd()".into();
        }
        let csv = folder_link_csv("Q3, final", &i).unwrap();
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert_eq!(
            lines[0],
            "Folder,File,Path,Viewer,Viewer ID,Visits,Last viewed,Watched (%),Pages seen,Pages,Time on pages (s)"
        );
        assert_eq!(lines.len(), 5, "three rows, the header and the closing line break");
        assert!(lines[1].starts_with("\"Q3, final\",report.pdf,a/report.pdf,Viewer zz99,'=cmd(),1,"));
        assert!(lines[1].ends_with(",1,4,1"));
        assert!(lines[3].contains("clip.mp4,clip.mp4,Viewer q1w2,q1w2e3r4,2,2026-11-08T09:00:00Z,50,,,"));
        assert!(matches!(
            folder_link_csv("x", &parse_folder_insights(FREE).unwrap()),
            Err(AppError::Validation(m)) if m == NOTHING_TO_EXPORT
        ));
    }

    #[test]
    fn the_csv_file_is_named_like_the_consoles() {
        assert_eq!(csv_file_name("Q3 report.pdf", "2026-11-10"), "Q3 report activity 2026-11-10.csv");
        assert_eq!(csv_file_name("Board room", "2026-11-10"), "Board room activity 2026-11-10.csv");
        assert_eq!(csv_file_name("a/b:c", "d"), "a b c activity d.csv");
        assert_eq!(csv_file_name("  ", "d"), "Insights activity d.csv");
        assert_eq!(csv_file_name(&"x".repeat(200), "d").len(), 80 + " activity d.csv".len());
    }

    #[test]
    fn the_csv_is_written_whole_with_a_byte_order_mark() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.csv");
        std::fs::write(&path, "old").unwrap();
        write_csv(&path, "a,b\r\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), "\u{FEFF}a,b\r\n".as_bytes());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no temp file left behind");
        assert!(matches!(write_csv(&dir.path().join("gone/out.csv"), "x"), Err(AppError::Validation(_))));
    }

    #[test]
    fn a_hash_that_is_not_one_never_reaches_a_route() {
        let api = OwnerApi::new("http://h", "b");
        assert_eq!(
            api.by_hash(HASH, "insights").unwrap(),
            format!("http://h/v1/folder-shares/by-hash/{HASH}/insights")
        );
        for bad in ["", "ABC", &HASH.to_uppercase(), &format!("{HASH}/../x"), &HASH[..63]] {
            assert!(api.by_hash(bad, "insights").is_err(), "{bad}");
        }
    }

    // ─── Against a mock server ─────────────────────────────────────────────

    #[tokio::test]
    async fn insights_are_read_by_hash_with_the_owners_bearer() {
        let (base, seen) = mock(|_| (200, PAID.into())).await;
        let body = get_insights_body(&reqwest::Client::new(), &OwnerApi::new(&base, "owner-bearer"), HASH)
            .await
            .unwrap();
        assert_eq!(parse_folder_insights(&body).unwrap().files.len(), 2);
        let s = seen.lock().unwrap()[0].clone();
        assert_eq!(
            (s.method.as_str(), s.path.as_str()),
            ("GET", format!("/v1/folder-shares/by-hash/{HASH}/insights").as_str())
        );
        assert_eq!(s.auth.as_deref(), Some("Bearer owner-bearer"));
    }

    #[tokio::test]
    async fn a_link_that_is_gone_says_so() {
        let (base, _) = mock(|_| (404, String::new())).await;
        let err = get_insights_body(&reqwest::Client::new(), &OwnerApi::new(&base, "b"), HASH)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(m) if m == super::super::insights::LINK_GONE));
    }

    #[tokio::test]
    async fn the_switch_is_patched_and_answers_as_it_now_stands() {
        let (base, seen) = mock(|s| {
            if s.body.contains("true") {
                (200, r#"{"insights":true}"#.into())
            } else {
                (200, "{}".into())
            }
        })
        .await;
        let (http, api) = (reqwest::Client::new(), OwnerApi::new(&base, "owner-bearer"));
        assert_eq!(
            patch_insights(&http, &api, HASH, true).await.unwrap(),
            SwitchOutcome::Saved { insights: true }
        );
        assert_eq!(
            patch_insights(&http, &api, HASH, false).await.unwrap(),
            SwitchOutcome::Saved { insights: false }
        );
        let s = seen.lock().unwrap()[0].clone();
        assert_eq!(
            (s.method.as_str(), s.path.as_str()),
            ("PATCH", format!("/v1/folder-shares/by-hash/{HASH}/settings").as_str())
        );
        assert_eq!(s.auth.as_deref(), Some("Bearer owner-bearer"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&s.body).unwrap(),
            serde_json::json!({"insights": true})
        );
        // The IPC shape the panel matches on.
        assert_eq!(
            serde_json::to_value(SwitchOutcome::Saved { insights: true }).unwrap(),
            serde_json::json!({"outcome": "saved", "insights": true})
        );
        assert_eq!(
            serde_json::to_value(SwitchOutcome::NeedsPaidPlan).unwrap(),
            serde_json::json!({"outcome": "needsPaidPlan"})
        );
    }

    #[tokio::test]
    async fn the_servers_plan_refusals_read_as_the_upgrade_or_a_plan_line() {
        let (base, _) = mock(|s| {
            if s.path.contains("/by-hash/0") {
                (403, r#"{"error":"paid_plan_required","message":"x"}"#.into())
            } else if s.path.contains("/by-hash/1") {
                (502, r#"{"error":"billing_unavailable","message":"x"}"#.into())
            } else {
                (403, r#"{"error":"account_suspended","message":"x"}"#.into())
            }
        })
        .await;
        let (http, api) = (reqwest::Client::new(), OwnerApi::new(&base, "b"));
        assert_eq!(patch_insights(&http, &api, HASH, true).await.unwrap(), SwitchOutcome::NeedsPaidPlan);
        let other = HASH.replacen('0', "1", 1);
        assert!(matches!(
            patch_insights(&http, &api, &other, true).await,
            Err(AppError::Validation(m)) if m == PLAN_UNREADABLE
        ));
        let third = HASH.replacen('0', "2", 1);
        assert!(matches!(
            patch_insights(&http, &api, &third, true).await,
            Err(AppError::Api { status: 403, .. })
        ));
    }

    /// Offline, the capabilities read fails: the panel must say Hippius
    /// couldn't be reached, never that folder Insights don't exist.
    #[test]
    fn every_command_reads_the_capabilities_strictly() {
        let src = include_str!("folder_insights.rs");
        let body = &src[src.find("async fn checked_api(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("capabilities_checked("));
        assert!(body.contains("folder_share_insights"));
        for name in [
            "pub async fn folder_share_get_insights(",
            "pub async fn folder_share_set_insights(",
            "pub async fn folder_share_export_insights_csv(",
        ] {
            let start = src.find(name).unwrap_or_else(|| panic!("{name} is defined"));
            let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
            assert!(body.contains("checked_api(") || body.contains("read_insights("), "{name} is gated");
        }
    }
}
