//! Hippius backend proxy for team chat: GIF search and workspace invite links.
//!
//! Two backend features sit behind the desktop's Hippius API token rather
//! than the Matrix session, so the webview never holds that token and never
//! talks to a GIF provider itself:
//!
//! - **GIFs** — `GET /api/chat/gifs/search/?q=&pos=&limit=` and
//!   `GET /api/chat/gifs/featured/?pos=&limit=`, both answering
//!   `{ results, next, meta: { attribution } }`. `429` means throttled;
//!   `503` with body `code: "gifs_not_configured"` means the deployment has
//!   no provider key and the picker must stay disabled. Only the user's
//!   locale is forwarded (`Accept-Language`), nothing else about the client.
//!   The picked GIF is then **downloaded here** ([`download_media`]) and
//!   handed to the webview as bytes so it goes out as an ordinary encrypted
//!   attachment — the event never carries a provider URL, and the provider
//!   never sees a `Referer` or a cookie.
//! - **Invite links** — `POST /api/chat/workspaces/<space_id>/invites/`
//!   (`403` not admin, `404` endpoint absent → handle-only invites),
//!   `POST /api/chat/invites/<token>/accept/` (`404` unknown, `410` expired
//!   or spent) and `GET /api/chat/invites/<token>/` (preview).
//!
//! Every HTTP status the UI must branch on is mapped **here** into a typed,
//! `kind`-tagged outcome ([`GifFetch`], [`InviteLinkOutcome`],
//! [`AcceptInviteOutcome`], [`InvitePreviewOutcome`]) so the frontend never
//! parses an error message to decide what to render. Anything else is a
//! plain [`AppError`].
//!
//! [`ChatBackend`] takes its base URL and token explicitly so the whole
//! module runs against an axum mock in `tests/chat_backend_mock.rs`; the
//! `#[tauri::command]`s are the only place the live state is read.

use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{debug, warn};

use crate::api::client::{get_auth_token_for_account, url_with_params, urlencoding};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// Page size the picker asks for when the caller gives none.
pub const GIF_PAGE_SIZE: u32 = 24;
/// Largest page the proxy is asked for, whatever the caller says.
pub const GIF_PAGE_MAX: u32 = 50;
/// The backend's `code` for a deployment without a provider key.
pub const GIFS_NOT_CONFIGURED: &str = "gifs_not_configured";
/// Default cap on a downloaded GIF/MP4 (the picker's own limit).
pub const GIF_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Hard ceiling a caller cannot raise past (matches the upload cap).
pub const MEDIA_DOWNLOAD_CEILING: u64 = 100 * 1024 * 1024;
/// How long an invite link lives, in days, when the caller does not say.
pub const INVITE_LINK_DAYS: u32 = 7;
/// Path segment under which the console publishes invite links.
pub const CHAT_JOIN_PATH: &str = "/chat/join/";

// ------------------------------------------------------------- GIF types --

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GifMedia {
    pub url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GifSizedMedia {
    pub url: String,
    pub width: u32,
    pub height: u32,
    /// Bytes, as reported by the provider; 0 when unknown.
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GifMp4 {
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GifResult {
    pub id: String,
    pub title: String,
    /// Small animated GIF for the grid.
    pub preview: GifMedia,
    /// The GIF itself, sent as the attachment.
    pub full: GifSizedMedia,
    /// Silent MP4 rendition when the provider has one; smaller than the GIF.
    pub mp4: Option<GifMp4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifPage {
    pub results: Vec<GifResult>,
    /// Cursor for the next page, `None` at the end.
    pub next: Option<String>,
    /// Provider mark from `meta.attribution` ("Powered by GIPHY"); `None`
    /// when the backend sent none, so the footer shows nothing rather than
    /// a guess at the provider.
    pub attribution: Option<String>,
}

/// What a GIF page request came back as. Only the two statuses the picker
/// renders differently are typed; the rest surface as errors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GifFetch {
    Page(GifPage),
    /// The deployment has no provider key (503). The picker stays disabled.
    Disabled {
        code: Option<String>,
    },
    /// Per-user throttle (429). Retry later.
    Throttled,
}

// ---------------------------------------------------------- invite types --

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceInviteLink {
    pub token: String,
    pub url: String,
    /// ISO 8601.
    pub expires_at: String,
    pub max_uses: Option<u32>,
    pub uses: u32,
    pub space_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InviteLinkOutcome {
    Link(WorkspaceInviteLink),
    /// The caller is not an admin or owner of the Space (403).
    Forbidden,
    /// The backend has no invite-link endpoint (404): invite by handle only.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AcceptInviteOutcome {
    Accepted {
        space_id: String,
        /// Default channels the bot invited the user to (may be empty).
        room_ids: Vec<String>,
    },
    /// Unknown token (404), or one that does not even look like a token.
    Unknown,
    /// Expired or all uses spent (410).
    Expired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InvitePreview {
    pub space_id: String,
    pub workspace_name: String,
    pub inviter_display_name: Option<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InvitePreviewOutcome {
    Preview(InvitePreview),
    Unknown,
    Expired,
}

// ------------------------------------------------------------ pure logic --

fn as_u32(value: Option<&Value>) -> u32 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map_or(0, |n| n as u32)
}

fn as_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map_or(0, |n| n as u64)
}

fn as_media(value: Option<&Value>) -> Option<GifMedia> {
    let v = value?.as_object()?;
    let url = v.get("url")?.as_str()?;
    if url.is_empty() {
        return None;
    }
    Some(GifMedia {
        url: url.to_string(),
        width: as_u32(v.get("width")),
        height: as_u32(v.get("height")),
    })
}

/// Keep only what the picker and the send path use, and drop entries the
/// backend could not fill (no preview or no full GIF). Defensive against a
/// backend that is a version ahead or behind: a body that is not a page at
/// all yields an empty page.
pub fn normalise_gif_page(raw: &Value) -> GifPage {
    let mut results = Vec::new();
    for item in raw.get("results").and_then(Value::as_array).into_iter().flatten() {
        let Some(r) = item.as_object() else { continue };
        let Some(id) = r.get("id").and_then(Value::as_str) else { continue };
        let (Some(preview), Some(full)) = (as_media(r.get("preview")), as_media(r.get("full"))) else {
            continue;
        };
        let size = as_u64(r.get("full").and_then(|f| f.get("size")));
        let mp4 = r.get("mp4").and_then(Value::as_object).and_then(|m| {
            let url = m.get("url")?.as_str()?;
            (!url.is_empty()).then(|| GifMp4 {
                url: url.to_string(),
                size: as_u64(m.get("size")),
            })
        });
        results.push(GifResult {
            id: id.to_string(),
            title: r.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
            preview,
            full: GifSizedMedia {
                url: full.url,
                width: full.width,
                height: full.height,
                size,
            },
            mp4,
        });
    }
    let next = raw.get("next").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let attribution = raw
        .get("meta")
        .and_then(|m| m.get("attribution"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    GifPage { results, next, attribution }
}

/// The `code` field of a JSON error body, if any.
fn body_code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body).ok()?.get("code")?.as_str().map(str::to_string)
}

/// Map a GIF endpoint answer: 2xx → page, 503 → disabled, 429 → throttled,
/// anything else → error.
pub fn classify_gif_response(status: u16, body: &str) -> Result<GifFetch> {
    match status {
        200..=299 => {
            let raw: Value = serde_json::from_str(body).map_err(|e| AppError::Other(format!("GIF proxy: invalid JSON: {e}")))?;
            Ok(GifFetch::Page(normalise_gif_page(&raw)))
        }
        503 => Ok(GifFetch::Disabled { code: body_code(body) }),
        429 => Ok(GifFetch::Throttled),
        _ => Err(AppError::Api {
            status,
            body: body.to_string(),
        }),
    }
}

pub fn classify_invite_link_response(status: u16, body: &str) -> Result<InviteLinkOutcome> {
    match status {
        200..=299 => {
            let link: WorkspaceInviteLink = serde_json::from_str(body).map_err(|e| AppError::Other(format!("invite link: invalid JSON: {e}")))?;
            Ok(InviteLinkOutcome::Link(link))
        }
        403 => Ok(InviteLinkOutcome::Forbidden),
        404 => Ok(InviteLinkOutcome::Unavailable),
        _ => Err(AppError::Api {
            status,
            body: body.to_string(),
        }),
    }
}

pub fn classify_accept_response(status: u16, body: &str) -> Result<AcceptInviteOutcome> {
    #[derive(Deserialize)]
    struct Accepted {
        space_id: String,
        #[serde(default)]
        room_ids: Vec<String>,
    }
    match status {
        200..=299 => {
            let a: Accepted = serde_json::from_str(body).map_err(|e| AppError::Other(format!("invite accept: invalid JSON: {e}")))?;
            Ok(AcceptInviteOutcome::Accepted {
                space_id: a.space_id,
                room_ids: a.room_ids,
            })
        }
        404 => Ok(AcceptInviteOutcome::Unknown),
        410 => Ok(AcceptInviteOutcome::Expired),
        _ => Err(AppError::Api {
            status,
            body: body.to_string(),
        }),
    }
}

pub fn classify_preview_response(status: u16, body: &str) -> Result<InvitePreviewOutcome> {
    match status {
        200..=299 => {
            let p: InvitePreview = serde_json::from_str(body).map_err(|e| AppError::Other(format!("invite preview: invalid JSON: {e}")))?;
            Ok(InvitePreviewOutcome::Preview(p))
        }
        404 => Ok(InvitePreviewOutcome::Unknown),
        410 => Ok(InvitePreviewOutcome::Expired),
        _ => Err(AppError::Api {
            status,
            body: body.to_string(),
        }),
    }
}

/// Loose shape check on a token before it is sent anywhere: URL-safe
/// base64 alphabet, 8–128 chars.
pub fn is_plausible_join_token(token: &str) -> bool {
    (8..=128).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Extract the invite token from what the user pasted: the bare token, or a
/// console link (`https://console.hippius.com/chat/join/<token>`, with or
/// without a trailing slash / query). `None` when nothing plausible is there.
pub fn parse_join_token(input: &str) -> Option<String> {
    let text = input.trim();
    if is_plausible_join_token(text) {
        return Some(text.to_string());
    }
    let idx = text.find(CHAT_JOIN_PATH)?;
    let rest = &text[idx + CHAT_JOIN_PATH.len()..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let token = &rest[..end];
    is_plausible_join_token(token).then(|| token.to_string())
}

/// Clamp a caller's page size to something the proxy accepts.
pub fn clamp_page_size(limit: Option<u32>) -> u32 {
    limit.unwrap_or(GIF_PAGE_SIZE).clamp(1, GIF_PAGE_MAX)
}

/// The effective download cap: the caller's, never above the ceiling.
pub fn effective_cap(cap: Option<u64>) -> u64 {
    cap.unwrap_or(GIF_MAX_BYTES).clamp(1, MEDIA_DOWNLOAD_CEILING)
}

pub fn too_large_message(cap: u64) -> String {
    format!("This GIF is too large to send (limit {} MB)", cap / (1024 * 1024))
}

// ------------------------------------------------------------ HTTP layer --

/// The backend as seen by chat: one base URL, one Hippius API token.
pub struct ChatBackend {
    client: reqwest::Client,
    base_url: String,
    token: String,
}

impl ChatBackend {
    pub fn new(client: reqwest::Client, base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            client,
            base_url: base_url.into(),
            token: token.into(),
        }
    }

    /// The live backend for the active account: the shared reqwest client,
    /// the configured API base URL and the account's stored API token.
    pub async fn from_state(state: &AppState) -> Result<Self> {
        let account = state.current_session_account()?;
        let token = get_auth_token_for_account(state.pool()?, &account).await?;
        Ok(Self::new(state.api_client.clone(), crate::api::client::api_base_url(), token))
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<(u16, String)> {
        let resp = req
            .header(AUTHORIZATION, format!("Token {}", self.token))
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| AppError::Other(format!("chat backend: {e}")))?;
        let status = resp.status().as_u16();
        let path = resp.url().path().to_string();
        let body = resp.text().await.unwrap_or_default();
        if !(200..=299).contains(&status) {
            warn!(status, path = %path, "chat backend request failed");
        }
        Ok((status, body))
    }

    async fn get(&self, path: &str, params: &[(&str, &str)], locale: Option<&str>) -> Result<(u16, String)> {
        let url = url_with_params(&self.base_url, path, params);
        let mut req = self.client.get(&url);
        if let Some(lang) = locale.map(str::trim).filter(|l| !l.is_empty() && l.len() <= 64 && l.is_ascii()) {
            req = req.header(ACCEPT_LANGUAGE, lang);
        }
        self.send(req).await
    }

    async fn post(&self, path: &str, body: &Value) -> Result<(u16, String)> {
        let url = format!("{}{}", self.base_url, path);
        let req = self.client.post(&url).header(CONTENT_TYPE, "application/json").json(body);
        self.send(req).await
    }

    pub async fn gifs_search(&self, q: &str, pos: Option<&str>, limit: Option<u32>, locale: Option<&str>) -> Result<GifFetch> {
        let limit = clamp_page_size(limit).to_string();
        let mut params = vec![("q", q)];
        if let Some(pos) = pos.filter(|p| !p.is_empty()) {
            params.push(("pos", pos));
        }
        params.push(("limit", &limit));
        let (status, body) = self.get("/api/chat/gifs/search/", &params, locale).await?;
        classify_gif_response(status, &body)
    }

    pub async fn gifs_featured(&self, pos: Option<&str>, limit: Option<u32>, locale: Option<&str>) -> Result<GifFetch> {
        let limit = clamp_page_size(limit).to_string();
        let mut params = Vec::new();
        if let Some(pos) = pos.filter(|p| !p.is_empty()) {
            params.push(("pos", pos));
        }
        params.push(("limit", &limit));
        let (status, body) = self.get("/api/chat/gifs/featured/", &params, locale).await?;
        classify_gif_response(status, &body)
    }

    pub async fn create_invite_link(&self, space_id: &str) -> Result<InviteLinkOutcome> {
        if !space_id.starts_with('!') || space_id.contains('/') {
            return Err(AppError::Validation("not a Matrix room id".into()));
        }
        let path = format!("/api/chat/workspaces/{}/invites/", urlencoding(space_id));
        let body = serde_json::json!({ "expires_in_days": INVITE_LINK_DAYS, "max_uses": Value::Null });
        let (status, text) = self.post(&path, &body).await?;
        classify_invite_link_response(status, &text)
    }

    /// Redeem a pasted link or token. An implausible input is `Unknown`
    /// without a request.
    pub async fn accept_invite(&self, token_or_url: &str) -> Result<AcceptInviteOutcome> {
        let Some(token) = parse_join_token(token_or_url) else {
            return Ok(AcceptInviteOutcome::Unknown);
        };
        let path = format!("/api/chat/invites/{}/accept/", urlencoding(&token));
        let (status, text) = self.post(&path, &serde_json::json!({})).await?;
        classify_accept_response(status, &text)
    }

    pub async fn preview_invite(&self, token_or_url: &str) -> Result<InvitePreviewOutcome> {
        let Some(token) = parse_join_token(token_or_url) else {
            return Ok(InvitePreviewOutcome::Unknown);
        };
        let path = format!("/api/chat/invites/{}/", urlencoding(&token));
        let (status, text) = self.get(&path, &[], None).await?;
        classify_preview_response(status, &text)
    }
}

/// Fetch a media file (a GIF or its MP4) from the provider's CDN with no
/// credentials, no `Referer`, and a byte cap enforced twice: on the declared
/// `Content-Length` before the body is read, and on the bytes actually
/// received while streaming (a CDN may omit or lie about the length).
///
/// Only `https` URLs are fetched — the proxy never returns anything else and
/// the desktop must not be turned into a plain-HTTP or `file:` reader.
pub async fn download_media(client: &reqwest::Client, url: &str, cap: u64) -> Result<Vec<u8>> {
    let parsed = reqwest::Url::parse(url).map_err(|_| AppError::Validation("not a valid URL".into()))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(AppError::Validation("only https media URLs can be fetched".into()));
    }
    download_from(client, parsed, cap).await
}

/// [`download_media`] without the `https` requirement — for the mock-server
/// integration test only (it can only listen on plain HTTP). Not reachable
/// from any command.
#[doc(hidden)]
pub async fn download_media_unchecked_scheme(client: &reqwest::Client, url: &str, cap: u64) -> Result<Vec<u8>> {
    let parsed = reqwest::Url::parse(url).map_err(|_| AppError::Validation("not a valid URL".into()))?;
    download_from(client, parsed, cap).await
}

async fn download_from(client: &reqwest::Client, url: reqwest::Url, cap: u64) -> Result<Vec<u8>> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Could not fetch the GIF: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Other(format!("Could not fetch the GIF ({})", status.as_u16())));
    }
    if let Some(declared) = resp.content_length()
        && declared > cap
    {
        return Err(AppError::Validation(too_large_message(cap)));
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(resp.content_length().unwrap_or(0).min(cap) as usize);
    let mut stream = resp;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| AppError::Other(format!("Could not fetch the GIF: {e}")))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > cap {
            return Err(AppError::Validation(too_large_message(cap)));
        }
        bytes.extend_from_slice(&chunk);
    }
    debug!(bytes = bytes.len(), "chat: media downloaded");
    Ok(bytes)
}

// -------------------------------------------------------------- commands --

/// Search the GIF proxy. `locale` is the webview's `navigator.language`.
#[tauri::command]
pub async fn chat_gifs_search(
    state: tauri::State<'_, AppState>,
    q: String,
    pos: Option<String>,
    limit: Option<u32>,
    locale: Option<String>,
) -> Result<GifFetch> {
    let backend = ChatBackend::from_state(&state).await?;
    backend.gifs_search(&q, pos.as_deref(), limit, locale.as_deref()).await
}

/// The proxy's featured/trending page (also the availability probe with `limit = 1`).
#[tauri::command]
pub async fn chat_gifs_featured(
    state: tauri::State<'_, AppState>,
    pos: Option<String>,
    limit: Option<u32>,
    locale: Option<String>,
) -> Result<GifFetch> {
    let backend = ChatBackend::from_state(&state).await?;
    backend.gifs_featured(pos.as_deref(), limit, locale.as_deref()).await
}

/// Download a picked GIF rendition for the webview to encrypt and upload.
/// Raw bytes via [`tauri::ipc::Response`] (JSON would triple an 8 MiB GIF).
#[tauri::command]
pub async fn chat_gif_download(state: tauri::State<'_, AppState>, url: String, cap: Option<u64>) -> Result<tauri::ipc::Response> {
    let bytes = download_media(&state.api_client, &url, effective_cap(cap)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn chat_create_workspace_invite(state: tauri::State<'_, AppState>, space_id: String) -> Result<InviteLinkOutcome> {
    let backend = ChatBackend::from_state(&state).await?;
    backend.create_invite_link(&space_id).await
}

#[tauri::command]
pub async fn chat_accept_workspace_invite(state: tauri::State<'_, AppState>, token_or_url: String) -> Result<AcceptInviteOutcome> {
    let backend = ChatBackend::from_state(&state).await?;
    backend.accept_invite(&token_or_url).await
}

#[tauri::command]
pub async fn chat_preview_workspace_invite(state: tauri::State<'_, AppState>, token_or_url: String) -> Result<InvitePreviewOutcome> {
    let backend = ChatBackend::from_state(&state).await?;
    backend.preview_invite(&token_or_url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn page() -> Value {
        json!({
            "results": [
                {
                    "id": "abc",
                    "title": "Hello",
                    "preview": { "url": "https://cdn/p.gif", "width": 200, "height": 100 },
                    "full": { "url": "https://cdn/f.gif", "width": 400, "height": 200, "size": 1234 },
                    "mp4": { "url": "https://cdn/f.mp4", "size": 99 },
                    "extra": "ignored"
                }
            ],
            "next": "cursor-2",
            "meta": { "attribution": "Powered by GIPHY" }
        })
    }

    #[test]
    fn normalises_fields_and_attribution() {
        let p = normalise_gif_page(&page());
        assert_eq!(p.results.len(), 1);
        let r = &p.results[0];
        assert_eq!(r.id, "abc");
        assert_eq!(r.title, "Hello");
        assert_eq!(r.preview.width, 200);
        assert_eq!(r.full.size, 1234);
        assert_eq!(r.mp4.as_ref().unwrap().url, "https://cdn/f.mp4");
        assert_eq!(p.next.as_deref(), Some("cursor-2"));
        assert_eq!(p.attribution.as_deref(), Some("Powered by GIPHY"));
    }

    #[test]
    fn attribution_is_verbatim_or_absent() {
        let mut raw = page();
        raw["meta"]["attribution"] = json!("  Tenor  ");
        assert_eq!(normalise_gif_page(&raw).attribution.as_deref(), Some("Tenor"));
        raw["meta"]["attribution"] = json!("   ");
        assert_eq!(normalise_gif_page(&raw).attribution, None);
        raw.as_object_mut().unwrap().remove("meta");
        assert_eq!(normalise_gif_page(&raw).attribution, None);
    }

    #[test]
    fn drops_incomplete_entries_and_tolerates_missing_mp4_and_empty_cursor() {
        let raw = json!({
            "results": [
                { "id": "no-preview", "full": { "url": "https://cdn/f.gif" } },
                { "id": "no-full", "preview": { "url": "https://cdn/p.gif" } },
                { "id": "ok", "preview": { "url": "https://cdn/p.gif" }, "full": { "url": "https://cdn/f.gif" } },
                "garbage",
                { "preview": { "url": "https://cdn/p.gif" }, "full": { "url": "https://cdn/f.gif" } }
            ],
            "next": ""
        });
        let p = normalise_gif_page(&raw);
        assert_eq!(p.results.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["ok"]);
        assert_eq!(p.results[0].mp4, None);
        assert_eq!(p.results[0].full.size, 0);
        assert_eq!(p.results[0].title, "");
        assert_eq!(p.next, None);
    }

    #[test]
    fn survives_a_body_that_is_not_a_page() {
        for raw in [json!(null), json!([]), json!("x"), json!({ "results": "nope" })] {
            let p = normalise_gif_page(&raw);
            assert!(p.results.is_empty());
            assert_eq!(p.next, None);
        }
    }

    #[test]
    fn gif_status_mapping() {
        assert_eq!(
            classify_gif_response(503, r#"{"code":"gifs_not_configured"}"#).unwrap(),
            GifFetch::Disabled {
                code: Some(GIFS_NOT_CONFIGURED.into())
            }
        );
        assert_eq!(classify_gif_response(503, "").unwrap(), GifFetch::Disabled { code: None });
        assert_eq!(classify_gif_response(429, "").unwrap(), GifFetch::Throttled);
        assert!(matches!(classify_gif_response(401, "x"), Err(AppError::Api { status: 401, .. })));
        assert!(matches!(classify_gif_response(200, "not json"), Err(AppError::Other(_))));
        assert!(matches!(classify_gif_response(200, "{}").unwrap(), GifFetch::Page(p) if p.results.is_empty()));
    }

    #[test]
    fn gif_outcome_wire_shape_is_kind_tagged() {
        let v = serde_json::to_value(GifFetch::Disabled { code: None }).unwrap();
        assert_eq!(v["kind"], "disabled");
        let v = serde_json::to_value(GifFetch::Throttled).unwrap();
        assert_eq!(v["kind"], "throttled");
        let v = serde_json::to_value(classify_gif_response(200, &page().to_string()).unwrap()).unwrap();
        assert_eq!(v["kind"], "page");
        assert_eq!(v["attribution"], "Powered by GIPHY");
        assert_eq!(v["results"][0]["full"]["size"], 1234);
    }

    #[test]
    fn invite_link_status_mapping() {
        let ok = r#"{"token":"tok_12345678","url":"https://console.hippius.com/chat/join/tok_12345678","expires_at":"2026-01-01T00:00:00Z","max_uses":null,"uses":0,"space_id":"!s:hippius.com"}"#;
        match classify_invite_link_response(201, ok).unwrap() {
            InviteLinkOutcome::Link(l) => {
                assert_eq!(l.token, "tok_12345678");
                assert_eq!(l.max_uses, None);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(classify_invite_link_response(403, "").unwrap(), InviteLinkOutcome::Forbidden);
        assert_eq!(classify_invite_link_response(404, "").unwrap(), InviteLinkOutcome::Unavailable);
        assert!(matches!(classify_invite_link_response(500, ""), Err(AppError::Api { status: 500, .. })));
        assert_eq!(serde_json::to_value(InviteLinkOutcome::Unavailable).unwrap()["kind"], "unavailable");
    }

    #[test]
    fn accept_and_preview_status_mapping() {
        assert_eq!(
            classify_accept_response(200, r#"{"space_id":"!s:h","room_ids":["!a:h"]}"#).unwrap(),
            AcceptInviteOutcome::Accepted {
                space_id: "!s:h".into(),
                room_ids: vec!["!a:h".into()]
            }
        );
        // `room_ids` may be missing on an older backend.
        assert!(matches!(
            classify_accept_response(200, r#"{"space_id":"!s:h"}"#).unwrap(),
            AcceptInviteOutcome::Accepted { room_ids, .. } if room_ids.is_empty()
        ));
        assert_eq!(classify_accept_response(404, "").unwrap(), AcceptInviteOutcome::Unknown);
        assert_eq!(classify_accept_response(410, "").unwrap(), AcceptInviteOutcome::Expired);
        assert!(matches!(classify_accept_response(401, ""), Err(AppError::Api { status: 401, .. })));

        let preview = r#"{"space_id":"!s:h","workspace_name":"Acme","inviter_display_name":null,"expires_at":"2026-01-01T00:00:00Z"}"#;
        assert!(matches!(classify_preview_response(200, preview).unwrap(), InvitePreviewOutcome::Preview(p) if p.workspace_name == "Acme"));
        assert_eq!(classify_preview_response(404, "").unwrap(), InvitePreviewOutcome::Unknown);
        assert_eq!(classify_preview_response(410, "").unwrap(), InvitePreviewOutcome::Expired);
        let v = serde_json::to_value(AcceptInviteOutcome::Accepted {
            space_id: "!s:h".into(),
            room_ids: vec![],
        })
        .unwrap();
        assert_eq!(v["kind"], "accepted");
        assert_eq!(v["space_id"], "!s:h");
    }

    #[test]
    fn join_tokens_accept_url_safe_and_reject_the_rest() {
        assert!(is_plausible_join_token("abcDEF12_-"));
        assert!(!is_plausible_join_token("short"));
        assert!(!is_plausible_join_token("has space 123"));
        assert!(!is_plausible_join_token("a/b/c/d/e/f"));
        assert!(!is_plausible_join_token(&"x".repeat(129)));
        assert!(is_plausible_join_token(&"x".repeat(128)));
    }

    #[test]
    fn parses_a_token_out_of_a_pasted_link_or_bare_token() {
        assert_eq!(parse_join_token("  tok_12345678 "), Some("tok_12345678".into()));
        assert_eq!(
            parse_join_token("https://console.hippius.com/chat/join/tok_12345678"),
            Some("tok_12345678".into())
        );
        assert_eq!(
            parse_join_token("https://console.hippius.com/chat/join/tok_12345678/"),
            Some("tok_12345678".into())
        );
        assert_eq!(
            parse_join_token("https://console.hippius.com/chat/join/tok_12345678?utm=x#frag"),
            Some("tok_12345678".into())
        );
        assert_eq!(parse_join_token("https://console.hippius.com/chat/join/"), None);
        assert_eq!(parse_join_token("https://console.hippius.com/chat/join/bad token"), None);
        assert_eq!(parse_join_token("not a link"), None);
        assert_eq!(parse_join_token(""), None);
    }

    #[test]
    fn page_size_and_cap_are_clamped() {
        assert_eq!(clamp_page_size(None), GIF_PAGE_SIZE);
        assert_eq!(clamp_page_size(Some(0)), 1);
        assert_eq!(clamp_page_size(Some(9999)), GIF_PAGE_MAX);
        assert_eq!(effective_cap(None), GIF_MAX_BYTES);
        assert_eq!(effective_cap(Some(u64::MAX)), MEDIA_DOWNLOAD_CEILING);
        assert_eq!(effective_cap(Some(0)), 1);
        assert_eq!(too_large_message(GIF_MAX_BYTES), "This GIF is too large to send (limit 8 MB)");
    }

    #[tokio::test]
    async fn download_rejects_non_https_before_any_request() {
        let client = reqwest::Client::new();
        for url in [
            "http://example.com/a.gif",
            "file:///etc/passwd",
            "ftp://x/y",
            "not a url",
            "data:image/gif;base64,R0lGODlh",
        ] {
            let err = download_media(&client, url, GIF_MAX_BYTES).await.unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{url}: {err}");
        }
    }
}
