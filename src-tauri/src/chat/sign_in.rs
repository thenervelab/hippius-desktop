//! OIDC sign-in bridge for team chat (MSC3861 / OAuth 2.0 authorization
//! code with PKCE against the homeserver's authentication service).
//!
//! ## Why a loopback redirect, not a `hippius://chat/callback` deep link
//!
//! The authentication service (matrix-authentication-service, "MAS") gates
//! dynamic registration twice, and a `scheme://host/path` custom-scheme
//! redirect fails both:
//!
//! 1. The registration handler runs every redirect URI's host through the
//!    Public Suffix List and refuses a host that *is* a suffix
//!    (`crates/handlers/src/oauth2/registration.rs`, `host_is_public_suffix`,
//!    error "`{host}` is a public suffix, not a valid domain"). `.chat` is a
//!    registered gTLD, so `hippius://chat/callback` has host `chat` and is
//!    rejected before the policy even runs.
//! 2. The default client-registration policy
//!    (`policies/client_registration/client_registration.rego`,
//!    `valid_native_redirector`) accepts, for `application_type: native`,
//!    exactly two shapes: `http://` with host `localhost` / `127.0.0.1` /
//!    `[::1]`, or a custom scheme with **no authority** whose scheme is a
//!    reverse-DNS name strictly under `client_uri`'s host (`com.hippius.x:/…`
//!    for `https://hippius.com/`). `hippius://…` has an authority and is not
//!    reverse-DNS.
//!
//! The RFC 8252 loopback form is the one that needs no OS-level scheme
//! registration, no change to the deep-link plugin, and — as the RFC
//! requires and MAS implements (`LOCAL_HOSTS` in
//! `crates/data-model/src/oauth2/client.rs`) — is matched **ignoring the
//! port**. So sign-in binds an ephemeral port on `127.0.0.1`, registers the
//! port-less [`REGISTERED_REDIRECT_URI`] once per issuer, and passes
//! `http://127.0.0.1:<port>/chat/callback` at authorize time. The browser's
//! redirect lands in this process without going through the OS. The test
//! `registered_redirect_uri_is_a_shape_mas_accepts_for_native_clients` pins
//! the shape against those two rules.
//!
//! ## Why the system browser
//!
//! MAS authenticates through the Hippius API as its upstream identity
//! provider, which in turn bounces an unauthenticated browser to the web
//! console's login page. The API session cookie therefore has to live in
//! whatever runs the authorize chain, and the user's browser is where it
//! already lives (or where they can create it with their usual login). A
//! headless chain inside this process would have to replay the console
//! login, the upstream account-link screen MAS shows on first sign-in, and
//! its consent page — each a form whose shape we do not control. The
//! browser handles all three today for the console; the desktop reuses
//! that. Cost: one browser tab per sign-in (sessions are long-lived and
//! refreshed silently, so this is rare).
//!
//! ## Flow
//!
//! 1. [`chat_begin_sign_in`]: discover the homeserver, fetch auth metadata,
//!    ensure a registered client id (cached per issuer in
//!    `user_preferences`), mint device id + PKCE + CSRF state, bind the
//!    loopback listener, return the authorize URL and a flow id. The
//!    frontend opens the URL in the system browser.
//! 2. The browser comes back to `127.0.0.1:<port>/chat/callback?code&state`.
//!    The listener checks `state`, answers with a "return to Hippius" page,
//!    and hands the code to the waiting flow.
//! 3. [`chat_complete_sign_in`]: waits for the code (bounded), exchanges it
//!    with the PKCE verifier, confirms identity with `/whoami`, persists the
//!    session in the OS keyring ([`super::session`]) and returns it.
//!
//! Refresh ([`chat_refresh_tokens`]) and sign-out ([`chat_sign_out`]) live
//! here too so every token that exists is written by this module and the
//! webview never holds one the keyring does not.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, oneshot};
use tracing::{debug, info, warn};
use zeroize::Zeroizing;

use super::config::{CHAT_CLIENT_NAME, CHAT_CLIENT_URI, CHAT_DISCOVERY_ORIGIN, CHAT_FALLBACK_BASE_URL};
use super::session::{self, ChatSession, ChatStoreLayout};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// Path component of the loopback redirect. Registered port-less.
pub const CALLBACK_PATH: &str = "/chat/callback";
/// The redirect URI as registered with the issuer (no port: RFC 8252 §7.3).
pub const REGISTERED_REDIRECT_URI: &str = "http://127.0.0.1/chat/callback";

/// How long the browser leg may take before the flow is abandoned.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_mins(5);

/// `user_preferences` key prefix for the cached client id, per issuer. The
/// `v1` lets a future registration-shape change invalidate the cache.
const CLIENT_ID_PREF_PREFIX: &str = "chat_oauth_client_v1:";

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Subset of the OAuth 2.0 authorization-server metadata the flow needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub revocation_endpoint: Option<String>,
    #[serde(default)]
    pub account_management_uri: Option<String>,
}

/// Per-process chat state held on [`AppState`].
pub struct ChatState {
    http: reqwest::Client,
    pending: Mutex<HashMap<String, PendingSignIn>>,
    /// Last unread count the webview reported (`chat_set_unread_badge`).
    /// The dock badge and the window title are derived from it in
    /// `notify`; kept here so a second window (the tray popover) can seed
    /// its own mirror from `chat_get_unread_count` instead of waiting for
    /// the next change event.
    pub unread: std::sync::atomic::AtomicU32,
}

impl Default for ChatState {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("chat HTTP client"),
            pending: Mutex::new(HashMap::new()),
            unread: std::sync::atomic::AtomicU32::new(0),
        }
    }
}

/// A sign-in that has handed its authorize URL to the browser and is
/// waiting for the code.
pub struct PendingSignIn {
    pub base_url: String,
    pub metadata: AuthMetadata,
    pub client_id: String,
    pub device_id: String,
    pub redirect_uri: String,
    code_verifier: Zeroizing<String>,
    code_rx: oneshot::Receiver<std::result::Result<String, String>>,
    listener_task: tokio::task::JoinHandle<()>,
}

impl Drop for PendingSignIn {
    fn drop(&mut self) {
        // Abandoning the flow frees the port immediately.
        self.listener_task.abort();
    }
}

/// What [`chat_begin_sign_in`] hands the frontend.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BeginSignIn {
    /// Opaque handle for `chat_complete_sign_in` / `chat_cancel_sign_in`.
    pub flow_id: String,
    /// Open this in the system browser.
    pub authorize_url: String,
}

/// Tokens returned by a refresh; the session in the keyring is updated
/// before these are returned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefreshedTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 32 random bytes, base64url → 43 chars, inside RFC 7636's 43..128 window.
pub fn new_code_verifier() -> Zeroizing<String> {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    Zeroizing::new(b64url(&b))
}

/// `S256` challenge for a verifier.
pub fn code_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

fn new_state() -> String {
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    b64url(&b)
}

/// Same alphabet and length as the console's `generateDeviceId`, so device
/// ids from both clients look alike in the account's session list.
pub fn generate_device_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut b = [0u8; 10];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| ALPHABET[(*x as usize) % ALPHABET.len()] as char).collect()
}

/// Scopes for a Matrix client session bound to one device (MSC2967).
pub fn scopes_for_device(device_id: &str) -> String {
    format!("openid urn:matrix:client:api:* urn:matrix:client:device:{device_id}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Parse the request line of the loopback hit into (path, query params).
/// Only what the callback needs: no header parsing, no bodies.
pub fn parse_callback_request(head: &str) -> Option<(String, HashMap<String, String>)> {
    let line = head.lines().next()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    if method != "GET" {
        return None;
    }
    let url = reqwest::Url::parse("http://127.0.0.1").ok()?.join(target).ok()?;
    let params = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    Some((url.path().to_string(), params))
}

/// Decide what the listener does with one request.
#[derive(Debug, PartialEq, Eq)]
pub enum CallbackDecision {
    /// Not our path: 404, keep listening.
    NotFound,
    /// Our path but `state` missing/mismatched: 400, keep listening. A
    /// rogue local process cannot complete the flow by guessing the port.
    BadState,
    /// The authorization server reported an error: tell the user, finish.
    Denied(String),
    /// Code received: finish.
    Code(String),
}

pub fn decide_callback<S: std::hash::BuildHasher>(path: &str, params: &HashMap<String, String, S>, expected_state: &str) -> CallbackDecision {
    if path != CALLBACK_PATH {
        return CallbackDecision::NotFound;
    }
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return CallbackDecision::BadState;
    }
    if let Some(err) = params.get("error") {
        let desc = params.get("error_description").cloned().unwrap_or_default();
        return CallbackDecision::Denied(if desc.is_empty() { err.clone() } else { format!("{err}: {desc}") });
    }
    match params.get("code") {
        Some(code) if !code.is_empty() => CallbackDecision::Code(code.clone()),
        _ => CallbackDecision::BadState,
    }
}

fn html_response(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

const PAGE_OK: &str = "<!doctype html><html><head><meta charset=utf-8><title>Hippius</title></head><body style=\"font-family:system-ui;margin:3rem\"><h2>Signed in to Hippius chat</h2><p>You can close this tab and return to the app.</p></body></html>";
const PAGE_DENIED: &str = "<!doctype html><html><head><meta charset=utf-8><title>Hippius</title></head><body style=\"font-family:system-ui;margin:3rem\"><h2>Sign-in was not completed</h2><p>Return to the app to try again.</p></body></html>";

// ---------------------------------------------------------------------------
// Loopback listener
// ---------------------------------------------------------------------------

/// Bind `127.0.0.1:0` and serve the callback until a decision terminates
/// the flow or the task is aborted. Returns the bound port and the task.
pub async fn spawn_loopback_listener(
    expected_state: String,
) -> std::io::Result<(u16, oneshot::Receiver<std::result::Result<String, String>>, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let (tx, rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut tx = Some(tx);
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let mut buf = Vec::with_capacity(2048);
            let mut chunk = [0u8; 1024];
            // Read until end of headers or a modest cap; the callback is a
            // short GET and anything larger is not ours.
            let head = loop {
                match tokio::time::timeout(Duration::from_secs(5), socket.read(&mut chunk)).await {
                    Ok(Ok(n)) if n > 0 => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                            break Some(String::from_utf8_lossy(&buf).into_owned());
                        }
                    }
                    // EOF, read error, or a peer that stalls: not a callback.
                    Ok(_) | Err(_) => break None,
                }
            };
            let Some(head) = head else { continue };
            let decision = match parse_callback_request(&head) {
                Some((path, params)) => decide_callback(&path, &params, &expected_state),
                None => CallbackDecision::NotFound,
            };
            let (response, outcome) = match decision {
                CallbackDecision::NotFound => (html_response("404 Not Found", ""), None),
                CallbackDecision::BadState => (html_response("400 Bad Request", PAGE_DENIED), None),
                CallbackDecision::Denied(msg) => (html_response("200 OK", PAGE_DENIED), Some(Err(msg))),
                CallbackDecision::Code(code) => (html_response("200 OK", PAGE_OK), Some(Ok(code))),
            };
            let _ = socket.write_all(&response).await;
            let _ = socket.shutdown().await;
            if let Some(outcome) = outcome {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(outcome);
                }
                break;
            }
        }
    });
    Ok((port, rx, task))
}

// ---------------------------------------------------------------------------
// HTTP legs (no Tauri state; exercised against a mock issuer in tests)
// ---------------------------------------------------------------------------

/// `.well-known/matrix/client` discovery, falling back to the fixed
/// homeserver when the document is missing or malformed.
pub async fn discover_base_url(http: &reqwest::Client, discovery_origin: &str) -> String {
    #[derive(Deserialize)]
    struct WellKnown {
        #[serde(rename = "m.homeserver")]
        homeserver: Homeserver,
    }
    #[derive(Deserialize)]
    struct Homeserver {
        base_url: String,
    }
    let url = format!("{}/.well-known/matrix/client", discovery_origin.trim_end_matches('/'));
    match http.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<WellKnown>().await {
            Ok(wk) if wk.homeserver.base_url.starts_with("https://") || wk.homeserver.base_url.starts_with("http://127.0.0.1") => {
                wk.homeserver.base_url.trim_end_matches('/').to_string()
            }
            Ok(_) | Err(_) => CHAT_FALLBACK_BASE_URL.to_string(),
        },
        _ => {
            debug!("chat: well-known discovery unavailable, using fallback homeserver");
            CHAT_FALLBACK_BASE_URL.to_string()
        }
    }
}

/// MSC2965 auth metadata (stable endpoint first, unstable prefix second).
pub async fn fetch_auth_metadata(http: &reqwest::Client, base_url: &str) -> Result<AuthMetadata> {
    let base = base_url.trim_end_matches('/');
    let candidates = [
        format!("{base}/_matrix/client/v1/auth_metadata"),
        format!("{base}/_matrix/client/unstable/org.matrix.msc2965/auth_metadata"),
    ];
    let mut last_err = String::new();
    for url in candidates {
        match http.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp.json::<AuthMetadata>().await?),
            Ok(resp) => last_err = format!("{url}: HTTP {}", resp.status()),
            Err(e) => last_err = format!("{url}: {e}"),
        }
    }
    Err(AppError::Auth(format!(
        "chat: homeserver does not advertise OIDC auth metadata ({last_err})"
    )))
}

/// RFC 7591 dynamic registration of this app as a public native client.
pub async fn register_client(http: &reqwest::Client, metadata: &AuthMetadata) -> Result<String> {
    let endpoint = metadata
        .registration_endpoint
        .as_deref()
        .ok_or_else(|| AppError::Auth("chat: issuer does not support dynamic client registration".into()))?;
    let body = serde_json::json!({
        "client_name": CHAT_CLIENT_NAME,
        "client_uri": CHAT_CLIENT_URI,
        "application_type": "native",
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "redirect_uris": [REGISTERED_REDIRECT_URI],
    });
    let resp = http.post(endpoint).json(&body).send().await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Auth(format!("chat: client registration failed (HTTP {status}): {text}")));
    }
    #[derive(Deserialize)]
    struct Registered {
        client_id: String,
    }
    let reg: Registered = serde_json::from_str(&text).map_err(|e| AppError::Auth(format!("chat: registration response unreadable: {e}")))?;
    Ok(reg.client_id)
}

/// Build the authorize URL for one flow.
pub fn authorize_url(
    metadata: &AuthMetadata,
    client_id: &str,
    redirect_uri: &str,
    device_id: &str,
    state: &str,
    code_verifier: &str,
) -> Result<String> {
    let mut url =
        reqwest::Url::parse(&metadata.authorization_endpoint).map_err(|e| AppError::Auth(format!("chat: bad authorization endpoint: {e}")))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("response_mode", "query")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &scopes_for_device(device_id))
        .append_pair("state", state)
        .append_pair("code_challenge", &code_challenge(code_verifier))
        .append_pair("code_challenge_method", "S256");
    Ok(url.into())
}

/// Token-endpoint success body (RFC 6749 §5.1), the fields we use.
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct OAuthErrorBody {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Typed token-endpoint failure so callers can react to `invalid_client`
/// (stale cached registration) and `invalid_grant` (dead refresh token).
#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("{error}: {description}")]
    OAuth { error: String, description: String },
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
}

impl From<TokenError> for AppError {
    fn from(e: TokenError) -> Self {
        match e {
            TokenError::Transport(err) => AppError::Http(err),
            other @ TokenError::OAuth { .. } => AppError::Auth(format!("chat: {other}")),
        }
    }
}

async fn token_request(http: &reqwest::Client, endpoint: &str, form: &[(&str, &str)]) -> std::result::Result<TokenResponse, TokenError> {
    let resp = http.post(endpoint).form(form).send().await?;
    if resp.status().is_success() {
        return Ok(resp.json::<TokenResponse>().await?);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<OAuthErrorBody>(&body).unwrap_or(OAuthErrorBody {
        error: String::new(),
        error_description: None,
    });
    Err(TokenError::OAuth {
        error: if parsed.error.is_empty() {
            format!("http_{}", status.as_u16())
        } else {
            parsed.error
        },
        description: parsed.error_description.unwrap_or(body),
    })
}

pub async fn exchange_code(
    http: &reqwest::Client,
    metadata: &AuthMetadata,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
) -> std::result::Result<TokenResponse, TokenError> {
    token_request(
        http,
        &metadata.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
            ("code_verifier", code_verifier),
        ],
    )
    .await
}

pub async fn refresh_grant(
    http: &reqwest::Client,
    token_endpoint: &str,
    client_id: &str,
    refresh_token: &str,
) -> std::result::Result<TokenResponse, TokenError> {
    token_request(
        http,
        token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ],
    )
    .await
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct WhoAmI {
    pub user_id: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

pub async fn whoami(http: &reqwest::Client, base_url: &str, access_token: &str) -> Result<WhoAmI> {
    let url = format!("{}/_matrix/client/v3/account/whoami", base_url.trim_end_matches('/'));
    let resp = http.get(&url).bearer_auth(access_token).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Auth(format!("chat: whoami failed (HTTP {})", resp.status())));
    }
    Ok(resp.json::<WhoAmI>().await?)
}

/// RFC 7009 revocation, best effort: a failure here must not block sign-out.
pub async fn revoke_token(http: &reqwest::Client, revocation_endpoint: &str, client_id: &str, token: &str, hint: &str) {
    let form = [("token", token), ("token_type_hint", hint), ("client_id", client_id)];
    match http.post(revocation_endpoint).form(&form).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => warn!(status = %resp.status(), hint, "chat: token revocation refused"),
        Err(e) => warn!(error = %e, hint, "chat: token revocation failed"),
    }
}

/// Assemble the persisted record from a token response + identity.
pub fn build_session(
    base_url: &str,
    metadata: &AuthMetadata,
    client_id: &str,
    device_id: &str,
    me: WhoAmI,
    tokens: TokenResponse,
) -> Result<ChatSession> {
    if let Some(dev) = me.device_id.as_deref()
        && dev != device_id
    {
        // The device scope we asked for is what the server bound the
        // token to; a mismatch means the token is not for this device
        // and the crypto stores would be keyed wrong.
        return Err(AppError::Auth(format!(
            "chat: server bound the session to device {dev}, expected {device_id}"
        )));
    }
    Ok(ChatSession {
        base_url: base_url.to_string(),
        issuer: metadata.issuer.clone(),
        client_id: client_id.to_string(),
        user_id: me.user_id,
        device_id: device_id.to_string(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_in.map(|s| now_ms() + s * 1000),
        store_layout: ChatStoreLayout::Device,
    })
}

// ---------------------------------------------------------------------------
// Flow core (pool-free; the commands add the client-id cache and keyring)
// ---------------------------------------------------------------------------

/// Everything `begin` needs from its environment, so the flow runs
/// unchanged against a mock issuer in tests.
pub struct BeginParams<'a> {
    pub http: &'a reqwest::Client,
    pub base_url: String,
    pub metadata: AuthMetadata,
    pub client_id: String,
}

/// Bind the listener, mint the per-flow secrets, build the authorize URL.
pub async fn begin(params: BeginParams<'_>) -> Result<(BeginSignIn, PendingSignIn)> {
    let BeginParams {
        base_url,
        metadata,
        client_id,
        ..
    } = params;
    let device_id = generate_device_id();
    let code_verifier = new_code_verifier();
    let state = new_state();
    let (port, code_rx, listener_task) = spawn_loopback_listener(state.clone())
        .await
        .map_err(|e| AppError::Other(format!("chat: cannot bind loopback listener: {e}")))?;
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let url = authorize_url(&metadata, &client_id, &redirect_uri, &device_id, &state, &code_verifier)?;
    let flow_id = new_state();
    info!(port, device_id = %device_id, "chat: sign-in flow started");
    Ok((
        BeginSignIn { flow_id, authorize_url: url },
        PendingSignIn {
            base_url,
            metadata,
            client_id,
            device_id,
            redirect_uri,
            code_verifier,
            code_rx,
            listener_task,
        },
    ))
}

/// Wait for the browser leg, exchange the code, confirm identity.
pub async fn complete(http: &reqwest::Client, pending: PendingSignIn, timeout: Duration) -> Result<ChatSession> {
    // Destructure by hand: `PendingSignIn` has a `Drop` impl, so the
    // receiver is taken out through a mutable borrow.
    let mut pending = pending;
    let rx = std::mem::replace(&mut pending.code_rx, oneshot::channel().1);
    let outcome = tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| AppError::Auth("chat: sign-in timed out waiting for the browser".into()))?
        .map_err(|_| AppError::Auth("chat: sign-in was cancelled".into()))?;
    let code = outcome.map_err(|msg| AppError::Auth(format!("chat: sign-in refused: {msg}")))?;

    let tokens = exchange_code(
        http,
        &pending.metadata,
        &pending.client_id,
        &pending.redirect_uri,
        &code,
        &pending.code_verifier,
    )
    .await?;
    let me = whoami(http, &pending.base_url, &tokens.access_token).await?;
    build_session(&pending.base_url, &pending.metadata, &pending.client_id, &pending.device_id, me, tokens)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn client_id_pref_key(issuer: &str) -> String {
    format!("{CLIENT_ID_PREF_PREFIX}{issuer}")
}

async fn ensure_registered_client(state: &AppState, metadata: &AuthMetadata) -> Result<String> {
    let pool = state.pool()?;
    let key = client_id_pref_key(&metadata.issuer);
    if let Some(cached) = crate::utils::preferences::get_user_preference_internal(pool, &key).await?
        && !cached.is_empty()
    {
        return Ok(cached);
    }
    let client_id = register_client(&state.chat.http, metadata).await?;
    crate::utils::preferences::save_user_preference_internal(pool, &key, &client_id).await?;
    info!(issuer = %metadata.issuer, "chat: registered OAuth client");
    Ok(client_id)
}

async fn forget_registered_client(state: &AppState, issuer: &str) {
    if let Ok(pool) = state.pool() {
        let _ = crate::utils::preferences::save_user_preference_internal(pool, &client_id_pref_key(issuer), "").await;
    }
}

/// Start a sign-in. Returns the URL for the frontend to open in the system
/// browser, plus a flow id for `chat_complete_sign_in`.
#[tauri::command]
pub async fn chat_begin_sign_in(state: tauri::State<'_, AppState>) -> Result<BeginSignIn> {
    // Signed in to Hippius is a precondition: the session is stored per
    // account and the 4S key needs the mnemonic.
    let _account = state.current_account_id()?;
    let http = &state.chat.http;
    let base_url = discover_base_url(http, CHAT_DISCOVERY_ORIGIN).await;
    let metadata = fetch_auth_metadata(http, &base_url).await?;
    let client_id = ensure_registered_client(&state, &metadata).await?;
    let (out, pending) = begin(BeginParams {
        http,
        base_url,
        metadata,
        client_id,
    })
    .await?;
    state.chat.pending.lock().await.insert(out.flow_id.clone(), pending);
    Ok(out)
}

/// Wait for the browser to come back, finish the exchange, persist and
/// return the session. Blocks up to [`CALLBACK_TIMEOUT`].
#[tauri::command]
pub async fn chat_complete_sign_in(state: tauri::State<'_, AppState>, flow_id: String) -> Result<ChatSession> {
    let account_id = state.current_account_id()?;
    let pending = state
        .chat
        .pending
        .lock()
        .await
        .remove(&flow_id)
        .ok_or_else(|| AppError::Auth("chat: unknown or expired sign-in flow".into()))?;
    let issuer = pending.metadata.issuer.clone();
    let session = match complete(&state.chat.http, pending, CALLBACK_TIMEOUT).await {
        Ok(s) => s,
        Err(AppError::Auth(msg)) if msg.contains("invalid_client") => {
            // The cached registration no longer exists on the issuer;
            // drop it so the next attempt re-registers.
            forget_registered_client(&state, &issuer).await;
            return Err(AppError::Auth(
                "chat: this app's registration expired on the server; please try signing in again".into(),
            ));
        }
        Err(e) => return Err(e),
    };
    let to_store = session.clone();
    tokio::task::spawn_blocking(move || session::save_session(&account_id, &to_store))
        .await
        .map_err(|e| AppError::Other(format!("keyring task: {e}")))??;
    info!(user_id = %session.user_id, device_id = %session.device_id, "chat: signed in");
    Ok(session)
}

/// Abandon a flow the user backed out of; frees the loopback port.
#[tauri::command]
pub async fn chat_cancel_sign_in(state: tauri::State<'_, AppState>, flow_id: String) -> Result<()> {
    state.chat.pending.lock().await.remove(&flow_id);
    Ok(())
}

/// Refresh the active account's tokens. Called by the webview's token
/// refresher instead of the token endpoint so the keyring copy is the one
/// that moves; the returned tokens are what was persisted.
#[tauri::command]
pub async fn chat_refresh_tokens(state: tauri::State<'_, AppState>) -> Result<RefreshedTokens> {
    let account_id = state.current_account_id()?;
    let load_id = account_id.clone();
    let Some(mut session) = tokio::task::spawn_blocking(move || session::load_session(&load_id))
        .await
        .map_err(|e| AppError::Other(format!("keyring task: {e}")))??
    else {
        return Err(AppError::Auth("chat: not signed in".into()));
    };
    let refresh_token = session
        .refresh_token
        .clone()
        .ok_or_else(|| AppError::Auth("chat: session has no refresh token; sign in again".into()))?;
    let metadata = fetch_auth_metadata(&state.chat.http, &session.base_url).await?;
    let tokens = match refresh_grant(&state.chat.http, &metadata.token_endpoint, &session.client_id, &refresh_token).await {
        Ok(t) => t,
        Err(TokenError::OAuth { error, description }) if error == "invalid_grant" => {
            // The refresh token is dead (revoked, rotated elsewhere, or
            // expired). The session cannot be recovered; forget it so the
            // UI offers a fresh sign-in instead of looping.
            warn!(%description, "chat: refresh token rejected, clearing session");
            let clear_id = account_id.clone();
            let _ = tokio::task::spawn_blocking(move || session::delete_session(&clear_id)).await;
            return Err(AppError::Auth("chat: session expired; sign in again".into()));
        }
        Err(e) => return Err(e.into()),
    };
    session.access_token = tokens.access_token.clone();
    if tokens.refresh_token.is_some() {
        session.refresh_token = tokens.refresh_token.clone();
    }
    session.expires_at = tokens.expires_in.map(|s| now_ms() + s * 1000);
    let out = RefreshedTokens {
        access_token: session.access_token.clone(),
        refresh_token: session.refresh_token.clone(),
        expires_at: session.expires_at,
    };
    tokio::task::spawn_blocking(move || session::save_session(&account_id, &session))
        .await
        .map_err(|e| AppError::Other(format!("keyring task: {e}")))??;
    Ok(out)
}

/// Revoke the tokens (best effort) and forget the session.
#[tauri::command]
pub async fn chat_sign_out(state: tauri::State<'_, AppState>) -> Result<()> {
    let account_id = state.current_account_id()?;
    let load_id = account_id.clone();
    let session = tokio::task::spawn_blocking(move || session::load_session(&load_id))
        .await
        .map_err(|e| AppError::Other(format!("keyring task: {e}")))?;
    if let Ok(Some(session)) = session
        && let Ok(metadata) = fetch_auth_metadata(&state.chat.http, &session.base_url).await
        && let Some(revoke) = metadata.revocation_endpoint.as_deref()
    {
        if let Some(rt) = session.refresh_token.as_deref() {
            revoke_token(&state.chat.http, revoke, &session.client_id, rt, "refresh_token").await;
        }
        revoke_token(&state.chat.http, revoke, &session.client_id, &session.access_token, "access_token").await;
    }
    tokio::task::spawn_blocking(move || session::delete_session(&account_id))
        .await
        .map_err(|e| AppError::Other(format!("keyring task: {e}")))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_appendix_b() {
        // RFC 7636 Appendix B test vector.
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let v = new_code_verifier();
        assert!(v.len() >= 43 && v.len() <= 128);
    }

    /// The registered redirect URI must satisfy both of MAS's native-client
    /// rules (module docs, "Why a loopback redirect"): an `http` scheme with
    /// a loopback host, no port (RFC 8252 §7.3 — the port is matched
    /// loosely), no fragment, and a host that is not a public suffix. The
    /// per-flow URI differs only by the port. A `hippius://chat/callback`
    /// deep link — the shape one would reach for first — fails: `chat` is a
    /// gTLD and the URI has an authority.
    #[test]
    fn registered_redirect_uri_is_a_shape_mas_accepts_for_native_clients() {
        const MAS_LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]"];
        let registered = reqwest::Url::parse(REGISTERED_REDIRECT_URI).unwrap();
        assert_eq!(registered.scheme(), "http");
        assert!(MAS_LOOPBACK_HOSTS.contains(&registered.host_str().unwrap()));
        assert_eq!(registered.port(), None, "registered port-less; MAS matches loopback ignoring the port");
        assert_eq!(registered.path(), CALLBACK_PATH);
        assert!(registered.fragment().is_none());

        // The per-flow URI `begin` builds is the registered one plus a port.
        let per_flow = reqwest::Url::parse(&format!("http://127.0.0.1:54321{CALLBACK_PATH}")).unwrap();
        let mut stripped = per_flow.clone();
        stripped.set_port(None).unwrap();
        assert_eq!(stripped, registered);

        // And the deep-link shape is NOT loopback: it carries an authority
        // (`chat`) — which is also a public suffix — so MAS refuses it.
        let deep_link = reqwest::Url::parse("hippius://chat/callback").unwrap();
        assert_eq!(deep_link.host_str(), Some("chat"));
        assert!(!MAS_LOOPBACK_HOSTS.contains(&deep_link.host_str().unwrap()));
    }

    #[test]
    fn device_id_matches_console_shape() {
        let id = generate_device_id();
        assert_eq!(id.len(), 10);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(
            scopes_for_device("ABCDEFGHIJ"),
            "openid urn:matrix:client:api:* urn:matrix:client:device:ABCDEFGHIJ"
        );
    }

    fn meta() -> AuthMetadata {
        AuthMetadata {
            issuer: "https://chat.hippius.com/".into(),
            authorization_endpoint: "https://chat.hippius.com/authorize".into(),
            token_endpoint: "https://chat.hippius.com/oauth2/token".into(),
            registration_endpoint: Some("https://chat.hippius.com/oauth2/registration".into()),
            revocation_endpoint: Some("https://chat.hippius.com/oauth2/revoke".into()),
            account_management_uri: Some("https://chat.hippius.com/account/".into()),
        }
    }

    #[test]
    fn authorize_url_carries_loopback_redirect_with_port_and_s256() {
        let url = authorize_url(
            &meta(),
            "CID",
            "http://127.0.0.1:54321/chat/callback",
            "DEV1234567",
            "st",
            "verifier-verifier-verifier-verifier-verifier",
        )
        .unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:54321/chat/callback");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["client_id"], "CID");
        assert!(q["scope"].contains("urn:matrix:client:device:DEV1234567"));
        assert_eq!(q["code_challenge"], code_challenge("verifier-verifier-verifier-verifier-verifier"));
    }

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn callback_decisions() {
        assert_eq!(decide_callback("/favicon.ico", &params(&[]), "s"), CallbackDecision::NotFound);
        assert_eq!(decide_callback(CALLBACK_PATH, &params(&[("code", "c")]), "s"), CallbackDecision::BadState);
        assert_eq!(
            decide_callback(CALLBACK_PATH, &params(&[("code", "c"), ("state", "other")]), "s"),
            CallbackDecision::BadState
        );
        assert_eq!(
            decide_callback(CALLBACK_PATH, &params(&[("state", "s")]), "s"),
            CallbackDecision::BadState
        );
        assert_eq!(
            decide_callback(CALLBACK_PATH, &params(&[("code", "c"), ("state", "s")]), "s"),
            CallbackDecision::Code("c".into())
        );
        assert_eq!(
            decide_callback(
                CALLBACK_PATH,
                &params(&[("error", "access_denied"), ("error_description", "nope"), ("state", "s")]),
                "s"
            ),
            CallbackDecision::Denied("access_denied: nope".into())
        );
    }

    #[test]
    fn request_line_parsing() {
        let (path, q) = parse_callback_request("GET /chat/callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        assert_eq!(path, CALLBACK_PATH);
        assert_eq!(q["code"], "abc");
        assert_eq!(q["state"], "xyz");
        assert!(parse_callback_request("POST /chat/callback HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_callback_request("").is_none());
    }

    #[test]
    fn session_rejects_device_mismatch() {
        let tokens = TokenResponse {
            access_token: "a".into(),
            refresh_token: None,
            expires_in: Some(60),
        };
        let me = WhoAmI {
            user_id: "@u:hippius.com".into(),
            device_id: Some("OTHER".into()),
        };
        assert!(build_session("https://chat.hippius.com", &meta(), "c", "MINE", me, tokens).is_err());
        let tokens = TokenResponse {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_in: Some(60),
        };
        let me = WhoAmI {
            user_id: "@u:hippius.com".into(),
            device_id: Some("MINE".into()),
        };
        let s = build_session("https://chat.hippius.com", &meta(), "c", "MINE", me, tokens).unwrap();
        assert_eq!(s.device_id, "MINE");
        assert!(s.expires_at.unwrap() > now_ms());
        assert_eq!(s.issuer, "https://chat.hippius.com/");
    }

    /// End-to-end against the real loopback listener: the "browser" hits a
    /// wrong path (ignored), a wrong state (refused), then the real
    /// callback, and the flow yields the code.
    #[tokio::test]
    async fn loopback_listener_accepts_only_the_matching_callback() {
        let (port, rx, task) = spawn_loopback_listener("good-state".into()).await.unwrap();
        let http = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{port}");
        assert_eq!(http.get(format!("{base}/favicon.ico")).send().await.unwrap().status(), 404);
        assert_eq!(
            http.get(format!("{base}/chat/callback?code=x&state=bad")).send().await.unwrap().status(),
            400
        );
        let ok = http
            .get(format!("{base}/chat/callback?code=the-code&state=good-state"))
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);
        assert!(ok.text().await.unwrap().contains("return to the app"));
        assert_eq!(rx.await.unwrap(), Ok("the-code".to_string()));
        // The listener exits after the terminal callback and frees the port.
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("listener task ends")
            .unwrap();
    }

    #[tokio::test]
    async fn loopback_listener_reports_denial() {
        let (port, rx, _task) = spawn_loopback_listener("s".into()).await.unwrap();
        let http = reqwest::Client::new();
        http.get(format!("http://127.0.0.1:{port}/chat/callback?error=access_denied&state=s"))
            .send()
            .await
            .unwrap();
        assert_eq!(rx.await.unwrap(), Err("access_denied".to_string()));
    }
}
