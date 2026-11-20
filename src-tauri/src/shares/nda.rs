//! "Ask to accept an NDA" on a file link: the owner's side of a link's NDA
//! text (hcfs #1186). Viewers read the text and accept it on the console's
//! share page before the file opens; this is the owner's side: setting,
//! replacing and removing the text, and listing who accepted which text.
//!
//! Server routes (owner bearer, all behind `share_nda`):
//!
//! - `PUT /v1/shares/{token}/nda` `{text_hash, text_ct, text_nonce}` → 204.
//!   Sets or replaces the text. Needs a paid Drive plan.
//! - `DELETE .../nda` → 204 on any plan, the bodiless 404 when there is none.
//! - `GET .../nda/accepts?after=<id>` → `{nda, accepts, next_after}`: the
//!   current text (how the owner reads it back) and up to 500 accepts,
//!   oldest first, on any plan.
//!
//! The text is sealed here, never sent in the clear, byte-compatible with
//! the console's `nda-crypto.ts`:
//!
//! ```text
//! text_hash = BLAKE3 derive_key("hippius.hcfs.share-nda-text.v1", text as UTF-8)
//! text_ct   = AES-256-GCM under the link's comment key, 12-byte nonce,
//!             additional data "<token>:nda-text", over the bare UTF-8 text
//! ```
//!
//! The comment key comes from the link's own key, so a password link (whose
//! key needs the password, never kept) cannot have a text set here, and a
//! link whose key is not on this computer can only have its text removed.
//! Pinned against the console's own sealed bytes
//! (`tests/fixtures/share_nda_vectors.json`).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use serde::{Deserialize, Serialize};
use tracing::debug;

use super::comment_crypto::{self, CommentKey, NONCE_LEN, Purpose};
use super::insights::{
    Api, KeyUnavailable, LINK_GONE, PLAN_UNREADABLE, REQUEST_TIMEOUT, UNREACHABLE, capabilities_checked, comment_key_for, read_ok,
    read_switches_in_plan, transport,
};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// The BLAKE3 `derive_key` context of the text's hash (hcfs docs).
pub const NDA_TEXT_HASH_CONTEXT: &str = "hippius.hcfs.share-nda-text.v1";
/// The longest text the server takes, in bytes of UTF-8.
pub const MAX_NDA_TEXT_BYTES: usize = 64 * 1024;

/// Refused on the free plan, in the upgrade prompt's words (the app shows
/// the prompt for it, matched word for word).
pub const NDA_NOT_IN_PLAN: &str = "Asking to accept an NDA is available on paid Drive plans.";
const NDA_UNAVAILABLE: &str = "Asking to accept an NDA isn't available yet.";
const TEXT_EMPTY: &str = "Write the text first.";
const TEXT_TOO_LONG: &str = "The text is too long.";
const KEY_NOT_HERE: &str = "This link's key isn't on this computer, so its text can't be changed here.";
const COULDNT_SAVE: &str = "Couldn't save the text. Try again.";

/// A link's NDA setting as the owner sees it in the share dialog and Link
/// settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkNda {
    /// Draw "Ask to accept an NDA": the server has NDA texts, and either the
    /// link has one (which can always be removed) or a text can be sealed
    /// here. Never on a password link without one.
    pub offered: bool,
    /// The link has a text.
    pub on: bool,
    /// The text, opened. `None` while off, and when it cannot be opened on
    /// this computer (the app then offers only turning it off).
    pub text: Option<String>,
    /// A text can be sealed here: the link's key is on this computer.
    pub editable: bool,
    /// `Some(false)` on the free plan, where turning it on shows the upgrade
    /// prompt; `None` when the plan could not be read (nothing is locked,
    /// and the server still checks).
    pub in_plan: Option<bool>,
}

/// One page of a link's accepts, for the Insights NDA tab.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NdaAccepts {
    /// The server has NDA texts. Without it there is no tab.
    pub offered: bool,
    /// The link has a text now.
    pub has_text: bool,
    /// That text, opened; `None` without one or when it cannot be opened here.
    pub text: Option<String>,
    /// Oldest first, as the server lists them.
    pub accepts: Vec<NdaAccept>,
    /// The `after` of the next page; `None` on the last one.
    pub next_after: Option<u64>,
}

/// One viewer's accept of one text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NdaAccept {
    pub id: u64,
    /// The per-link pseudonym Insights names viewers by, to find the name
    /// the Viewers tab shows.
    pub viewer_id: String,
    /// The email the viewer proved on a gated link, shown only when it opens
    /// with the link's key and matches the server's check of it.
    pub email: Option<String>,
    /// RFC 3339.
    pub accepted_at: String,
    /// An accept of a text the owner has since replaced or removed.
    pub earlier: bool,
}

// ─── The text ──────────────────────────────────────────────────────────────

/// The text's hash, as the server compares it with an accept's.
#[must_use]
pub fn text_hash(text: &str) -> [u8; 32] {
    blake3::derive_key(NDA_TEXT_HASH_CONTEXT, text.as_bytes())
}

/// What the owner typed, as the text to seal: trimmed, and refused when
/// empty or longer than the server takes.
fn text_to_send(typed: &str) -> Result<&str> {
    let text = typed.trim();
    if text.is_empty() {
        return Err(AppError::Validation(TEXT_EMPTY.into()));
    }
    if text.len() > MAX_NDA_TEXT_BYTES {
        return Err(AppError::Validation(TEXT_TOO_LONG.into()));
    }
    Ok(text)
}

/// The text sealed for `PUT .../nda`, all standard base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SealedText {
    #[serde(rename = "text_hash")]
    hash: String,
    #[serde(rename = "text_ct")]
    ct: String,
    #[serde(rename = "text_nonce")]
    nonce: String,
}

fn seal_text_with_nonce(key: &CommentKey, token: &str, text: &str, nonce: &[u8; NONCE_LEN]) -> Result<SealedText> {
    let ct = comment_crypto::seal_with_nonce(key, token, Purpose::NdaText, nonce, text.as_bytes())
        .map_err(|_| AppError::Validation(COULDNT_SAVE.into()))?;
    Ok(SealedText {
        hash: STANDARD.encode(text_hash(text)),
        ct: STANDARD.encode(ct),
        nonce: STANDARD.encode(nonce),
    })
}

fn seal_text(key: &CommentKey, token: &str, text: &str) -> Result<SealedText> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_text_with_nonce(key, token, text, &nonce)
}

/// The text, or `None` when it does not open with `key` on this link.
fn open_text(key: &CommentKey, token: &str, ct_b64: &str, nonce_b64: &str) -> Option<String> {
    let plain = comment_crypto::open(
        key,
        token,
        Purpose::NdaText,
        &comment_crypto::decode_b64(nonce_b64).ok()?,
        &comment_crypto::decode_b64(ct_b64).ok()?,
    )
    .ok()?;
    std::str::from_utf8(&plain).ok().map(str::to_owned)
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
struct WireNda {
    #[serde(default, rename = "text_hash")]
    hash: String,
    #[serde(default, rename = "text_ct")]
    ct: String,
    #[serde(default, rename = "text_nonce")]
    nonce: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WireAccept {
    /// A number in the docs; a string is read too.
    id: serde_json::Value,
    #[serde(default)]
    text_hash: String,
    #[serde(default)]
    viewer_id: String,
    #[serde(default)]
    email_check: Option<String>,
    #[serde(default)]
    email_ct: Option<String>,
    #[serde(default)]
    email_nonce: Option<String>,
    #[serde(default)]
    accepted_at: String,
}

impl WireAccept {
    fn id(&self) -> Option<u64> {
        match &self.id {
            serde_json::Value::Number(n) => n.as_u64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WireAcceptsPage {
    #[serde(default)]
    nda: Option<WireNda>,
    #[serde(default)]
    accepts: Vec<WireAccept>,
    #[serde(default)]
    next_after: Option<serde_json::Value>,
}

impl WireAcceptsPage {
    /// The current text, when the server sent a whole one.
    fn current(&self) -> Option<&WireNda> {
        self.nda
            .as_ref()
            .filter(|n| !n.hash.is_empty() && !n.ct.is_empty() && !n.nonce.is_empty())
    }

    fn next(&self) -> Option<u64> {
        match self.next_after.as_ref()? {
            serde_json::Value::Number(n) => n.as_u64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        }
    }
}

fn parse_accepts_page(body: &str) -> Result<WireAcceptsPage> {
    serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("nda accepts parse failed: {e}")))
}

async fn get_accepts(http: &reqwest::Client, api: &Api, token: &str, after: u64) -> Result<WireAcceptsPage> {
    let mut url = api.share_url(token, "/nda/accepts")?;
    if after > 0 {
        url = format!("{url}?after={after}");
    }
    let resp = http
        .get(url)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("nda accepts", e))?;
    parse_accepts_page(&read_ok(resp).await?)
}

async fn put_nda(http: &reqwest::Client, api: &Api, token: &str, sealed: &SealedText) -> Result<()> {
    let resp = http
        .put(api.share_url(token, "/nda")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .json(sealed)
        .send()
        .await
        .map_err(|e| transport("nda", e))?;
    read_ok(resp).await.map(|_| ()).map_err(nda_refusal)
}

/// Remove the text. A link that already has none is what was asked for.
async fn delete_nda(http: &reqwest::Client, api: &Api, token: &str) -> Result<()> {
    let resp = http
        .delete(api.share_url(token, "/nda")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("nda", e))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    read_ok(resp).await.map(|_| ())
}

/// The server's refusals of a text, in the app's words.
fn nda_refusal(err: AppError) -> AppError {
    let AppError::Api { status, body } = &err else {
        return err;
    };
    let error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(serde_json::Value::as_str).map(str::to_owned));
    match (*status, error.as_deref()) {
        (403, Some("paid_plan_required")) => AppError::Validation(NDA_NOT_IN_PLAN.into()),
        (502, Some("billing_unavailable")) => AppError::Validation(PLAN_UNREADABLE.into()),
        (400, _) => AppError::Validation(COULDNT_SAVE.into()),
        _ => err,
    }
}

// ─── For links per person ──────────────────────────────────────────────────

/// The NDA text of `token`, opened with `key` (every link of a group has the
/// same share key, so one key opens each link's text under its own token).
/// `Ok(None)` when the link has no text, has a locked one, does not open
/// here, or is no longer live.
pub(super) async fn read_link_text(http: &reqwest::Client, api: &Api, token: &str, key: &CommentKey) -> Result<Option<String>> {
    match get_accepts(http, api, token, 0).await {
        Ok(page) => Ok(page.current().and_then(|n| open_text(key, token, &n.ct, &n.nonce))),
        Err(AppError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Seal `text` for `token` (additional data `<token>:nda-text`) and set it,
/// exactly as the NDA editor sets a text on any link.
pub(super) async fn set_link_text(http: &reqwest::Client, api: &Api, token: &str, key: &CommentKey, text: &str) -> Result<()> {
    let sealed = seal_text(key, token, text)?;
    put_nda(http, api, token, &sealed).await
}

// ─── What the owner sees ───────────────────────────────────────────────────

/// The setting as drawn, from what the server and this computer know.
/// `key` is the link's comment key, or why it is not here.
fn link_nda(current: Option<&WireNda>, token: &str, key: std::result::Result<&CommentKey, KeyUnavailable>, in_plan: Option<bool>) -> LinkNda {
    let on = current.is_some();
    let editable = key.is_ok();
    let text = match (current, key) {
        (Some(n), Ok(k)) => open_text(k, token, &n.ct, &n.nonce),
        _ => None,
    };
    LinkNda {
        offered: on || editable,
        on,
        text,
        editable,
        in_plan,
    }
}

/// A page of accepts as the tab shows it: the text opened, and each person
/// named by the email they proved, only when it matches the server's check.
fn accepts_view(page: &WireAcceptsPage, token: &str, key: Option<&CommentKey>) -> NdaAccepts {
    let current = page.current();
    let text = match (current, key) {
        (Some(n), Some(k)) => open_text(k, token, &n.ct, &n.nonce),
        _ => None,
    };
    let accepts = page
        .accepts
        .iter()
        .filter_map(|a| {
            let id = a.id()?;
            if a.viewer_id.is_empty() || a.accepted_at.is_empty() {
                return None;
            }
            let email = match (key, &a.email_nonce, &a.email_ct, &a.email_check) {
                (Some(k), Some(nonce), Some(ct), Some(check)) => comment_crypto::open_viewer_email(k, token, nonce, ct, check),
                _ => None,
            };
            Some(NdaAccept {
                id,
                viewer_id: a.viewer_id.clone(),
                email,
                accepted_at: a.accepted_at.clone(),
                earlier: current.is_none_or(|n| n.hash != a.text_hash),
            })
        })
        .collect();
    NdaAccepts {
        offered: true,
        has_text: current.is_some(),
        text,
        accepts,
        next_after: page.next(),
    }
}

/// Whether a page needs the link's key: a text to open or an email to check.
fn needs_key(page: &WireAcceptsPage) -> bool {
    page.current().is_some() || page.accepts.iter().any(|a| a.email_ct.is_some())
}

/// Setting a text is refused before anything is sealed or sent on a known
/// free plan, or without the link's key here.
fn may_set(in_plan: Option<bool>, key: std::result::Result<&CommentKey, KeyUnavailable>) -> Result<()> {
    if in_plan == Some(false) {
        return Err(AppError::Validation(NDA_NOT_IN_PLAN.into()));
    }
    key.map(|_| ()).map_err(|_| AppError::Validation(KEY_NOT_HERE.into()))
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// A file link's NDA setting, for the share dialog and Link settings.
#[tauri::command]
pub async fn share_get_nda(state: tauri::State<'_, AppState>, share_token: String) -> Result<LinkNda> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_nda {
        return Ok(LinkNda::default());
    }
    let api = Api::for_account(&state, &account_id).await?;
    let (page, in_plan, key) = tokio::join!(
        get_accepts(&state.api_client, &api, &share_token, 0),
        read_switches_in_plan(&state, &account_id),
        comment_key_for(&state, &account_id, &share_token)
    );
    let page = page?;
    let view = link_nda(page.current(), &share_token, key.as_ref().map_err(|e| *e), in_plan);
    if view.on && view.text.is_none() {
        debug!("share nda: the text could not be opened here");
    }
    Ok(view)
}

/// Set or replace the link's text, sealed here. Needs a paid Drive plan.
#[tauri::command]
pub async fn share_set_nda(state: tauri::State<'_, AppState>, share_token: String, text: String) -> Result<LinkNda> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_nda {
        return Err(AppError::Validation(NDA_UNAVAILABLE.into()));
    }
    let text = text_to_send(&text)?;
    let (in_plan, key) = tokio::join!(
        read_switches_in_plan(&state, &account_id),
        comment_key_for(&state, &account_id, &share_token)
    );
    may_set(in_plan, key.as_ref().map_err(|e| *e))?;
    let Ok(key) = key else {
        return Err(AppError::Validation(KEY_NOT_HERE.into()));
    };
    let sealed = seal_text(&key, &share_token, text)?;
    let api = Api::for_account(&state, &account_id).await?;
    put_nda(&state.api_client, &api, &share_token, &sealed).await?;
    Ok(LinkNda {
        offered: true,
        on: true,
        text: Some(text.to_string()),
        editable: true,
        in_plan,
    })
}

/// Remove the link's text, on any plan, so an owner who left the paid plan
/// can always open a link back up. The accepts already recorded stay.
#[tauri::command]
pub async fn share_remove_nda(state: tauri::State<'_, AppState>, share_token: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_nda {
        return Err(AppError::Validation(NDA_UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    delete_nda(&state.api_client, &api, &share_token).await.map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound(LINK_GONE.into()),
        other => other,
    })
}

/// A page of the link's accepts, after the accept `after` (0 for the
/// first), with its current text.
#[tauri::command]
pub async fn share_nda_accepts(state: tauri::State<'_, AppState>, share_token: String, after: Option<u64>) -> Result<NdaAccepts> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_nda {
        return Ok(NdaAccepts::default());
    }
    let api = Api::for_account(&state, &account_id).await?;
    let page = get_accepts(&state.api_client, &api, &share_token, after.unwrap_or(0)).await?;
    let key = if needs_key(&page) {
        comment_key_for(&state, &account_id, &share_token).await.ok()
    } else {
        None
    };
    Ok(accepts_view(&page, &share_token, key.as_ref()))
}

// ─── The whole log, for its export and records ─────────────────────────────

/// The most pages read for one export: 500 accepts each.
const MAX_LOG_PAGES: usize = 200;

/// Every accept of `token`, oldest first, with its current text, each page
/// read as the NDA tab reads it (`accepts_view`).
pub(super) async fn read_whole_log(http: &reqwest::Client, api: &Api, token: &str, key: Option<&CommentKey>) -> Result<NdaAccepts> {
    let mut log: Option<NdaAccepts> = None;
    let mut after = 0;
    for _ in 0..MAX_LOG_PAGES {
        let page = accepts_view(&get_accepts(http, api, token, after).await?, token, key);
        let next = page.next_after;
        match log.as_mut() {
            None => log = Some(page),
            Some(l) => l.accepts.extend(page.accepts),
        }
        match next {
            Some(n) if n > after => after = n,
            _ => break,
        }
    }
    let mut log = log.unwrap_or_default();
    log.next_after = None;
    Ok(log)
}

/// A link's whole accept log, for the owner signed in here.
pub(super) async fn link_log(state: &AppState, share_token: &str) -> Result<NdaAccepts> {
    let account_id = state.current_account_id()?;
    if !capabilities_checked(state, &account_id, UNREACHABLE).await?.share_nda {
        return Ok(NdaAccepts::default());
    }
    let api = Api::for_account(state, &account_id).await?;
    let key = comment_key_for(state, &account_id, share_token).await.ok();
    read_whole_log(&state.api_client, &api, share_token, key.as_ref()).await
}

#[cfg(test)]
mod tests {
    use super::super::insights::tests::mock;
    use super::*;

    const TOKEN: &str = "tok_abcdefghijklmnopqrst";

    struct Vector {
        text: String,
        hash: String,
        ct: String,
        nonce: String,
    }

    /// The console's own sealed texts, and the key they were sealed under.
    fn console_vectors() -> (CommentKey, String, Vec<Vector>) {
        let f: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/share_nda_vectors.json"
        )))
        .unwrap();
        let share_key: [u8; 32] = hex::decode(f["share_key_hex"].as_str().unwrap()).unwrap().try_into().unwrap();
        let s = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap().to_string();
        let vectors = f["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| Vector {
                text: s(v, "text"),
                hash: s(v, "text_hash"),
                ct: s(v, "text_ct"),
                nonce: s(v, "text_nonce"),
            })
            .collect();
        (CommentKey::derive(&share_key), f["token"].as_str().unwrap().to_string(), vectors)
    }

    fn key(byte: u8) -> CommentKey {
        CommentKey::derive(&[byte; 32])
    }

    #[test]
    fn the_text_hash_matches_the_hcfs_docs_known_answer() {
        assert_eq!(
            hex::encode(text_hash("I will keep this confidential.")),
            "8335d17e6d5fe40381f7e4bf0ff9ec6799cf6555c47f8ccb76883fa54e1b75a6"
        );
    }

    /// Desktop seals each text to the console's exact bytes and opens the
    /// console's, so a text set in either app opens in the other and on the
    /// share page.
    #[test]
    fn a_text_seals_and_opens_byte_for_byte_with_the_console() {
        let (key, token, vectors) = console_vectors();
        assert_eq!(vectors.len(), 2);
        for v in vectors {
            let nonce: [u8; NONCE_LEN] = STANDARD.decode(&v.nonce).unwrap().try_into().unwrap();
            let sealed = seal_text_with_nonce(&key, &token, &v.text, &nonce).unwrap();
            assert_eq!(sealed.hash, v.hash, "{:?}", v.text);
            assert_eq!(sealed.ct, v.ct, "{:?}", v.text);
            assert_eq!(sealed.nonce, v.nonce);
            assert_eq!(open_text(&key, &token, &v.ct, &v.nonce).as_deref(), Some(v.text.as_str()));
        }
    }

    #[test]
    fn a_text_opens_only_on_its_link_with_its_key() {
        let sealed = seal_text(&key(1), TOKEN, "Keep it to yourself.").unwrap();
        assert_eq!(
            open_text(&key(1), TOKEN, &sealed.ct, &sealed.nonce).as_deref(),
            Some("Keep it to yourself.")
        );
        assert_ne!(
            sealed.nonce,
            seal_text(&key(1), TOKEN, "Keep it to yourself.").unwrap().nonce,
            "a fresh nonce each time"
        );
        assert_eq!(open_text(&key(1), "tok_another_link_123456", &sealed.ct, &sealed.nonce), None);
        assert_eq!(open_text(&key(2), TOKEN, &sealed.ct, &sealed.nonce), None);
        // A comment or a viewer's email is never read as the text.
        let email = comment_crypto::seal_with_nonce(&key(1), TOKEN, Purpose::ViewerEmail, &[3; NONCE_LEN], b"a@b.co").unwrap();
        assert_eq!(open_text(&key(1), TOKEN, &STANDARD.encode(email), &STANDARD.encode([3; NONCE_LEN])), None);
        assert_eq!(open_text(&key(1), TOKEN, "not base64!", &sealed.nonce), None);
    }

    #[test]
    fn what_the_owner_typed_is_trimmed_and_checked_before_anything_is_sent() {
        assert_eq!(text_to_send("  Keep it quiet.\n\n").unwrap(), "Keep it quiet.");
        assert!(matches!(text_to_send(" \n\t "), Err(AppError::Validation(m)) if m == TEXT_EMPTY));
        let at_limit = "a".repeat(MAX_NDA_TEXT_BYTES);
        assert!(text_to_send(&at_limit).is_ok());
        // The limit is in bytes, as the server counts it.
        let over = "é".repeat(MAX_NDA_TEXT_BYTES / 2 + 1);
        assert!(matches!(text_to_send(&over), Err(AppError::Validation(m)) if m == TEXT_TOO_LONG));
    }

    #[test]
    fn setting_a_text_needs_the_plan_and_the_links_key() {
        let k = key(1);
        assert!(may_set(Some(true), Ok(&k)).is_ok());
        assert!(may_set(None, Ok(&k)).is_ok(), "an unread plan locks nothing; the server still checks");
        assert!(matches!(may_set(Some(false), Ok(&k)), Err(AppError::Validation(m)) if m == NDA_NOT_IN_PLAN));
        assert!(matches!(may_set(Some(true), Err(KeyUnavailable::Password)), Err(AppError::Validation(m)) if m == KEY_NOT_HERE));
        assert!(matches!(may_set(Some(true), Err(KeyUnavailable::NotOnDevice)), Err(AppError::Validation(m)) if m == KEY_NOT_HERE));
    }

    fn stored(k: &CommentKey, text: &str) -> WireNda {
        let s = seal_text(k, TOKEN, text).unwrap();
        WireNda {
            hash: s.hash,
            ct: s.ct,
            nonce: s.nonce,
        }
    }

    /// Never on a password link without a text; a text already there can
    /// always be turned off, whatever the plan or key.
    #[test]
    fn the_setting_is_offered_where_a_text_can_be_sealed_or_removed() {
        let k = key(1);
        let off = link_nda(None, TOKEN, Ok(&k), Some(true));
        assert_eq!((off.offered, off.on, off.editable, off.text.as_deref()), (true, false, true, None));

        let password = link_nda(None, TOKEN, Err(KeyUnavailable::Password), Some(true));
        assert!(!password.offered, "a password link's text could be neither sealed nor read");
        assert!(!link_nda(None, TOKEN, Err(KeyUnavailable::NotOnDevice), Some(true)).offered);

        let n = stored(&k, "Keep it quiet.");
        let on = link_nda(Some(&n), TOKEN, Ok(&k), Some(false));
        assert_eq!(
            (on.offered, on.on, on.text.as_deref(), on.in_plan),
            (true, true, Some("Keep it quiet."), Some(false))
        );

        let elsewhere = link_nda(Some(&n), TOKEN, Err(KeyUnavailable::NotOnDevice), None);
        assert_eq!(
            (elsewhere.offered, elsewhere.on, elsewhere.editable, elsewhere.text),
            (true, true, false, None)
        );
    }

    #[test]
    fn accepts_name_only_a_proven_email_and_mark_an_earlier_text() {
        let k = key(1);
        let now = stored(&k, "Version two.");
        let before = text_hash("Version one.");
        let sealed_email = |email: &str| {
            let ct = comment_crypto::seal_with_nonce(&k, TOKEN, Purpose::ViewerEmail, &[4; NONCE_LEN], email.as_bytes()).unwrap();
            (STANDARD.encode([4; NONCE_LEN]), STANDARD.encode(ct))
        };
        let (n1, c1) = sealed_email("alice@acme.com");
        let (n2, c2) = sealed_email("ceo@acme.com");
        let check = STANDARD.encode(comment_crypto::email_check(TOKEN, "alice@acme.com"));
        let body = serde_json::json!({
            "nda": { "text_hash": now.hash, "text_ct": now.ct, "text_nonce": now.nonce, "set_at": "2026-11-10T12:00:00Z" },
            "accepts": [
                { "id": 40, "text_hash": STANDARD.encode(before), "viewer_id": "v1", "email_check": null, "email_ct": null, "email_nonce": null, "accepted_at": "2026-11-09T10:00:00Z" },
                { "id": "41", "text_hash": now.hash, "viewer_id": "v2", "email_check": check, "email_ct": c1, "email_nonce": n1, "accepted_at": "2026-11-10T12:03:10Z" },
                // The page sealed another address than the one its pass proved.
                { "id": 42, "text_hash": now.hash, "viewer_id": "v3", "email_check": check, "email_ct": c2, "email_nonce": n2, "accepted_at": "2026-11-10T12:04:00Z" },
                { "id": 43, "text_hash": now.hash, "viewer_id": "", "accepted_at": "2026-11-10T12:05:00Z" }
            ],
            "next_after": 42
        });
        let page = parse_accepts_page(&body.to_string()).unwrap();
        assert!(needs_key(&page));
        let view = accepts_view(&page, TOKEN, Some(&k));
        assert_eq!(
            (view.offered, view.has_text, view.text.as_deref(), view.next_after),
            (true, true, Some("Version two."), Some(42))
        );
        let rows: Vec<_> = view
            .accepts
            .iter()
            .map(|a| (a.id, a.viewer_id.as_str(), a.email.as_deref(), a.earlier))
            .collect();
        assert_eq!(
            rows,
            [(40, "v1", None, true), (41, "v2", Some("alice@acme.com"), false), (42, "v3", None, false),],
            "a row without a viewer is dropped"
        );

        // Without the key nothing opens, and the rows still list.
        let locked = accepts_view(&page, TOKEN, None);
        assert_eq!((locked.has_text, locked.text.as_deref()), (true, None));
        assert!(locked.accepts.iter().all(|a| a.email.is_none()));

        // With the text removed, every accept is of an earlier text.
        let removed = parse_accepts_page(
            r#"{"nda":null,"accepts":[{"id":1,"text_hash":"x","viewer_id":"v","accepted_at":"2026-11-01T00:00:00Z"}],"next_after":null}"#,
        )
        .unwrap();
        assert!(!needs_key(&removed));
        let view = accepts_view(&removed, TOKEN, None);
        assert_eq!((view.has_text, view.next_after), (false, None));
        assert!(view.accepts[0].earlier);
    }

    #[test]
    fn the_servers_refusals_read_in_the_apps_words() {
        let api = |status, body: &str| AppError::Api {
            status,
            body: body.to_string(),
        };
        assert!(matches!(nda_refusal(api(403, r#"{"error":"paid_plan_required"}"#)), AppError::Validation(m) if m == NDA_NOT_IN_PLAN));
        assert!(matches!(nda_refusal(api(502, r#"{"error":"billing_unavailable"}"#)), AppError::Validation(m) if m == PLAN_UNREADABLE));
        assert!(matches!(nda_refusal(api(400, r#"{"error":"bad_request","message":"text_ct"}"#)), AppError::Validation(m) if m == COULDNT_SAVE));
        assert!(matches!(nda_refusal(api(500, "boom")), AppError::Api { status: 500, .. }));
    }

    #[tokio::test]
    async fn the_whole_log_is_read_page_by_page_with_the_text_opened() {
        let sealed = seal_text(&key(1), "tok_1", "Keep it quiet.").unwrap();
        let nda = serde_json::json!({ "text_hash": sealed.hash, "text_ct": sealed.ct, "text_nonce": sealed.nonce });
        let page = move |q: Option<&str>| {
            let (ids, next) = match q {
                None => (vec![1, 2], serde_json::json!(2)),
                Some("after=2") => (vec![3], serde_json::json!("3")),
                _ => (vec![], serde_json::Value::Null),
            };
            let accepts: Vec<_> = ids
                .iter()
                .map(|id| serde_json::json!({ "id": id, "text_hash": sealed.hash, "viewer_id": format!("v{id}"), "accepted_at": "2026-11-20T10:00:00Z" }))
                .collect();
            serde_json::json!({ "nda": nda, "accepts": accepts, "next_after": next }).to_string()
        };
        let (base, seen) = mock(move |s| (200, page(s.query.as_deref()))).await;
        let log = read_whole_log(&reqwest::Client::new(), &Api::new(&base, "b"), "tok_1", Some(&key(1)))
            .await
            .unwrap();
        assert_eq!(log.accepts.iter().map(|a| a.id).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(log.text.as_deref(), Some("Keep it quiet."));
        assert_eq!(log.next_after, None);
        // Stops at the page that names no next one.
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn the_text_is_set_listed_and_removed_on_the_links_routes() {
        let (base, seen) = mock(|s| match (s.method.as_str(), s.path.as_str()) {
            ("DELETE", "/v1/shares/no_text/nda") => (404, String::new()),
            ("PUT", "/v1/shares/free_plan/nda") => (403, r#"{"error":"paid_plan_required"}"#.into()),
            ("GET", _) => (200, r#"{"nda":null,"accepts":[],"next_after":null}"#.into()),
            _ => (204, String::new()),
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "owner-bearer"));
        let sealed = seal_text_with_nonce(&key(1), "tok_1", "Keep it quiet.", &[7; NONCE_LEN]).unwrap();

        put_nda(&http, &api, "tok_1", &sealed).await.unwrap();
        assert!(matches!(put_nda(&http, &api, "free_plan", &sealed).await, Err(AppError::Validation(m)) if m == NDA_NOT_IN_PLAN));
        get_accepts(&http, &api, "tok_1", 0).await.unwrap();
        get_accepts(&http, &api, "tok_1", 500).await.unwrap();
        delete_nda(&http, &api, "tok_1").await.unwrap();
        delete_nda(&http, &api, "no_text").await.unwrap();

        let seen = seen.lock().unwrap().clone();
        let put = seen.iter().find(|s| s.method == "PUT").unwrap();
        assert_eq!(put.path, "/v1/shares/tok_1/nda");
        assert_eq!(put.auth.as_deref(), Some("Bearer owner-bearer"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&put.body).unwrap(),
            serde_json::json!({ "text_hash": sealed.hash, "text_ct": sealed.ct, "text_nonce": STANDARD.encode([7; NONCE_LEN]) })
        );
        assert!(!put.body.contains("Keep it quiet"), "the text never leaves in the clear");
        let gets: Vec<_> = seen
            .iter()
            .filter(|s| s.method == "GET")
            .map(|s| (s.path.as_str(), s.query.as_deref()))
            .collect();
        assert_eq!(
            gets,
            [
                ("/v1/shares/tok_1/nda/accepts", None),
                ("/v1/shares/tok_1/nda/accepts", Some("after=500"))
            ]
        );
        assert!(seen.iter().any(|s| s.method == "DELETE" && s.path == "/v1/shares/tok_1/nda"));
    }

    #[test]
    fn the_setting_and_the_accepts_cross_ipc_in_camel_case() {
        assert_eq!(
            serde_json::to_value(LinkNda::default()).unwrap(),
            serde_json::json!({ "offered": false, "on": false, "text": null, "editable": false, "inPlan": null })
        );
        let view = NdaAccepts {
            offered: true,
            has_text: true,
            text: Some("T".into()),
            accepts: vec![NdaAccept {
                id: 1,
                viewer_id: "v".into(),
                email: None,
                accepted_at: "2026-11-10T12:00:00Z".into(),
                earlier: false,
            }],
            next_after: Some(1),
        };
        assert_eq!(
            serde_json::to_value(view).unwrap(),
            serde_json::json!({
                "offered": true, "hasText": true, "text": "T", "nextAfter": 1,
                "accepts": [{ "id": 1, "viewerId": "v", "email": null, "acceptedAt": "2026-11-10T12:00:00Z", "earlier": false }]
            })
        );
    }

    /// Offline, the capabilities read fails: every command must say Hippius
    /// couldn't be reached, never that the feature is missing.
    #[test]
    fn every_command_reads_the_capabilities_strictly_and_is_gated_on_share_nda() {
        let src = include_str!("nda.rs");
        for name in [
            "pub async fn share_get_nda(",
            "pub async fn share_set_nda(",
            "pub async fn share_remove_nda(",
            "pub async fn share_nda_accepts(",
        ] {
            let start = src.find(name).unwrap_or_else(|| panic!("{name} is defined"));
            let body = &src[start..start + src[start..].find("\n}\n").expect("the body ends")];
            assert!(
                body.contains("capabilities_checked(&state, &account_id, UNREACHABLE).await?.share_nda"),
                "{name}"
            );
            assert!(!body.contains("capabilities_or_none("), "{name}");
        }
        // Removing never asks the plan: it works on every plan.
        let start = src.find("pub async fn share_remove_nda(").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        assert!(!body.contains("read_switches_in_plan"));
    }
}
