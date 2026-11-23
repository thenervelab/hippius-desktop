//! Links per person, and Insights grouped by person (hcfs #1183, #1291): the
//! owner's side, matching the console's `recipient-links.ts`.
//!
//! One stored copy of a file, a link of its own for each person it goes to,
//! each with its own views, pages and revoke. Hippius never mails them: the
//! owner copies each link, or opens it in their own mail app.
//!
//! Server routes (owner bearer):
//!
//! - `POST /v1/shares/{token}/recipients` `{link_envelope, link_fetch_digest,
//!   label, ttl}` → `201 {share_token, expires_at, link_group, nda_pending}`:
//!   a new link over the stored copy of the live link `{token}`, which joins
//!   its group. No second upload, and the group is billed once. `409
//!   recipient_link_limit` past [`MAX_GROUP_LINKS`] live links, `403
//!   paid_plan_required` on a plan without them. Without a `gate` the new
//!   link gets a copy of the source's. Behind `share_recipient_links`.
//! - `nda_pending: true` means the source has an NDA text. The server cannot
//!   copy it (it is sealed under the share key with the source's token as
//!   additional data), so the new link opens for no one until this computer
//!   opens the source's text, seals it for the new token and sends `PUT
//!   .../nda` ([`finish_nda`]). A locked source has no text to read, so the
//!   text comes from the first link of the group that has one. A link whose
//!   text could not be set stays listed as `ndaPending`, with Try again
//!   ([`share_retry_recipient_nda`]), and is found again after a restart
//!   through its `/meta`, which says `nda_pending` too.
//! - `GET /v1/shares/{token}/group-insights`: the group's insights over every
//!   live link, and each link's own counts. Behind `share_group_insights`.
//! - Revoke is the usual `DELETE /v1/shares/{token}`, one link at a time.
//!
//! A recipient link opens with a link secret of its own (`#s=`), never the
//! share key: the envelope is the source link's share key sealed under that
//! secret (hcfs-client's folder link envelope, the format the share page opens
//! for file links too). The secret reaches other devices only through an owner
//! wrap (`owner_wrap::seal_file_link_secret_with_key`), and is kept in memory
//! here for this session ([`MADE_THIS_SESSION`]) in case that wrap does not
//! land.
//!
//! Each link's name is sealed on this computer before it reaches the server,
//! byte-compatible with the console's `recipient-label.ts`:
//!
//! ```text
//! key   = BLAKE3 derive_key("hippius.hcfs.share-link-label.v1", bip39_seed[..32])
//! label = 0x01 || nonce(24) || XChaCha20-Poly1305(key, utf8(name), aad)
//! aad   = "hippius.hcfs.share-link-label.v1" || 0x00 || owner_ss58
//! ```
//!
//! Pinned against the console's own sealed bytes
//! (`tests/fixtures/share_recipient_vectors.json`).

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{LazyLock, Mutex};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bip39::Mnemonic;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use chrono::{DateTime, Utc};
use hcfs_client::client::folder_link::{fetch_digest_for_secret, generate_folder_link_secret, seal_folder_link_envelope};
use hcfs_client::client::share::ShareTtl;
use serde::{Deserialize, Serialize};
use tracing::{debug, info};
use zeroize::Zeroizing;

use super::capabilities::ServerCapabilities;
use super::comment_crypto::{self, CommentKey};
use super::insights::{
    Api, KeyUnavailable, LINK_GONE, OfferedSwitches, PLAN_UNREADABLE, REQUEST_TIMEOUT, SettingsPatch, UNREACHABLE, WireEmail, capabilities_checked,
    get_meta_body, patch_settings, read_ok, share_key_for, transport,
};
use super::nda::{read_link_text, set_link_text};
use super::owner_wrap::{WrapKey, derive_wrap_key, open_file_link_secret, push_file_link_secrets};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// The BLAKE3 `derive_key` context of the key names are sealed under.
pub const LINK_LABEL_KDF_CONTEXT: &str = "hippius.hcfs.share-link-label.v1";
const LABEL_VERSION: u8 = 1;
const LABEL_NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// The server's cap on a decoded label (`MAX_LINK_LABEL_LEN`).
pub const MAX_SEALED_LABEL_BYTES: usize = 512;
/// The longest name, in bytes of UTF-8, that still fits once sealed.
pub const MAX_LABEL_NAME_BYTES: usize = MAX_SEALED_LABEL_BYTES - 1 - LABEL_NONCE_LEN - TAG_LEN;
/// The most live links one copy can have, its first link included.
pub const MAX_GROUP_LINKS: usize = 100;

const UNAVAILABLE: &str = "Links per person aren't available yet.";
const LIMIT: &str = "A file can have up to 100 links. Revoke one to add another.";
const GATE_REQUIRED: &str = "This link asks people for their email, so links per person can't be made from it yet.";
/// Refused on a plan without links per person (`403 paid_plan_required`).
pub const RECIPIENTS_NOT_IN_PLAN: &str = "Links per person are available on paid Drive plans.";
const GATE_QUOTA: &str = "Your account has as many links asking for an email as it can have. Remove one to add another.";
/// A new link whose NDA text could not be set: it opens for no one yet.
const NDA_NOT_SET: &str = "The new link was made, but its NDA couldn't be added, so it won't open yet. Try again.";
/// No link of the group has an NDA text this computer can open.
const NDA_TEXT_MISSING: &str =
    "This file's NDA text couldn't be found, so the new link won't open. Revoke it, then set the NDA on the file's link again.";
const SOURCE_GONE: &str = "This link has expired or was revoked. Make a new link first.";
const PASSWORD_LINK: &str = "A link with a password can't have links per person.";
const KEY_NOT_HERE: &str = "This link's key isn't on this computer, so people can't be added here.";
/// A `#s=` link whose share key was never kept here and that the server no
/// longer hands out (it asks for an email, or it has ended).
const KEY_NOT_FETCHABLE: &str = "This link's key can no longer be fetched on this computer, so people can't be added here.";
const KEY_UNREACHABLE: &str = "Couldn't reach Hippius to get this link ready. Try again.";
const NAME_TOO_LONG: &str = "A name is too long. Use a shorter one.";
const COULDNT_MAKE: &str = "Couldn't make the link. Try again.";

/// Link secrets of the recipient links made in this session, by token, so a
/// link can be copied again even when its owner wrap did not land.
static MADE_THIS_SESSION: LazyLock<Mutex<HashMap<String, Zeroizing<[u8; 32]>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember(token: &str, secret: &[u8; 32]) {
    if let Ok(mut made) = MADE_THIS_SESSION.lock() {
        made.insert(token.to_string(), Zeroizing::new(*secret));
    }
}

fn remembered(token: &str) -> Option<Zeroizing<[u8; 32]>> {
    MADE_THIS_SESSION.lock().ok()?.get(token).cloned()
}

fn forget(token: &str) {
    if let Ok(mut made) = MADE_THIS_SESSION.lock() {
        made.remove(token);
    }
    nda_done(token);
}

/// Recipient links made in this session whose NDA text could not be set, so
/// the listing marks them without asking each link's `/meta`.
static NDA_PENDING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn nda_still_pending(token: &str) {
    if let Ok(mut pending) = NDA_PENDING.lock() {
        pending.insert(token.to_string());
    }
}

fn nda_done(token: &str) {
    if let Ok(mut pending) = NDA_PENDING.lock() {
        pending.remove(token);
    }
}

fn nda_pending_here() -> HashSet<String> {
    NDA_PENDING.lock().map(|p| p.clone()).unwrap_or_default()
}

// ─── Names, sealed ─────────────────────────────────────────────────────────

pub(crate) type LabelKey = Zeroizing<[u8; 32]>;

/// The 32-byte key names are sealed under. BIP-39 PBKDF2 runs once here, so
/// derive it once per call and pass it down.
pub(crate) fn derive_label_key(master_mnemonic: &str) -> std::result::Result<LabelKey, String> {
    let mnemonic = Mnemonic::from_str(master_mnemonic).map_err(|e| e.to_string())?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    Ok(Zeroizing::new(blake3::derive_key(LINK_LABEL_KDF_CONTEXT, &seed[..32])))
}

fn label_aad(owner_ss58: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(LINK_LABEL_KDF_CONTEXT.len() + 1 + owner_ss58.len());
    aad.extend_from_slice(LINK_LABEL_KDF_CONTEXT.as_bytes());
    aad.push(0);
    aad.extend_from_slice(owner_ss58.as_bytes());
    aad
}

/// Whether `name` fits in a sealed label.
#[must_use]
pub fn label_fits(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_LABEL_NAME_BYTES
}

fn seal_label_with_nonce(key: &LabelKey, owner_ss58: &str, name: &str, nonce: &[u8; LABEL_NONCE_LEN]) -> std::result::Result<Vec<u8>, String> {
    if !label_fits(name) {
        return Err("name is empty or too long".into());
    }
    let cipher = XChaCha20Poly1305::new((&**key).into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: name.as_bytes(),
                aad: &label_aad(owner_ss58),
            },
        )
        .map_err(|_| "aead seal failed".to_string())?;
    let mut out = Vec::with_capacity(1 + LABEL_NONCE_LEN + ciphertext.len());
    out.push(LABEL_VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Seal `name` for the owner `owner_ss58`, under a fresh nonce.
pub(crate) fn seal_label(key: &LabelKey, owner_ss58: &str, name: &str) -> std::result::Result<Vec<u8>, String> {
    let mut nonce = [0u8; LABEL_NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_label_with_nonce(key, owner_ss58, name, &nonce)
}

/// Open a sealed name, or `None` for anything that does not open.
pub(crate) fn open_label(key: &LabelKey, owner_ss58: &str, sealed: &[u8]) -> Option<String> {
    if sealed.len() < 1 + LABEL_NONCE_LEN + TAG_LEN + 1 || sealed[0] != LABEL_VERSION {
        return None;
    }
    let cipher = XChaCha20Poly1305::new((&**key).into());
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&sealed[1..=LABEL_NONCE_LEN]),
            Payload {
                msg: &sealed[(1 + LABEL_NONCE_LEN)..],
                aad: &label_aad(owner_ss58),
            },
        )
        .ok()?;
    String::from_utf8(plain).ok()
}

fn open_label_b64(key: Option<&LabelKey>, owner_ss58: &str, b64: Option<&str>) -> Option<String> {
    let sealed = STANDARD.decode(b64?).ok()?;
    open_label(key?, owner_ss58, &sealed)
}

// ─── What the owner typed ──────────────────────────────────────────────────

/// The names in what the owner typed: split on commas, semicolons and new
/// lines, trimmed, inner spaces collapsed, without repeats (ignoring case)
/// and without the names the file already has a link for.
#[must_use]
pub fn split_names(input: &str, existing: &[String]) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = existing.iter().map(|n| n.trim().to_lowercase()).collect();
    let mut out = Vec::new();
    for raw in input.split([',', ';', '\n']) {
        let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() || !seen.insert(name.to_lowercase()) {
            continue;
        }
        out.push(name);
    }
    out
}

/// Whether a name is an email address, so its link can open the mail app.
/// The console's rule: `^[^\s@]+@[^\s@]+\.[^\s@]+$`.
#[must_use]
pub fn is_email_label(name: &str) -> bool {
    if name.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = name.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.contains('@') {
        return false;
    }
    domain.char_indices().any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// `s` percent-encoded as JavaScript's `encodeURIComponent` does.
fn encode_uri_component(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// A `mailto:` that opens the owner's own mail app with the link in the
/// body, the file's name as the subject. The console's exact form.
#[must_use]
pub fn mailto_for(email: &str, file_name: &str, url: &str) -> String {
    format!(
        "mailto:{}?subject={}&body={}",
        encode_uri_component(email).replace("%40", "@"),
        encode_uri_component(file_name),
        encode_uri_component(&format!("{url}\n"))
    )
}

/// The expiry a new recipient link gets: about as long as the link it is
/// made from has left, so the links of one file end together. Never shorter
/// than a day, the shortest the server takes.
#[must_use]
pub fn ttl_for(source_expires_at: Option<&str>, now: DateTime<Utc>) -> ShareTtl {
    let Some(at) = source_expires_at else {
        return ShareTtl::Never;
    };
    let Ok(at) = DateTime::parse_from_rfc3339(at) else {
        return ShareTtl::Hours24;
    };
    let left = at.with_timezone(&Utc) - now;
    if left > chrono::Duration::days(7) {
        ShareTtl::Days30
    } else if left > chrono::Duration::days(1) {
        ShareTtl::Days7
    } else {
        ShareTtl::Hours24
    }
}

/// `<origin>/share/<token>#s=<base64url-no-pad(link secret)>`: a file link
/// that carries a link secret instead of the share key. The path tells it
/// from a folder link's `/share/folder/<token>#s=`.
#[must_use]
pub fn file_link_url(origin: &str, share_token: &str, link_secret: &[u8; 32]) -> String {
    format!(
        "{}/share/{}#s={}",
        origin.trim_end_matches('/'),
        encode_uri_component(share_token),
        URL_SAFE_NO_PAD.encode(link_secret)
    )
}

// ─── The owner listing ─────────────────────────────────────────────────────

/// A link's switches as the owner listing carries them.
#[derive(Debug, Clone, Copy, Deserialize)]
struct WireSettings {
    #[serde(default)]
    insights: bool,
    #[serde(default)]
    comments: bool,
    #[serde(default)]
    reactions: bool,
    #[serde(default = "yes")]
    download: bool,
    /// Absent on a server without `share_watermark_switch`, where the
    /// watermark follows `download`.
    #[serde(default)]
    watermark: Option<bool>,
}

const fn yes() -> bool {
    true
}

/// One row of `GET /v1/shares`, the fields this module reads. The listing in
/// hcfs-client predates groups and labels, so it is read here as JSON.
#[derive(Debug, Clone, Deserialize)]
struct ListingRow {
    share_token: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    owner_wrap: Option<String>,
    #[serde(default)]
    link_group: Option<String>,
    #[serde(default)]
    link_label: Option<String>,
    #[serde(default)]
    settings: Option<WireSettings>,
    /// A locked recipient link still waiting for its NDA text (hcfs #1418).
    /// Absent on a server whose listing predates it, where each link's
    /// `/meta` is asked instead.
    #[serde(default)]
    nda_pending: Option<bool>,
}

fn is_live(row: &ListingRow, now: DateTime<Utc>) -> bool {
    row.expires_at
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .is_none_or(|at| at.with_timezone(&Utc) > now)
}

/// The recipient links in the group of `source`: the live rows of the
/// listing that share its `link_group` and carry a label, oldest first. The
/// source itself (made without a label) is not one of them.
fn recipient_rows<'a>(rows: &'a [ListingRow], source: &ListingRow, now: DateTime<Utc>) -> Vec<&'a ListingRow> {
    let Some(group) = source.link_group.as_deref() else {
        return Vec::new();
    };
    let mut out: Vec<&ListingRow> = rows
        .iter()
        .filter(|row| {
            row.link_group.as_deref() == Some(group)
                && row.share_token != source.share_token
                && row.link_label.as_deref().is_some_and(|l| !l.is_empty())
                && is_live(row, now)
        })
        .collect();
    out.sort_by_key(|row| DateTime::parse_from_rfc3339(&row.created_at).map_or(0, |t| t.timestamp_millis()));
    out
}

/// The switches to send a new recipient link so it counts and allows what
/// the link it was made from does. A new link starts with insights, comments
/// and reactions off, so without this its views would not be counted. Only
/// the keys this server takes; `None` when there is nothing to change.
fn settings_patch(source: Option<WireSettings>, caps: &ServerCapabilities) -> Option<SettingsPatch> {
    let source = source?;
    let offered = OfferedSwitches::from_caps(caps);
    let patch = SettingsPatch {
        insights: (offered.insights && source.insights).then_some(true),
        comments: (offered.comments && source.comments).then_some(true),
        reactions: (offered.reactions && source.reactions).then_some(true),
        download: (caps.share_download_switch && !source.download).then_some(false),
        // A new link's watermark follows its download switch until it is
        // sent, so only a source whose watermark was set apart from it is
        // copied; sending it otherwise would stop the new link following.
        watermark: source.watermark.filter(|w| caps.share_watermark_switch && *w == source.download),
    };
    (patch != SettingsPatch::default()).then_some(patch)
}

async fn get_listing(http: &reqwest::Client, api: &Api) -> Result<Vec<ListingRow>> {
    let resp = http
        .get(api.listing_url())
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("share listing", e))?;
    let body = read_ok(resp).await?;
    serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("share listing parse failed: {e}")))
}

// ─── What crosses IPC ──────────────────────────────────────────────────────

/// One person a file went to, in the share dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipientPerson {
    pub share_token: String,
    /// The name it was made for, opened here; `None` when it does not open.
    pub name: Option<String>,
    /// The link, when this computer can rebuild it.
    pub url: Option<String>,
    /// For a name that is an email and a link that is known: opens the
    /// owner's mail app with the link in it.
    pub mailto: Option<String>,
    /// The link was made from one with an NDA, and its own NDA text is not
    /// set yet, so it opens for no one. The app offers Try again
    /// ([`share_retry_recipient_nda`]) instead of the link.
    pub nda_pending: bool,
}

/// Links per person for one file link, as the share dialog draws them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipientLinks {
    /// Draw the section at all: the server has links per person, and either
    /// people can be added here or the link already has some.
    pub offered: bool,
    /// People can be added here: the link's key and the account's
    /// passphrase are on this computer.
    pub can_add: bool,
    /// Oldest first.
    pub people: Vec<RecipientPerson>,
}

/// What adding people did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedRecipients {
    /// The links made, in the order the names were typed.
    pub people: Vec<RecipientPerson>,
    /// The names not made, to put back in the box.
    pub left: String,
    /// Why the first of them was not, in words.
    pub error: Option<String>,
}

fn person(
    row: &ListingRow,
    owner: &str,
    label_key: Option<&LabelKey>,
    wrap_key: Option<&WrapKey>,
    origin: &str,
    nda_pending: bool,
) -> RecipientPerson {
    let name = open_label_b64(label_key, owner, row.link_label.as_deref());
    let secret = remembered(&row.share_token).or_else(|| {
        let wrap = STANDARD.decode(row.owner_wrap.as_deref()?).ok()?;
        open_file_link_secret(wrap_key?, owner, &row.share_token, &wrap).ok()
    });
    let url = secret.map(|s| file_link_url(origin, &row.share_token, &s));
    RecipientPerson {
        nda_pending,
        ..person_with(row.share_token.clone(), name, url, &row.filename)
    }
}

fn person_with(share_token: String, name: Option<String>, url: Option<String>, file_name: &str) -> RecipientPerson {
    let mailto = match (&name, &url) {
        (Some(name), Some(url)) if is_email_label(name) => Some(mailto_for(name, file_name, url)),
        _ => None,
    };
    RecipientPerson {
        share_token,
        name,
        url,
        mailto,
        nda_pending: false,
    }
}

/// Whether a link's `/meta` says it waits for its NDA text.
fn meta_says_nda_pending(body: &str) -> bool {
    #[derive(Deserialize)]
    struct Wire {
        #[serde(default)]
        nda_pending: bool,
    }
    serde_json::from_str::<Wire>(body).is_ok_and(|w| w.nda_pending)
}

/// The recipient links among `rows` that wait for their NDA text. The
/// listing says so for each link (`nda_pending`); a server whose listing
/// predates the field omits it, and for those rows the links this session
/// already knows of count, and any whose `/meta` says so (a link made in an
/// earlier session, or whose `201` never arrived). A `/meta` that does not
/// answer marks nothing.
async fn nda_pending_links(http: &reqwest::Client, api: &Api, rows: &[&ListingRow]) -> HashSet<String> {
    use futures_util::StreamExt as _;
    let mut found: HashSet<String> = rows
        .iter()
        .filter(|r| r.nda_pending == Some(true))
        .map(|r| r.share_token.clone())
        .collect();
    let known = nda_pending_here();
    let unlisted: Vec<String> = rows.iter().filter(|r| r.nda_pending.is_none()).map(|r| r.share_token.clone()).collect();
    found.extend(unlisted.iter().filter(|t| known.contains(*t)).cloned());
    let ask: Vec<String> = unlisted.into_iter().filter(|t| !known.contains(t)).collect();
    let asked: HashSet<String> = futures_util::stream::iter(ask)
        .map(|token| async move {
            let pending = get_meta_body(http, api, &token).await.is_ok_and(|b| meta_says_nda_pending(&b));
            pending.then_some(token)
        })
        .buffer_unordered(8)
        .filter_map(|t| async move { t })
        .collect()
        .await;
    found.extend(asked);
    found
}

// ─── Making links ──────────────────────────────────────────────────────────

/// A refused `POST .../recipients`, in words.
fn create_refusal(err: AppError) -> AppError {
    match err {
        AppError::NotFound(_) => AppError::NotFound(SOURCE_GONE.into()),
        AppError::Api { status, body } => {
            let code = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_default();
            match (status, code.as_str()) {
                (409, "gate_required") => AppError::Validation(GATE_REQUIRED.into()),
                (409, "gate_quota_exceeded") => AppError::Validation(GATE_QUOTA.into()),
                (409, _) => AppError::Validation(LIMIT.into()),
                (400, _) => AppError::Validation(COULDNT_MAKE.into()),
                (403, "paid_plan_required") => AppError::Validation(RECIPIENTS_NOT_IN_PLAN.into()),
                (502, "billing_unavailable") => AppError::Validation(PLAN_UNREADABLE.into()),
                (401 | 403, _) => AppError::Auth("Sign in again to add people.".into()),
                _ => AppError::Api { status, body },
            }
        }
        other => other,
    }
}

/// The sentence the dialog shows for an error.
fn sentence(err: &AppError) -> String {
    match err {
        AppError::Validation(m) | AppError::NotFound(m) | AppError::Auth(m) => m.clone(),
        AppError::Hcfs(_) => UNREACHABLE.to_string(),
        _ => COULDNT_MAKE.to_string(),
    }
}

/// Whether an error is about this one name, so the names after it may still
/// be tried. Anything else (the limit, the link gone, no answer) stops.
fn only_this_name(err: &AppError) -> bool {
    matches!(err, AppError::Validation(m) if m == COULDNT_MAKE)
}

/// Everything one call of [`add_people`] makes links with.
struct Minting<'a> {
    owner: &'a str,
    source_token: &'a str,
    share_key: &'a [u8; 32],
    label_key: &'a LabelKey,
    ttl: ShareTtl,
    patch: Option<SettingsPatch>,
    origin: &'a str,
    file_name: &'a str,
    /// Where a locked new link's NDA text is read from, in order
    /// ([`nda_sources`]).
    nda_from: &'a [String],
}

/// Make one recipient link: a fresh link secret, the source's share key
/// sealed under it, the name sealed for the owner, then the POST. Answers the
/// new token, the secret, which never leaves this computer otherwise, and
/// whether the link waits for its NDA text (`nda_pending`).
async fn mint_one(http: &reqwest::Client, api: &Api, m: &Minting<'_>, name: &str) -> Result<(String, Zeroizing<[u8; 32]>, bool)> {
    let secret = Zeroizing::new(generate_folder_link_secret());
    let file_key = hcfs_crypto::FileKey::from_bytes(*m.share_key);
    let envelope = seal_folder_link_envelope(&secret, &file_key).map_err(|e| AppError::Crypto(e.to_string()))?;
    let label = seal_label(m.label_key, m.owner, name).map_err(AppError::Crypto)?;
    let body = serde_json::json!({
        "link_envelope": STANDARD.encode(envelope),
        "link_fetch_digest": STANDARD.encode(fetch_digest_for_secret(&secret)),
        "label": STANDARD.encode(label),
        "ttl": m.ttl,
    });
    let resp = http
        .post(api.share_url(m.source_token, "/recipients")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|e| transport("recipient link", e))?;
    let body = read_ok(resp).await.map_err(create_refusal)?;
    #[derive(Deserialize)]
    struct Created {
        share_token: String,
        /// A server from before locked links omits it.
        #[serde(default)]
        nda_pending: bool,
    }
    let created: Created = serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("recipient link response did not parse: {e}")))?;
    Ok((created.share_token, secret, created.nda_pending))
}

/// The links a new link's NDA text can be read from: the source first, then
/// the other live links of its group, oldest first. A source that is itself
/// locked has no text, and a group's links all carry the same one.
fn nda_sources(rows: &[ListingRow], source: &ListingRow, now: DateTime<Utc>) -> Vec<String> {
    let mut others: Vec<&ListingRow> = match source.link_group.as_deref() {
        Some(group) => rows
            .iter()
            .filter(|row| row.link_group.as_deref() == Some(group) && row.share_token != source.share_token && is_live(row, now))
            .collect(),
        None => Vec::new(),
    };
    others.sort_by_key(|row| DateTime::parse_from_rfc3339(&row.created_at).map_or(0, |t| t.timestamp_millis()));
    std::iter::once(source.share_token.clone())
        .chain(others.into_iter().map(|row| row.share_token.clone()))
        .collect()
}

/// The group's NDA text: the first of `from` whose text opens with `key`.
/// A link that cannot be read is passed over; when no link has a text, the
/// first such failure is the answer, else [`NDA_TEXT_MISSING`].
async fn group_nda_text(http: &reqwest::Client, api: &Api, key: &CommentKey, from: &[String]) -> Result<String> {
    let mut failed = None;
    for token in from {
        match read_link_text(http, api, token, key).await {
            Ok(Some(text)) => return Ok(text),
            Ok(None) => {}
            Err(e) => {
                failed.get_or_insert(e);
            }
        }
    }
    Err(failed.unwrap_or_else(|| AppError::Validation(NDA_TEXT_MISSING.into())))
}

/// Unlock a new link: the group's NDA text, read once per call of
/// [`add_people`] (`text`), sealed for `token` and set on it.
async fn finish_nda(http: &reqwest::Client, api: &Api, m: &Minting<'_>, token: &str, text: &mut Option<String>) -> Result<()> {
    let key = CommentKey::derive(m.share_key);
    if text.is_none() {
        *text = Some(group_nda_text(http, api, &key, m.nda_from).await?);
    }
    let Some(text) = text.as_deref() else {
        return Err(AppError::Validation(NDA_TEXT_MISSING.into()));
    };
    set_link_text(http, api, token, &key, text).await
}

/// The sentence for a new link left locked: the plan prompt or the missing
/// text as they are, anything else as [`NDA_NOT_SET`].
fn nda_sentence(err: &AppError) -> String {
    match err {
        AppError::Validation(m) if m == NDA_TEXT_MISSING || m == super::nda::NDA_NOT_IN_PLAN => m.clone(),
        _ => NDA_NOT_SET.to_string(),
    }
}

/// Make a link for each name, in order. A refusal about one name moves on to
/// the next; anything else (the limit, the link gone, no answer) stops, and
/// the names not made are handed back. The link's switches follow the
/// source's, best effort: the link works either way.
async fn add_people(http: &reqwest::Client, api: &Api, m: &Minting<'_>, names: &[String]) -> (AddedRecipients, Vec<(String, Zeroizing<[u8; 32]>)>) {
    let mut out = AddedRecipients::default();
    let mut secrets = Vec::new();
    let mut left: Vec<&str> = Vec::new();
    let mut nda_text: Option<String> = None;
    for (i, name) in names.iter().enumerate() {
        match mint_one(http, api, m, name).await {
            Ok((token, secret, nda_pending)) => {
                info!("recipient link created");
                if let Some(patch) = m.patch
                    && let Err(e) = patch_settings(http, api, &token, &patch).await
                {
                    debug!(error = %e, "recipient link: switches not sent");
                }
                let url = file_link_url(m.origin, &token, &secret);
                let mut made = person_with(token.clone(), Some(name.clone()), Some(url), m.file_name);
                // A link made from one with an NDA opens for no one until
                // its own text is set. When that fails it stays listed as
                // waiting, with Try again, and the names after it are not
                // made: they would be locked the same way.
                let mut locked = None;
                if nda_pending {
                    match finish_nda(http, api, m, &token, &mut nda_text).await {
                        Ok(()) => info!("recipient link: nda set"),
                        Err(e) => {
                            debug!(error = %e, "recipient link: nda not set");
                            nda_still_pending(&token);
                            made.nda_pending = true;
                            locked = Some(nda_sentence(&e));
                        }
                    }
                }
                out.people.push(made);
                secrets.push((token, secret));
                if let Some(sentence) = locked {
                    out.error.get_or_insert(sentence);
                    left.extend(names[i + 1..].iter().map(String::as_str));
                    break;
                }
            }
            Err(e) => {
                left.push(name);
                if out.error.is_none() {
                    out.error = Some(sentence(&e));
                }
                if !only_this_name(&e) {
                    left.extend(names[i + 1..].iter().map(String::as_str));
                    break;
                }
            }
        }
    }
    out.left = left.join(", ");
    (out, secrets)
}

// ─── Group insights ────────────────────────────────────────────────────────

/// One live link of a file's group, as the People tab shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPerson {
    pub share_token: String,
    /// A link made for a person (it carries a name), which can be revoked
    /// here. The file's own link is not.
    pub recipient: bool,
    /// The name, opened here; `None` for the file's own link and for a name
    /// that does not open.
    pub name: Option<String>,
    pub views: u64,
    pub viewers: u64,
    /// "3 of 12 pages" for a document, the most any one viewer of this link
    /// saw; `None` when nothing says.
    pub pages: Option<String>,
    /// The emails this link's viewers proved, checked against the server's
    /// check of each, without repeats.
    pub emails: Vec<String>,
}

/// Insights grouped by person.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInsights {
    /// Draw the People tab: the server groups insights and this link's
    /// group has more than one live link.
    pub offered: bool,
    /// Each live link of the group, oldest first.
    pub people: Vec<GroupPerson>,
    /// Some links carry a name that could not be opened here.
    pub names_hidden: bool,
    /// The group's visits are past what a paid view reads at once: only the
    /// counts are shown.
    pub over_visit_budget: bool,
}

#[derive(Debug, Deserialize)]
struct WireGroupLink {
    share_token: String,
    #[serde(default)]
    link_label: Option<String>,
    #[serde(default)]
    total_views: u64,
    #[serde(default)]
    unique_viewers: u64,
}

#[derive(Debug, Deserialize)]
struct WireGroupViewer {
    #[serde(default)]
    share_token: Option<String>,
    #[serde(default)]
    pages_seen: Option<u32>,
    #[serde(default)]
    emails: Option<Vec<WireEmail>>,
}

#[derive(Debug, Deserialize)]
struct WireGroupPages {
    #[serde(default)]
    page_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct WireGroup {
    #[serde(default)]
    plan: String,
    #[serde(default)]
    locked: Vec<String>,
    #[serde(default)]
    links: Vec<WireGroupLink>,
    #[serde(default)]
    viewers: Option<Vec<WireGroupViewer>>,
    #[serde(default)]
    pages: Option<WireGroupPages>,
    #[serde(default)]
    over_visit_budget: bool,
}

/// "3 of 12 pages", "3 pages", or `None` when nothing says.
#[must_use]
pub fn pages_label(seen: Option<u32>, page_count: Option<u32>) -> Option<String> {
    let seen = seen?;
    match page_count {
        Some(n) if n > 0 => Some(format!("{} of {n} pages", seen.min(n))),
        _ if seen == 1 => Some("1 page".into()),
        _ => Some(format!("{seen} pages")),
    }
}

/// Read a group insights answer. What the plan locks stays locked: on a plan
/// that is not paid, or with `viewers` named in `locked`, no pages or emails
/// are read. `name` opens a link's sealed label; `email` opens a viewer's
/// email for the link it came from.
fn parse_group(
    body: &str,
    document_views: bool,
    mut name: impl FnMut(&str) -> Option<String>,
    mut email: impl FnMut(&str, &WireEmail) -> Option<String>,
) -> Result<GroupInsights> {
    let wire: WireGroup = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("group insights parse failed: {e}")))?;
    let paid = wire.plan == "paid";
    let viewers_shown = paid && !wire.locked.iter().any(|l| l == "viewers");
    let page_count = if document_views && paid && !wire.locked.iter().any(|l| l == "pages") {
        wire.pages
            .as_ref()
            .and_then(|p| p.page_count)
            .filter(|n| *n > 0 && *n <= super::insights::MAX_PAGES)
    } else {
        None
    };

    let mut pages_seen: HashMap<String, u32> = HashMap::new();
    let mut emails: HashMap<String, Vec<String>> = HashMap::new();
    if viewers_shown {
        for viewer in wire.viewers.unwrap_or_default() {
            let Some(token) = viewer.share_token else {
                continue;
            };
            if document_views && let Some(seen) = viewer.pages_seen {
                let best = pages_seen.entry(token.clone()).or_insert(0);
                *best = (*best).max(seen);
            }
            // The latest email this viewer proved that opens and checks.
            if let Some(found) = viewer.emails.unwrap_or_default().iter().rev().find_map(|e| email(&token, e)) {
                let list = emails.entry(token).or_default();
                if !list.contains(&found) {
                    list.push(found);
                }
            }
        }
    }

    let mut names_hidden = false;
    let people: Vec<GroupPerson> = wire
        .links
        .into_iter()
        .map(|link| {
            let recipient = link.link_label.as_deref().is_some_and(|l| !l.is_empty());
            let opened = if recipient {
                link.link_label.as_deref().and_then(&mut name)
            } else {
                None
            };
            names_hidden |= recipient && opened.is_none();
            GroupPerson {
                pages: pages_label(pages_seen.get(&link.share_token).copied(), page_count),
                emails: emails.remove(&link.share_token).unwrap_or_default(),
                share_token: link.share_token,
                recipient,
                name: opened,
                views: link.total_views,
                viewers: link.unique_viewers,
            }
        })
        .collect();
    Ok(GroupInsights {
        offered: people.len() > 1,
        people,
        names_hidden,
        over_visit_budget: wire.over_visit_budget,
    })
}

async fn get_group_body(http: &reqwest::Client, api: &Api, token: &str) -> Result<String> {
    let resp = http
        .get(api.share_url(token, "/group-insights")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("group insights", e))?;
    read_ok(resp).await
}

async fn delete_link(http: &reqwest::Client, api: &Api, token: &str) -> Result<()> {
    let resp = http
        .delete(api.share_url(token, "")?)
        .bearer_auth(&api.bearer)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("revoke", e))?;
    match read_ok(resp).await {
        // Already gone, which is what was asked for.
        Ok(_) | Err(AppError::NotFound(_)) => Ok(()),
        Err(e) => Err(e),
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// The keys sealed names and owner wraps need, from the account's
/// passphrase, when it is on this computer.
async fn account_keys(state: &AppState, account_id: &str) -> (Option<LabelKey>, Option<WrapKey>) {
    let Ok(mnemonic) = crate::sync::mnemonic::get_mnemonic_for_account(state, account_id).await else {
        return (None, None);
    };
    (derive_label_key(&mnemonic).ok(), derive_wrap_key(&mnemonic).ok())
}

fn source_row(rows: &[ListingRow], token: &str) -> Option<ListingRow> {
    rows.iter().find(|r| r.share_token == token).cloned()
}

/// Links per person for the file link `share_token`, for the share dialog
/// and Link settings. Nothing is drawn on a server without them, for a link
/// that is itself a person's link, or when people can neither be added here
/// nor are there any.
#[tauri::command]
pub async fn share_recipient_links(state: tauri::State<'_, AppState>, share_token: String) -> Result<RecipientLinks> {
    let account_id = state.current_account_id()?;
    let caps = capabilities_checked(&state, &account_id, UNREACHABLE).await?;
    if !caps.share_recipient_links {
        return Ok(RecipientLinks::default());
    }
    let api = Api::for_account(&state, &account_id).await?;
    let rows = get_listing(&state.api_client, &api).await?;
    let Some(source) = source_row(&rows, &share_token) else {
        return Ok(RecipientLinks::default());
    };
    if source.link_label.is_some() {
        return Ok(RecipientLinks::default());
    }
    let (label_key, wrap_key) = account_keys(&state, &account_id).await;
    let can_add = label_key.is_some() && share_key_for(&state, &account_id, &share_token).await.is_ok();
    let origin = super::commands::console_base_url();
    let recipients = recipient_rows(&rows, &source, Utc::now());
    let pending = if caps.share_nda {
        nda_pending_links(&state.api_client, &api, &recipients).await
    } else {
        HashSet::new()
    };
    let people: Vec<RecipientPerson> = recipients
        .into_iter()
        .map(|row| {
            let locked = pending.contains(&row.share_token);
            person(row, &account_id, label_key.as_ref(), wrap_key.as_ref(), &origin, locked)
        })
        .collect();
    Ok(RecipientLinks {
        offered: can_add || !people.is_empty(),
        can_add,
        people,
    })
}

/// Make a link for each name in `names` (commas, semicolons or new lines
/// between them) over the stored copy of `share_token`.
#[tauri::command]
pub async fn share_add_recipient_links(state: tauri::State<'_, AppState>, share_token: String, names: String) -> Result<AddedRecipients> {
    let account_id = state.current_account_id()?;
    let caps = capabilities_checked(&state, &account_id, UNREACHABLE).await?;
    if !caps.share_recipient_links {
        return Err(AppError::Validation(UNAVAILABLE.into()));
    }
    let api = Api::for_account(&state, &account_id).await?;
    let rows = get_listing(&state.api_client, &api).await?;
    let now = Utc::now();
    let Some(source) = source_row(&rows, &share_token).filter(|r| is_live(r, now)) else {
        return Err(AppError::NotFound(SOURCE_GONE.into()));
    };
    let (Some(label_key), wrap_key) = account_keys(&state, &account_id).await else {
        return Err(AppError::Validation(KEY_NOT_HERE.into()));
    };
    let share_key = share_key_for(&state, &account_id, &share_token)
        .await
        .map_err(|e| AppError::Validation(key_refusal(e).into()))?;
    let existing: Vec<String> = recipient_rows(&rows, &source, now)
        .into_iter()
        .filter_map(|row| open_label_b64(Some(&label_key), &account_id, row.link_label.as_deref()))
        .collect();
    let names = split_names(&names, &existing);
    if names.is_empty() {
        return Ok(AddedRecipients::default());
    }
    if names.iter().any(|n| !label_fits(n)) {
        return Err(AppError::Validation(NAME_TOO_LONG.into()));
    }
    let origin = super::commands::console_base_url();
    let minting = Minting {
        owner: &account_id,
        source_token: &share_token,
        share_key: &share_key,
        label_key: &label_key,
        ttl: ttl_for(source.expires_at.as_deref(), now),
        patch: if caps.share_insights {
            settings_patch(source.settings, &caps)
        } else {
            None
        },
        origin: &origin,
        file_name: &source.filename,
        nda_from: &nda_sources(&rows, &source, now),
    };
    let (added, secrets) = add_people(&state.api_client, &api, &minting, &names).await;
    for (token, secret) in &secrets {
        remember(token, secret);
    }
    if caps.share_owner_wrap
        && let Some(wrap_key) = wrap_key
    {
        push_file_link_secrets(&state, &account_id, &wrap_key, &secrets).await;
    }
    Ok(added)
}

/// Revoke one person's link; the others keep working.
#[tauri::command]
pub async fn share_revoke_recipient_link(state: tauri::State<'_, AppState>, share_token: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    let api = Api::for_account(&state, &account_id).await?;
    delete_link(&state.api_client, &api, &share_token).await?;
    forget(&share_token);
    Ok(())
}

/// Set the NDA text on `recipient_token`, a link made from `share_token` that
/// still opens for no one (`ndaPending`): the group's text, sealed for it.
#[tauri::command]
pub async fn share_retry_recipient_nda(state: tauri::State<'_, AppState>, share_token: String, recipient_token: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    let api = Api::for_account(&state, &account_id).await?;
    let rows = get_listing(&state.api_client, &api).await?;
    let now = Utc::now();
    let Some(source) = source_row(&rows, &share_token).filter(|r| is_live(r, now)) else {
        return Err(AppError::NotFound(SOURCE_GONE.into()));
    };
    let share_key = share_key_for(&state, &account_id, &share_token)
        .await
        .map_err(|e| AppError::Validation(key_refusal(e).into()))?;
    retry_nda(&state.api_client, &api, &share_key, &nda_sources(&rows, &source, now), &recipient_token).await?;
    nda_done(&recipient_token);
    info!("recipient link: nda set on retry");
    Ok(())
}

/// The HTTP half of [`share_retry_recipient_nda`]: never reads the text from
/// the link being unlocked, which has none.
async fn retry_nda(http: &reqwest::Client, api: &Api, share_key: &[u8; 32], from: &[String], token: &str) -> Result<()> {
    let key = CommentKey::derive(share_key);
    let from: Vec<String> = from.iter().filter(|t| *t != token).cloned().collect();
    let text = group_nda_text(http, api, &key, &from).await?;
    set_link_text(http, api, token, &key, &text).await.map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound(LINK_GONE.into()),
        other => other,
    })
}

/// Insights grouped by person for the file link `share_token`: one row per
/// live link of its group. `offered: false` on a server without group
/// insights and for a link with no other links.
#[tauri::command]
pub async fn share_group_insights(state: tauri::State<'_, AppState>, share_token: String) -> Result<GroupInsights> {
    let account_id = state.current_account_id()?;
    let caps = capabilities_checked(&state, &account_id, UNREACHABLE).await?;
    if !caps.share_group_insights {
        return Ok(GroupInsights::default());
    }
    let api = Api::for_account(&state, &account_id).await?;
    let body = get_group_body(&state.api_client, &api, &share_token).await.map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound(LINK_GONE.into()),
        other => other,
    })?;
    let has_labels = body.contains("\"link_label\":\"");
    let label_key = if has_labels { account_keys(&state, &account_id).await.0 } else { None };
    // Every link of a group carries the same share key, so its comment key
    // opens every link's emails, each with its own token.
    let comment_key = if body.contains("\"email_ct\":\"") {
        comment_key_for_group(&state, &account_id, &share_token, &body).await
    } else {
        None
    };
    parse_group(
        &body,
        caps.share_document_views,
        |label| open_label_b64(label_key.as_ref(), &account_id, Some(label)),
        |token, e| match (&comment_key, &e.nonce, &e.ct, &e.check) {
            (Some(key), Some(nonce), Some(ct), Some(check)) => comment_crypto::open_viewer_email(key, token, nonce, ct, check),
            _ => None,
        },
    )
}

/// The comment key of a group: from `token`'s own key, else from the
/// group's link without a name (the one the others were made from), whose
/// key this computer is likelier to hold.
async fn comment_key_for_group(state: &AppState, account_id: &str, token: &str, body: &str) -> Option<CommentKey> {
    if let Ok(key) = share_key_for(state, account_id, token).await {
        return Some(CommentKey::derive(&key));
    }
    let wire: WireGroup = serde_json::from_str(body).ok()?;
    for link in wire.links.iter().filter(|l| l.link_label.is_none() && l.share_token != token) {
        if let Ok(key) = share_key_for(state, account_id, &link.share_token).await {
            return Some(CommentKey::derive(&key));
        }
    }
    None
}

/// Why people can't be added to a link whose share key could not be had.
fn key_refusal(reason: KeyUnavailable) -> &'static str {
    match reason {
        KeyUnavailable::Password => PASSWORD_LINK,
        KeyUnavailable::NotOnDevice => KEY_NOT_HERE,
        KeyUnavailable::NotFetchable => KEY_NOT_FETCHABLE,
        KeyUnavailable::Unreachable => KEY_UNREACHABLE,
    }
}

#[cfg(test)]
mod tests {
    /// A `#s=` link's share key that could not be fetched says why, apart
    /// from a password link and a key that is not here.
    #[test]
    fn each_unavailable_key_has_its_own_sentence() {
        let sentences: std::collections::HashSet<&str> = [
            KeyUnavailable::Password,
            KeyUnavailable::NotOnDevice,
            KeyUnavailable::NotFetchable,
            KeyUnavailable::Unreachable,
        ]
        .into_iter()
        .map(key_refusal)
        .collect();
        assert_eq!(sentences.len(), 4);
        assert_eq!(key_refusal(KeyUnavailable::Password), PASSWORD_LINK);
    }

    use super::super::insights::tests::mock;
    use super::*;
    use hcfs_client::client::folder_link::open_folder_link_envelope;

    const OWNER: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/share_recipient_vectors.json"
        )))
        .unwrap()
    }

    fn key() -> LabelKey {
        derive_label_key(fixture()["mnemonic"].as_str().unwrap()).unwrap()
    }

    /// A name sealed by the console opens here, and a fixed-nonce seal here
    /// gives the console's bytes, so a name typed in either app reads in the
    /// other.
    #[test]
    fn a_name_seals_and_opens_byte_for_byte_with_the_console() {
        let f = fixture();
        let key = key();
        assert_eq!(hex::encode(*key), f["label_key_hex"].as_str().unwrap());
        for v in f["labels"].as_array().unwrap() {
            let name = v["name"].as_str().unwrap();
            let sealed = STANDARD.decode(v["sealed_b64"].as_str().unwrap()).unwrap();
            let nonce: [u8; LABEL_NONCE_LEN] = hex::decode(v["nonce_hex"].as_str().unwrap()).unwrap().try_into().unwrap();
            assert_eq!(open_label(&key, OWNER, &sealed).as_deref(), Some(name));
            assert_eq!(seal_label_with_nonce(&key, OWNER, name, &nonce).unwrap(), sealed);
        }
    }

    /// The server cannot read a name, and neither can another account.
    #[test]
    fn a_name_opens_only_for_its_owner_and_untampered() {
        let key = key();
        let sealed = seal_label(&key, OWNER, "Alice").unwrap();
        assert_eq!(open_label(&key, OWNER, &sealed).as_deref(), Some("Alice"));
        assert_eq!(open_label(&key, "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", &sealed), None);
        let mut flipped = sealed.clone();
        *flipped.last_mut().unwrap() ^= 1;
        assert_eq!(open_label(&key, OWNER, &flipped), None);
        let mut v2 = sealed;
        v2[0] = 2;
        assert_eq!(open_label(&key, OWNER, &v2), None);
        assert_eq!(open_label(&key, OWNER, &[1u8; 10]), None);
    }

    /// The server takes 1 to 512 bytes.
    #[test]
    fn every_sealed_name_fits_the_servers_512_bytes() {
        let key = key();
        let longest = "a".repeat(MAX_LABEL_NAME_BYTES);
        assert!(label_fits(&longest));
        assert_eq!(seal_label(&key, OWNER, &longest).unwrap().len(), MAX_SEALED_LABEL_BYTES);
        assert!(!label_fits(&format!("{longest}a")));
        assert!(!label_fits(""));
        assert!(seal_label(&key, OWNER, "").is_err());
    }

    #[test]
    fn names_split_on_commas_semicolons_and_lines_without_repeats() {
        let existing = vec!["Carol".to_string()];
        assert_eq!(
            split_names(" Alice ,bob@example.com;\n alice ; Bob  Smith\ncarol,, ", &existing),
            vec!["Alice", "bob@example.com", "Bob Smith"]
        );
        assert!(split_names(" , ; \n", &[]).is_empty());
    }

    #[test]
    fn only_an_address_reads_as_an_email() {
        assert!(is_email_label("bob@example.com"));
        assert!(is_email_label("a@b.co"));
        for not in [
            "Alice",
            "bob@",
            "@example.com",
            "bob@example",
            "bob@.com",
            "bob@example.",
            "a b@example.com",
            "a@b@c.com",
        ] {
            assert!(!is_email_label(not), "{not}");
        }
    }

    /// The console's exact `mailto:`, so both apps open the same message.
    #[test]
    fn the_mailto_carries_the_link_and_the_file_name() {
        assert_eq!(
            mailto_for(
                "bob+x@example.com",
                "Q3 plan & notes.pdf",
                "https://console.hippius.com/share/tok#s=AB-c_"
            ),
            "mailto:bob%2Bx@example.com?subject=Q3%20plan%20%26%20notes.pdf&body=https%3A%2F%2Fconsole.hippius.com%2Fshare%2Ftok%23s%3DAB-c_%0A"
        );
    }

    #[test]
    fn a_recipient_link_ends_about_when_its_source_does() {
        let now = DateTime::parse_from_rfc3339("2026-11-18T12:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(ttl_for(None, now), ShareTtl::Never);
        assert_eq!(ttl_for(Some("2026-12-10T12:00:00Z"), now), ShareTtl::Days30);
        assert_eq!(ttl_for(Some("2026-11-21T12:00:00Z"), now), ShareTtl::Days7);
        assert_eq!(ttl_for(Some("2026-11-18T18:00:00Z"), now), ShareTtl::Hours24);
        assert_eq!(ttl_for(Some("not a date"), now), ShareTtl::Hours24);
    }

    #[test]
    fn the_link_is_a_file_link_secret_url() {
        let f = fixture();
        let w = &f["file_link_wrap"];
        let secret: [u8; 32] = hex::decode(w["link_secret_hex"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert_eq!(
            file_link_url("https://console.hippius.com/", w["share_token"].as_str().unwrap(), &secret),
            w["url"].as_str().unwrap()
        );
    }

    fn row(token: &str, group: Option<&str>, label: Option<&str>, created: &str, expires: Option<&str>) -> ListingRow {
        ListingRow {
            share_token: token.into(),
            filename: "Plan.pdf".into(),
            created_at: created.into(),
            expires_at: expires.map(str::to_string),
            owner_wrap: None,
            link_group: group.map(str::to_string),
            link_label: label.map(str::to_string),
            settings: None,
            nda_pending: None,
        }
    }

    #[test]
    fn a_files_people_are_its_groups_live_named_links_oldest_first() {
        let now = DateTime::parse_from_rfc3339("2026-11-18T12:00:00Z").unwrap().with_timezone(&Utc);
        let source = row("src", Some("g"), None, "2026-11-01T00:00:00Z", None);
        let rows = vec![
            source.clone(),
            row("b", Some("g"), Some("bbb"), "2026-11-03T00:00:00Z", None),
            row("a", Some("g"), Some("aaa"), "2026-11-02T00:00:00Z", Some("2026-12-01T00:00:00Z")),
            row("expired", Some("g"), Some("eee"), "2026-11-02T00:00:00Z", Some("2026-11-10T00:00:00Z")),
            row("other-group", Some("h"), Some("ooo"), "2026-11-02T00:00:00Z", None),
            row("unnamed", Some("g"), None, "2026-11-02T00:00:00Z", None),
        ];
        let tokens: Vec<&str> = recipient_rows(&rows, &source, now).iter().map(|r| r.share_token.as_str()).collect();
        assert_eq!(tokens, ["a", "b"]);
        assert!(recipient_rows(&rows, &row("lone", None, None, "", None), now).is_empty());
    }

    /// A new link starts with every switch off; it is sent what its source
    /// has on, and download off, only for the keys the server takes.
    #[test]
    fn a_new_link_is_sent_its_sources_switches() {
        let caps = ServerCapabilities {
            share_insights: true,
            share_comments: true,
            share_download_switch: true,
            ..Default::default()
        };
        let all = WireSettings {
            insights: true,
            comments: true,
            reactions: false,
            download: false,
            watermark: Some(true),
        };
        assert_eq!(
            settings_patch(Some(all), &caps),
            Some(SettingsPatch {
                insights: Some(true),
                comments: Some(true),
                reactions: None,
                download: Some(false),
                watermark: None,
            })
        );
        let insights_only = ServerCapabilities {
            share_insights: true,
            ..Default::default()
        };
        assert_eq!(
            settings_patch(Some(all), &insights_only),
            Some(SettingsPatch {
                insights: Some(true),
                ..Default::default()
            })
        );
        let off = WireSettings {
            insights: false,
            comments: false,
            reactions: false,
            download: true,
            watermark: Some(false),
        };
        assert_eq!(settings_patch(Some(off), &caps), None);
        assert_eq!(settings_patch(None, &caps), None);
    }

    /// The watermark is copied only where the source set it apart from its
    /// download switch: a value that only follows downloads is left to the
    /// new link to follow too, and a server without the switch is never
    /// sent it.
    #[test]
    fn a_new_link_gets_its_sources_watermark_only_where_it_was_set_apart() {
        let caps = ServerCapabilities {
            share_download_switch: true,
            share_watermark_switch: true,
            ..Default::default()
        };
        let source = |download: bool, watermark: Option<bool>| WireSettings {
            insights: false,
            comments: false,
            reactions: false,
            download,
            watermark,
        };
        let watermarked_download = settings_patch(Some(source(true, Some(true))), &caps).unwrap();
        assert_eq!(watermarked_download.watermark, Some(true));
        let view_only_plain = settings_patch(Some(source(false, Some(false))), &caps).unwrap();
        assert_eq!((view_only_plain.download, view_only_plain.watermark), (Some(false), Some(false)));
        let following = settings_patch(Some(source(false, Some(true))), &caps).unwrap();
        assert_eq!(following.watermark, None, "a watermark that follows downloads is not sent");
        assert_eq!(settings_patch(Some(source(true, Some(false))), &caps), None);
        let old = ServerCapabilities {
            share_download_switch: true,
            ..Default::default()
        };
        assert_eq!(settings_patch(Some(source(true, Some(true))), &old), None);
    }

    const NDA_FROM: &[String] = &[];

    fn minting<'a>(share_key: &'a [u8; 32], label_key: &'a LabelKey, patch: Option<SettingsPatch>) -> Minting<'a> {
        Minting {
            nda_from: NDA_FROM,
            owner: OWNER,
            source_token: "src_token",
            share_key,
            label_key,
            ttl: ShareTtl::Days7,
            patch,
            origin: "https://console.hippius.com",
            file_name: "Plan.pdf",
        }
    }

    /// What reaches the server: the source's key sealed under the new link's
    /// own secret (never the key itself), the digest of that secret, the name
    /// sealed for the owner, the expiry; then the switches. The link handed
    /// back opens with the secret.
    #[tokio::test]
    async fn adding_a_person_sends_an_envelope_and_a_sealed_name_only() {
        let (base, seen) = mock(|s| match (s.method.as_str(), s.path.as_str()) {
            ("POST", "/v1/shares/src_token/recipients") => (201, r#"{"share_token":"new_tok","expires_at":null,"link_group":"g"}"#.into()),
            ("PATCH", "/v1/shares/new_tok/settings") => (200, "{}".into()),
            _ => (500, String::new()),
        })
        .await;
        let api = Api::new(&base, "bearer");
        let share_key = [7u8; 32];
        let label_key = key();
        let patch = Some(SettingsPatch {
            insights: Some(true),
            ..Default::default()
        });
        let (added, secrets) = add_people(
            &reqwest::Client::new(),
            &api,
            &minting(&share_key, &label_key, patch),
            &["bob@example.com".into()],
        )
        .await;

        assert_eq!(added.left, "");
        assert_eq!(added.error, None);
        assert_eq!(added.people.len(), 1);
        let p = &added.people[0];
        assert_eq!(p.share_token, "new_tok");
        assert_eq!(p.name.as_deref(), Some("bob@example.com"));
        let (_, secret) = &secrets[0];
        assert_eq!(
            p.url.as_deref(),
            Some(file_link_url("https://console.hippius.com", "new_tok", secret).as_str())
        );
        assert!(
            p.mailto
                .as_deref()
                .is_some_and(|m| m.starts_with("mailto:bob@example.com?subject=Plan.pdf&body="))
        );

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].auth.as_deref(), Some("Bearer bearer"));
        let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(body["ttl"], "7d");
        let envelope = STANDARD.decode(body["link_envelope"].as_str().unwrap()).unwrap();
        assert_eq!(open_folder_link_envelope(secret, &envelope).unwrap().as_bytes(), &share_key);
        assert_eq!(
            STANDARD.decode(body["link_fetch_digest"].as_str().unwrap()).unwrap(),
            fetch_digest_for_secret(secret)
        );
        let label = STANDARD.decode(body["label"].as_str().unwrap()).unwrap();
        assert_eq!(open_label(&label_key, OWNER, &label).as_deref(), Some("bob@example.com"));
        assert!(
            !seen[0].body.contains(&STANDARD.encode(share_key)),
            "the share key never leaves in the clear"
        );
        assert!(!seen[0].body.contains("bob@example.com"), "the name never leaves in the clear");
        assert_eq!(seen[1].method, "PATCH");
        assert_eq!(seen[1].body, r#"{"insights":true}"#);
    }

    /// The group's limit stops at once and hands back every name not made;
    /// a refusal of one name (a 400) moves on to the next.
    #[tokio::test]
    async fn a_refusal_hands_back_the_names_not_made() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n = calls.clone();
        let (base, _) = mock(move |_| match n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
            0 => (400, r#"{"error":"bad"}"#.into()),
            1 => (201, r#"{"share_token":"t2","expires_at":null,"link_group":"g"}"#.into()),
            _ => (409, r#"{"error":"recipient_link_limit"}"#.into()),
        })
        .await;
        let api = Api::new(&base, "bearer");
        let label_key = key();
        let names: Vec<String> = ["Ann", "Ben", "Cat", "Dan"].map(String::from).to_vec();
        let (added, _) = add_people(&reqwest::Client::new(), &api, &minting(&[1u8; 32], &label_key, None), &names).await;
        assert_eq!(added.people.iter().map(|p| p.name.clone().unwrap()).collect::<Vec<_>>(), ["Ben"]);
        assert_eq!(added.left, "Ann, Cat, Dan");
        assert_eq!(added.error.as_deref(), Some(COULDNT_MAKE));
    }

    #[test]
    fn the_servers_refusals_read_as_sentences() {
        let conflict = |body: &str| {
            create_refusal(AppError::Api {
                status: 409,
                body: body.into(),
            })
        };
        assert!(matches!(conflict(r#"{"error":"recipient_link_limit"}"#), AppError::Validation(m) if m == LIMIT));
        assert!(matches!(conflict(""), AppError::Validation(m) if m == LIMIT));
        assert!(matches!(conflict(r#"{"error":"gate_required"}"#), AppError::Validation(m) if m == GATE_REQUIRED));
        assert!(matches!(conflict(r#"{"error":"gate_quota_exceeded"}"#), AppError::Validation(m) if m == GATE_QUOTA));
        let api = |status, body: &str| create_refusal(AppError::Api { status, body: body.into() });
        // A free plan reads as the plan, never as "sign in again".
        assert!(matches!(api(403, r#"{"error":"paid_plan_required"}"#), AppError::Validation(m) if m == RECIPIENTS_NOT_IN_PLAN));
        assert!(matches!(api(502, r#"{"error":"billing_unavailable"}"#), AppError::Validation(m) if m == PLAN_UNREADABLE));
        assert!(matches!(api(403, r#"{"error":"account_suspended"}"#), AppError::Auth(_)));
        assert!(matches!(api(500, "boom"), AppError::Api { status: 500, .. }));
        assert!(matches!(create_refusal(AppError::NotFound(String::new())), AppError::NotFound(m) if m == SOURCE_GONE));
        assert!(matches!(
            create_refusal(AppError::Api {
                status: 403,
                body: String::new()
            }),
            AppError::Auth(_)
        ));
    }

    #[test]
    fn pages_read_against_the_documents_page_count() {
        assert_eq!(pages_label(Some(3), Some(12)).as_deref(), Some("3 of 12 pages"));
        assert_eq!(pages_label(Some(20), Some(12)).as_deref(), Some("12 of 12 pages"));
        assert_eq!(pages_label(Some(1), None).as_deref(), Some("1 page"));
        assert_eq!(pages_label(Some(4), None).as_deref(), Some("4 pages"));
        assert_eq!(pages_label(None, Some(12)), None);
    }

    const GROUP: &str = r#"{
        "plan": "paid", "locked": [], "total_views": 5, "unique_viewers": 3,
        "pages": {"page_count": 12},
        "viewers": [
            {"viewer_id": "v1", "share_token": "a", "pages_seen": 3, "emails": [{"email_check": "c1", "email_ct": "x1", "email_nonce": "n1"}]},
            {"viewer_id": "v2", "share_token": "a", "pages_seen": 9, "emails": [{"email_check": "c1", "email_ct": "x1", "email_nonce": "n1"}]},
            {"viewer_id": "v3", "share_token": "src", "pages_seen": 1}
        ],
        "links": [
            {"share_token": "src", "link_label": null, "total_views": 1, "unique_viewers": 1},
            {"share_token": "a", "link_label": "LA", "total_views": 4, "unique_viewers": 2},
            {"share_token": "b", "link_label": "LB", "total_views": 0, "unique_viewers": 0}
        ],
        "over_visit_budget": false
    }"#;

    /// One row per link: its own counts, the most pages any one of its
    /// viewers saw, the emails proved on it (each checked with its own
    /// token), and its name when it opens.
    #[test]
    fn group_insights_read_one_row_per_link() {
        let mut checked_with = Vec::new();
        let g = parse_group(
            GROUP,
            true,
            |label| (label == "LA").then(|| "Alice".to_string()),
            |token, e| {
                checked_with.push(token.to_string());
                (e.check.as_deref() == Some("c1")).then(|| "alice@example.com".to_string())
            },
        )
        .unwrap();
        assert!(g.offered);
        assert!(g.names_hidden, "b's name did not open");
        assert_eq!(checked_with, ["a", "a"]);
        assert_eq!(
            g.people,
            vec![
                GroupPerson {
                    share_token: "src".into(),
                    recipient: false,
                    name: None,
                    views: 1,
                    viewers: 1,
                    pages: Some("1 of 12 pages".into()),
                    emails: vec![],
                },
                GroupPerson {
                    share_token: "a".into(),
                    recipient: true,
                    name: Some("Alice".into()),
                    views: 4,
                    viewers: 2,
                    pages: Some("9 of 12 pages".into()),
                    emails: vec!["alice@example.com".into()],
                },
                GroupPerson {
                    share_token: "b".into(),
                    recipient: true,
                    name: None,
                    views: 0,
                    viewers: 0,
                    pages: None,
                    emails: vec![],
                },
            ]
        );
    }

    /// On a free plan, or with viewers locked, only the counts are read: no
    /// pages and no emails, whatever the body carries.
    #[test]
    fn a_locked_group_shows_counts_only() {
        let free = GROUP.replace(r#""plan": "paid""#, r#""plan": "free""#);
        let locked = GROUP.replace(r#""locked": []"#, r#""locked": ["viewers"]"#);
        for body in [free, locked] {
            let g = parse_group(&body, true, |_| None, |_, _| Some("leak@example.com".into())).unwrap();
            assert!(g.people.iter().all(|p| p.pages.is_none() && p.emails.is_empty()));
            assert_eq!(g.people.iter().map(|p| p.views).sum::<u64>(), 5);
        }
        let no_docs = parse_group(GROUP, false, |_| None, |_, _| None).unwrap();
        assert!(no_docs.people.iter().all(|p| p.pages.is_none()), "no pages without document views");
    }

    /// A link with no other links is a group of one: no People tab.
    #[test]
    fn a_lone_link_offers_no_people_tab() {
        let lone = r#"{"plan":"paid","locked":[],"links":[{"share_token":"src","link_label":null,"total_views":2,"unique_viewers":1}]}"#;
        assert!(!parse_group(lone, true, |_| None, |_, _| None).unwrap().offered);
    }

    #[tokio::test]
    async fn revoking_a_link_already_gone_is_done() {
        let (base, seen) = mock(|s| match s.method.as_str() {
            "DELETE" if s.path == "/v1/shares/gone" => (404, String::new()),
            "DELETE" => (204, String::new()),
            _ => (500, String::new()),
        })
        .await;
        let api = Api::new(&base, "bearer");
        delete_link(&reqwest::Client::new(), &api, "live").await.unwrap();
        delete_link(&reqwest::Client::new(), &api, "gone").await.unwrap();
        assert_eq!(
            seen.lock().unwrap().iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
            ["/v1/shares/live", "/v1/shares/gone"]
        );
    }

    #[tokio::test]
    async fn the_listing_is_read_as_json_with_groups_and_labels() {
        let (base, seen) = mock(|_| {
            (
                200,
                r#"[{"share_token":"s","filename":"a.pdf","created_at":"2026-11-01T00:00:00Z","expires_at":null,
                    "owner_wrap":null,"link_group":"g","link_label":"QQ==","link_secret":true,
                    "settings":{"insights":true,"comments":false,"reactions":false,"download":true},"counts":null}]"#
                    .into(),
            )
        })
        .await;
        let rows = get_listing(&reqwest::Client::new(), &Api::new(&base, "bearer")).await.unwrap();
        assert_eq!(seen.lock().unwrap()[0].path, "/v1/shares");
        assert_eq!(rows[0].link_group.as_deref(), Some("g"));
        assert_eq!(rows[0].link_label.as_deref(), Some("QQ=="));
        assert!(rows[0].settings.is_some_and(|s| s.insights && s.download));
    }

    // ─── A new link from a link with an NDA ───────────────────────────────

    const SHARE_KEY: [u8; 32] = [9u8; 32];
    const NDA: &str = "Keep the plan to yourself.";

    /// `GET .../nda/accepts` for a link whose text is `text`, sealed for
    /// `token`, or a locked link's (no text) when `text` is `None`.
    fn accepts_body(token: &str, text: Option<&str>) -> String {
        let Some(text) = text else {
            return r#"{"nda":null,"nda_pending":true,"accepts":[],"next_after":null}"#.into();
        };
        let key = CommentKey::derive(&SHARE_KEY);
        let nonce = [5u8; comment_crypto::NONCE_LEN];
        let ct = comment_crypto::seal_with_nonce(&key, token, comment_crypto::Purpose::NdaText, &nonce, text.as_bytes()).unwrap();
        serde_json::json!({
            "nda": { "text_hash": STANDARD.encode(super::super::nda::text_hash(text)), "text_ct": STANDARD.encode(ct),
                     "text_nonce": STANDARD.encode(nonce), "set_at": "2026-11-19T00:00:00Z" },
            "accepts": [], "next_after": null
        })
        .to_string()
    }

    /// The text a `PUT .../nda` body carries, opened as the share page opens
    /// it on `token`; `None` when it does not open there.
    fn put_text(body: &str, token: &str) -> Option<String> {
        let v: serde_json::Value = serde_json::from_str(body).unwrap();
        let key = CommentKey::derive(&SHARE_KEY);
        let plain = comment_crypto::open(
            &key,
            token,
            comment_crypto::Purpose::NdaText,
            &STANDARD.decode(v["text_nonce"].as_str()?).ok()?,
            &STANDARD.decode(v["text_ct"].as_str()?).ok()?,
        )
        .ok()?;
        assert_eq!(
            v["text_hash"].as_str().unwrap(),
            STANDARD.encode(super::super::nda::text_hash(std::str::from_utf8(&plain).unwrap()))
        );
        String::from_utf8(plain.to_vec()).ok()
    }

    /// The server locks a link made from one with an NDA (`nda_pending`):
    /// the source's text is opened here, sealed for the NEW token and set on
    /// it, so the link opens like any NDA link, and the text never leaves in
    /// the clear.
    #[tokio::test]
    async fn a_locked_new_link_gets_the_sources_nda_sealed_for_its_own_token() {
        let (base, seen) = mock(|s| match (s.method.as_str(), s.path.as_str()) {
            ("POST", "/v1/shares/src_token/recipients") => (
                201,
                r#"{"share_token":"new_tok","expires_at":null,"link_group":"src_token","nda_pending":true}"#.into(),
            ),
            ("GET", "/v1/shares/src_token/nda/accepts") => (200, accepts_body("src_token", Some(NDA))),
            ("PUT", "/v1/shares/new_tok/nda") => (204, String::new()),
            _ => (500, String::new()),
        })
        .await;
        let label_key = key();
        let from = vec!["src_token".to_string()];
        let m = Minting {
            nda_from: &from,
            ..minting(&SHARE_KEY, &label_key, None)
        };
        let (added, _) = add_people(&reqwest::Client::new(), &Api::new(&base, "bearer"), &m, &["Ann".into()]).await;
        assert_eq!(added.error, None);
        assert!(!added.people[0].nda_pending);

        let seen = seen.lock().unwrap();
        let put = seen.iter().find(|s| s.method == "PUT").expect("the NDA is set on the new link");
        assert_eq!(put.path, "/v1/shares/new_tok/nda");
        assert_eq!(put.auth.as_deref(), Some("Bearer bearer"));
        assert_eq!(put_text(&put.body, "new_tok").as_deref(), Some(NDA));
        assert_eq!(put_text(&put.body, "src_token"), None, "sealed for the new token, not the source's");
        assert!(!put.body.contains("Keep the plan"), "the text never leaves in the clear");
    }

    /// A link made from a locked link starts locked too: the text comes from
    /// a link of the group that has one, read once for every name.
    #[tokio::test]
    async fn a_locked_source_takes_the_text_from_another_link_of_its_group() {
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let made = n.clone();
        let (base, seen) = mock(move |s| match (s.method.as_str(), s.path.as_str()) {
            ("POST", _) => {
                let i = made.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                (
                    201,
                    format!(r#"{{"share_token":"new_{i}","expires_at":null,"link_group":"g","nda_pending":true}}"#),
                )
            }
            ("GET", "/v1/shares/locked_src/nda/accepts") => (200, accepts_body("locked_src", None)),
            ("GET", "/v1/shares/revoked/nda/accepts") => (404, String::new()),
            ("GET", "/v1/shares/first/nda/accepts") => (200, accepts_body("first", Some(NDA))),
            ("PUT", _) => (204, String::new()),
            _ => (500, String::new()),
        })
        .await;
        let label_key = key();
        let from: Vec<String> = ["locked_src", "revoked", "first"].map(String::from).to_vec();
        let m = Minting {
            source_token: "locked_src",
            nda_from: &from,
            ..minting(&SHARE_KEY, &label_key, None)
        };
        let (added, _) = add_people(&reqwest::Client::new(), &Api::new(&base, "bearer"), &m, &["Ann".into(), "Ben".into()]).await;
        assert_eq!(added.error, None);
        assert_eq!(added.people.len(), 2);

        let seen = seen.lock().unwrap();
        let reads = seen.iter().filter(|s| s.method == "GET").count();
        assert_eq!(reads, 3, "the group's text is read once, not per name");
        for token in ["new_0", "new_1"] {
            let put = seen
                .iter()
                .find(|s| s.method == "PUT" && s.path == format!("/v1/shares/{token}/nda"))
                .unwrap();
            assert_eq!(put_text(&put.body, token).as_deref(), Some(NDA));
        }
    }

    /// An NDA that could not be set never leaves a link silently locked: it
    /// is listed as waiting, with Rust's sentence, and the names after it go
    /// back in the box instead of making more locked links.
    #[tokio::test]
    async fn a_new_link_whose_nda_could_not_be_set_says_so_and_stops() {
        let (base, seen) = mock(|s| match (s.method.as_str(), s.path.as_str()) {
            ("POST", _) => (
                201,
                r#"{"share_token":"stuck_tok","expires_at":null,"link_group":"g","nda_pending":true}"#.into(),
            ),
            ("GET", _) => (200, accepts_body("src_token", Some(NDA))),
            ("PUT", _) => (500, "boom".into()),
            _ => (500, String::new()),
        })
        .await;
        let label_key = key();
        let from = vec!["src_token".to_string()];
        let m = Minting {
            nda_from: &from,
            ..minting(&SHARE_KEY, &label_key, None)
        };
        let names: Vec<String> = ["Ann", "Ben", "Cat"].map(String::from).to_vec();
        let (added, secrets) = add_people(&reqwest::Client::new(), &Api::new(&base, "bearer"), &m, &names).await;
        assert_eq!(added.people.len(), 1);
        assert!(added.people[0].nda_pending);
        assert_eq!(secrets.len(), 1, "the link exists, so its secret is still kept");
        assert_eq!(added.error.as_deref(), Some(NDA_NOT_SET));
        assert_eq!(added.left, "Ben, Cat");
        assert!(nda_pending_here().contains("stuck_tok"), "the listing marks it while the app runs");
        assert_eq!(seen.lock().unwrap().iter().filter(|s| s.method == "POST").count(), 1);
        forget("stuck_tok");
        assert!(!nda_pending_here().contains("stuck_tok"));
    }

    /// With no link of the group holding a text, the link is reported as
    /// locked with a sentence that says what to do.
    #[tokio::test]
    async fn no_text_anywhere_in_the_group_reads_as_missing() {
        let (base, _) = mock(|s| match (s.method.as_str(), s.path.as_str()) {
            ("POST", _) => (
                201,
                r#"{"share_token":"lone_tok","expires_at":null,"link_group":"g","nda_pending":true}"#.into(),
            ),
            ("GET", _) => (200, accepts_body("src_token", None)),
            _ => (500, String::new()),
        })
        .await;
        let label_key = key();
        let from = vec!["src_token".to_string()];
        let m = Minting {
            nda_from: &from,
            ..minting(&SHARE_KEY, &label_key, None)
        };
        let (added, _) = add_people(&reqwest::Client::new(), &Api::new(&base, "bearer"), &m, &["Ann".into()]).await;
        assert!(added.people[0].nda_pending);
        assert_eq!(added.error.as_deref(), Some(NDA_TEXT_MISSING));
        forget("lone_tok");
    }

    /// Without `nda_pending` (no NDA, or a server from before locked links)
    /// nothing is read or set.
    #[tokio::test]
    async fn a_link_without_nda_pending_sends_no_nda() {
        let (base, seen) = mock(|s| match s.method.as_str() {
            "POST" => (
                201,
                r#"{"share_token":"t","expires_at":null,"link_group":"g","nda_pending":false}"#.into(),
            ),
            _ => (500, String::new()),
        })
        .await;
        let label_key = key();
        let from = vec!["src_token".to_string()];
        let m = Minting {
            nda_from: &from,
            ..minting(&SHARE_KEY, &label_key, None)
        };
        let (added, _) = add_people(&reqwest::Client::new(), &Api::new(&base, "bearer"), &m, &["Ann".into()]).await;
        assert_eq!((added.error, added.people[0].nda_pending), (None, false));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// Try again reads the text from the group, never from the locked link
    /// itself, and sets it on that link.
    #[tokio::test]
    async fn try_again_sets_the_groups_text_on_the_locked_link() {
        let (base, seen) = mock(|s| match (s.method.as_str(), s.path.as_str()) {
            ("GET", "/v1/shares/src_token/nda/accepts") => (200, accepts_body("src_token", Some(NDA))),
            ("PUT", "/v1/shares/stuck/nda") => (204, String::new()),
            ("PUT", "/v1/shares/gone/nda") => (404, String::new()),
            _ => (500, String::new()),
        })
        .await;
        let (http, api) = (reqwest::Client::new(), Api::new(&base, "bearer"));
        let from: Vec<String> = ["src_token", "stuck"].map(String::from).to_vec();
        retry_nda(&http, &api, &SHARE_KEY, &from, "stuck").await.unwrap();
        assert!(matches!(retry_nda(&http, &api, &SHARE_KEY, &from, "gone").await, Err(AppError::NotFound(m)) if m == LINK_GONE));

        let seen = seen.lock().unwrap();
        assert!(!seen.iter().any(|s| s.path == "/v1/shares/stuck/nda/accepts"));
        let put = seen.iter().find(|s| s.path == "/v1/shares/stuck/nda").unwrap();
        assert_eq!(put_text(&put.body, "stuck").as_deref(), Some(NDA));
    }

    #[test]
    fn the_text_is_looked_for_on_the_source_then_its_group_oldest_first() {
        let now = DateTime::parse_from_rfc3339("2026-11-18T12:00:00Z").unwrap().with_timezone(&Utc);
        let source = row("src", Some("g"), Some("x"), "2026-11-05T00:00:00Z", None);
        let rows = vec![
            row("late", Some("g"), Some("l"), "2026-11-04T00:00:00Z", None),
            source.clone(),
            row("first", Some("g"), None, "2026-11-01T00:00:00Z", None),
            row("expired", Some("g"), Some("e"), "2026-11-02T00:00:00Z", Some("2026-11-10T00:00:00Z")),
            row("other", Some("h"), None, "2026-11-01T00:00:00Z", None),
        ];
        assert_eq!(nda_sources(&rows, &source, now), ["src", "first", "late"]);
        assert_eq!(nda_sources(&rows, &row("lone", None, None, "", None), now), ["lone"]);
    }

    /// A link found locked through its `/meta` (made in an earlier session,
    /// or whose `201` was lost) is marked; anything else is not.
    #[test]
    fn meta_marks_a_link_waiting_for_its_nda() {
        assert!(meta_says_nda_pending(r#"{"nda":true,"nda_pending":true}"#));
        assert!(!meta_says_nda_pending(r#"{"nda":true,"nda_pending":false}"#));
        assert!(!meta_says_nda_pending(r#"{"nda":true}"#));
        assert!(!meta_says_nda_pending("not json"));
    }

    #[tokio::test]
    async fn the_listing_asks_meta_only_for_links_it_does_not_already_know() {
        let (base, seen) = mock(|s| match s.path.as_str() {
            "/v1/shares/locked/meta" => (200, r#"{"nda":true,"nda_pending":true}"#.into()),
            "/v1/shares/open/meta" => (200, r#"{"nda":true,"nda_pending":false}"#.into()),
            _ => (500, String::new()),
        })
        .await;
        nda_still_pending("known_locked");
        let rows: Vec<ListingRow> = ["locked", "open", "down", "known_locked"]
            .map(|t| row(t, Some("g"), Some("l"), "2026-11-01T00:00:00Z", None))
            .to_vec();
        let found = nda_pending_links(&reqwest::Client::new(), &Api::new(&base, "bearer"), &rows.iter().collect::<Vec<_>>()).await;
        nda_done("known_locked");
        assert_eq!(found, HashSet::from(["locked".to_string(), "known_locked".to_string()]));
        let seen = seen.lock().unwrap();
        assert!(!seen.iter().any(|s| s.path == "/v1/shares/known_locked/meta"));
        assert!(seen.iter().all(|s| s.auth.is_none()), "/meta is the recipient's route and gets no bearer");
    }

    /// A listing that reports `nda_pending` is believed as it stands: no
    /// `/meta` is asked for its rows, and a link the session once marked
    /// reads as open once the listing says its text is set.
    #[tokio::test]
    async fn the_listings_nda_pending_is_read_without_asking_meta() {
        let (base, seen) = mock(|_| (500, String::new())).await;
        nda_still_pending("fixed_since");
        let mut locked = row("locked_l", Some("g"), Some("l"), "2026-11-01T00:00:00Z", None);
        locked.nda_pending = Some(true);
        let mut fixed = row("fixed_since", Some("g"), Some("l"), "2026-11-01T00:00:00Z", None);
        fixed.nda_pending = Some(false);
        let found = nda_pending_links(&reqwest::Client::new(), &Api::new(&base, "bearer"), &[&locked, &fixed]).await;
        nda_done("fixed_since");
        assert_eq!(found, HashSet::from(["locked_l".to_string()]));
        assert!(seen.lock().unwrap().is_empty(), "no /meta for rows the listing already describes");
        let listed: ListingRow = serde_json::from_str(r#"{"share_token":"t","nda_pending":true,"email_gate":false,"nda":true}"#).unwrap();
        assert_eq!(listed.nda_pending, Some(true));
    }

    #[test]
    fn a_person_crosses_ipc_with_nda_pending() {
        let p = person_with("t".into(), Some("Ann".into()), None, "f.pdf");
        assert_eq!(
            serde_json::to_value(RecipientPerson { nda_pending: true, ..p }).unwrap(),
            serde_json::json!({ "shareToken": "t", "name": "Ann", "url": null, "mailto": null, "ndaPending": true })
        );
    }
}
