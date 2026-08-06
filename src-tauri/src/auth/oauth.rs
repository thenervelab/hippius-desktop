//! OAuth flow commands and state binding.
//!
//! Handles OAuth URL construction, token exchange, and session
//! persistence. The frontend never stores OAuth state in
//! localStorage/sessionStorage.
//!
//! # CSRF / state binding
//!
//! Every call to [`start_oauth_flow`] mints a cryptographically random
//! `state` token (RFC 6749 §10.12) and stores it in
//! [`OAuthState::pkce_states`] keyed by the state value. The token is
//! threaded through the callback URL as a query parameter so the
//! Hippius API server and (for code-grant flows) the upstream OAuth
//! provider pass it back untouched on redirect. [`complete_oauth_flow`]
//! matches an incoming callback that carries a `state` value against a
//! non-expired entry in the store and rejects an unknown/expired one as
//! untrusted.
//!
//! CAVEAT — the deployed reality is weaker than the strict binding:
//! hippius-console does not yet forward `state` on desktop deep links
//! (mobile only), so today every real callback arrives state-less and
//! takes the TEMPORARY fallback in `complete_oauth_flow`: consume the
//! NEWEST pending flow and drain the rest (see `consume_fallback_flow`).
//! The protection that actually holds is therefore "a pending flow must
//! exist" — a cold deep link with no login in progress is still
//! rejected, but a forged state-less callback racing a real login is
//! not distinguishable from the real one. Restoring the strict binding
//! (and deleting the fallback) only needs console to forward `state`
//! for desktop; see `AUDIT_LOGIN_2026-08-06.md` S-3.
//!
//! The server's `/accounts/<provider>/login/` endpoint also sets its
//! own Django `state` cookie for the upstream Google/GitHub leg; ours
//! is a defence-in-depth check on the desktop side and does NOT
//! replace it.
//!
//! Full RFC 7636 PKCE (code_challenge/code_verifier) is not used: the
//! Hippius `/api/auth/exchange/` endpoint does not consume those fields
//! and the upstream provider handshake is brokered by the Hippius
//! server, not the desktop. Adding PKCE end-to-end would require
//! server-side changes. The state binding implemented here closes the
//! specific desktop-side CSRF hole — that a stale deep link could
//! impersonate a session — without needing server cooperation.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Maximum age of a pending OAuth flow. Any `PkceState` older than this
/// is considered expired and discarded on the next lookup. Five minutes
/// is long enough to complete a legitimate browser-based login (user
/// opens browser → signs in → redirected back) while short enough that
/// a dormant entry can't be weaponized hours after the user abandoned
/// their login attempt.
const PKCE_STATE_TTL: Duration = Duration::from_mins(5);

/// In-flight OAuth flow states, keyed by the random `state` CSRF token.
///
/// Keying by state (not by provider) lets multiple overlapping flows
/// coexist — e.g. the user clicks "Sign in with Google" twice in a
/// row, or the first attempt is abandoned and a second is started.
/// Each flow's callback can still be matched to the correct entry
/// because the random token is unique per `start_oauth_flow` call.
pub struct OAuthState {
    pub pkce_states: Mutex<HashMap<String, PkceState>>,
}

impl Default for OAuthState {
    fn default() -> Self {
        Self::new()
    }
}

impl OAuthState {
    pub fn new() -> Self {
        Self {
            pkce_states: Mutex::new(HashMap::new()),
        }
    }
}

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

/// Transient state for an in-flight OAuth authorization.
///
/// Stored in `OAuthState::pkce_states` under the random CSRF `state`
/// token that was minted by `start_oauth_flow` and embedded in the
/// OAuth callback URL. `created_at` drives TTL expiry (see
/// [`PKCE_STATE_TTL`]) so a deep link that surfaces long after the
/// user abandoned the login attempt is rejected as untrusted.
pub struct PkceState {
    /// Upstream OAuth provider (`"google" | "github" | "apple"`). Used
    /// as the `code_verifier` placeholder the Hippius server currently
    /// expects on `/api/auth/exchange/`.
    provider: String,
    created_at: Instant,
}

/// Drop any `PkceState` entries older than [`PKCE_STATE_TTL`] and
/// return how many remain. Called before reading the map in
/// `complete_oauth_flow` so the pending-flow check can't be satisfied
/// by an ancient entry.
fn purge_expired(states: &mut HashMap<String, PkceState>) -> usize {
    let before = states.len();
    states.retain(|_, s| s.created_at.elapsed() < PKCE_STATE_TTL);
    let purged = before - states.len();
    if purged > 0 {
        debug!(purged, "Expired OAuth PKCE state entries");
    }
    states.len()
}

/// Consume the pending flow for a callback that arrived WITHOUT a `state`
/// parameter (the console does not yet forward it for desktop): the newest
/// entry wins and the whole map is drained.
///
/// Newest-wins because a state-less callback carries nothing to
/// disambiguate on, and the newest entry is the flow whose browser tab the
/// user most recently opened. The old rule — accept only when EXACTLY one
/// flow was pending — rejected every callback for the full 5-minute TTL
/// whenever the user double-started a login (the sign-in button re-enables
/// on window refocus, so "click → switch to browser → come back → click
/// again" was routine), the top intermittent OAuth failure (audit H-2).
///
/// Draining the remainder (not just the winner) preserves the fallback's
/// replay value: with no `state` nothing can legitimately complete the
/// older entries, and leaving them pending would let a later forged
/// state-less deep link satisfy the pending-flow check without the user
/// having started a new login. Returns `None` when nothing is pending.
fn consume_fallback_flow(states: &mut HashMap<String, PkceState>) -> Option<PkceState> {
    let newest_key = states.iter().max_by_key(|(_, s)| s.created_at).map(|(k, _)| k.clone())?;
    let entry = states.remove(&newest_key);
    states.clear();
    entry
}

const API_BASE_URL: &str = "https://api.hippius.com";
const CALLBACK_URL: &str = "https://console.hippius.com/auth/callback";

fn api_base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| API_BASE_URL.to_string())
}

/// The authorization URL and provider name returned to the frontend
/// so it can open the browser to the correct OAuth endpoint.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthUrlResult {
    pub url: String,
    pub provider: String,
}

/// Parameters received from the OAuth callback deep-link.
///
/// Either `token` (direct grant) or `code` (authorization code) will be
/// present, but never both. Error fields are populated when the provider
/// rejects the request.
///
/// `state` is the CSRF token that was minted in [`start_oauth_flow`]
/// and embedded in the callback URL. `complete_oauth_flow` requires
/// this field to match a non-expired entry in
/// [`OAuthState::pkce_states`] before accepting the rest of the
/// payload — this closes the cold-deep-link attack where a malicious
/// `hippiusapp://auth/callback?token=…` could impersonate a session.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackParams {
    pub token: Option<String>,
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
    pub user_id: Option<i64>,
    pub username: Option<String>,
    pub email: Option<String>,
    pub substrate_address: Option<String>,
}

/// Authenticated session data returned to the frontend after a
/// successful OAuth flow, also persisted in the local SQLite DB.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSessionResult {
    pub token: String,
    pub user_id: i64,
    pub username: String,
    pub email: String,
    pub substrate_address: String,
    pub provider: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
struct ExchangeResponse {
    token: String,
    user: ExchangeUser,
}

#[derive(Deserialize)]
struct ExchangeUser {
    id: i64,
    username: String,
    email: String,
    substrate_address: Option<String>,
}

/// Build the OAuth authorization URL for the given provider and return it.
/// The frontend opens this URL in the external browser.
///
/// Mints a random `state` token, stashes a [`PkceState`] keyed by that
/// token in [`OAuthState::pkce_states`], and embeds the token in the
/// callback URL as `&state=<state>`. The Hippius API server preserves
/// the `callback_url` query string byte-for-byte through the
/// OAuth-provider redirect dance, so the `state` comes back in the
/// final `hippiusapp://auth/callback?state=…&token=…` deep link and
/// [`complete_oauth_flow`] can bind the callback to this specific
/// in-progress flow.
#[tauri::command]
pub async fn start_oauth_flow(state: tauri::State<'_, crate::app_state::AppState>, provider: String) -> Result<OAuthUrlResult, AppError> {
    info!(provider = %provider, "OAuth flow started");
    let base = api_base_url();

    let auth_path = match provider.as_str() {
        "google" => "/accounts/google/login/",
        "github" => "/accounts/github/login/",
        "apple" => "/accounts/apple/login/",
        _ => return Err(AppError::Validation(format!("Unsupported OAuth provider: {provider}"))),
    };

    // Cryptographically random CSRF token. UUID v4 gives us 122 bits
    // of entropy from `OsRng` — more than enough for a 5-minute TTL
    // and a map that is purged on every access.
    let oauth_state = uuid::Uuid::new_v4().to_string();
    {
        let mut states = state.oauth.pkce_states.lock()?;
        // Drop any stale entries from a previous abandoned attempt
        // before inserting. Keeps the map bounded and removes stale
        // flows that would otherwise satisfy the pending-flow check
        // in `complete_oauth_flow`.
        purge_expired(&mut states);
        states.insert(
            oauth_state.clone(),
            PkceState {
                provider: provider.clone(),
                created_at: Instant::now(),
            },
        );
    }

    // Include the `state` CSRF token in the deep-link callback so we
    // can match the returned deep link to this in-progress flow. The
    // Hippius `/get-token/` endpoint passes `callback_url` through
    // untouched, so anything we append here survives the OAuth
    // provider redirect round-trip.
    let callback = format!("{CALLBACK_URL}?source=desktop&state={}", crate::api::client::urlencoding(&oauth_state));
    let next = format!("/get-token/?callback_url={}", crate::api::client::urlencoding(&callback));

    let url = format!("{base}{auth_path}?next={}", crate::api::client::urlencoding(&next));

    Ok(OAuthUrlResult { url, provider })
}

/// Parse an OAuth deep link URL and extract callback parameters.
///
/// Handles malformed URLs (extra `?` chars), JSON `session` parameter,
/// and determines whether the URL is an OAuth callback at all. Keeping the
/// URL parsing in Rust avoids duplicating it in the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDeepLink {
    /// Whether this URL is an OAuth callback
    pub is_callback: bool,
    /// The callback path with query string (e.g. "/auth/callback?token=...&code=...")
    pub callback_path: Option<String>,
    /// Opaque dedup key (hex SHA-256 of the raw URL), `Some` only for
    /// callbacks. The FE persists THIS — never the raw URL — to remember
    /// which callback it already routed: direct-grant callbacks carry the
    /// bearer token in the query string, and persisting the raw URL kept
    /// that token in localStorage indefinitely (RFC 6750 §2.3, audit S-1).
    pub dedup_key: Option<String>,
}

/// Hex SHA-256 of the raw deep-link URL — see [`ParsedDeepLink::dedup_key`].
fn deep_link_dedup_key(url: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    hex::encode(hasher.finalize())
}

/// The loggable part of a deep link: everything before the query/fragment.
///
/// Direct-grant OAuth callbacks carry the bearer token in the query
/// string; logging the full URL wrote that token to the on-disk log
/// (RFC 6750 §2.3, audit S-1) — support-bundle scrubbing redacts at
/// upload time, but the raw log file lingered. Callers that log an
/// inbound deep link must log only this part.
pub fn deep_link_public_part(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url)
}

/// Parse an inbound `hippiusapp://` deep-link URL into a structured
/// `ParsedDeepLink`, extracting OAuth callback parameters.
///
/// Operates on **untrusted external input** — the URL is handed in by the OS
/// deep-link handler — so it is defensive. A malformed URL carrying more than
/// one `?` (a known server quirk) is repaired by treating only the first `?`
/// as the query separator and every later one as `&`. A URL whose path is not
/// `/auth/callback` is not an error: it returns `is_callback: false`. The
/// `state` query parameter is preserved verbatim because it is the CSRF token
/// that `complete_oauth_flow` later matches against the pending flow.
///
/// # Errors
///
/// Returns `AppError::Other` if the (repaired) URL fails to parse as a URL.
#[tauri::command]
pub fn parse_oauth_deep_link(url: String) -> Result<ParsedDeepLink, AppError> {
    // Fix malformed URLs with multiple `?` characters (server workaround)
    let fixed_url = if url.matches('?').count() > 1 {
        let mut first = true;
        url.chars()
            .map(|c| {
                if c == '?' {
                    if first {
                        first = false;
                        '?'
                    } else {
                        '&'
                    }
                } else {
                    c
                }
            })
            .collect::<String>()
    } else {
        url.clone()
    };

    let url_obj = reqwest::Url::parse(&fixed_url).map_err(|e| AppError::Other(format!("Invalid deep link URL: {e}")))?;

    // Check if this is an OAuth callback
    if !url_obj.path().contains("/auth/callback") {
        return Ok(ParsedDeepLink {
            is_callback: false,
            callback_path: None,
            dedup_key: None,
        });
    }

    let params: std::collections::HashMap<String, String> = url_obj.query_pairs().into_owned().collect();

    // Extract standard parameters. `state` is the CSRF token minted by
    // `start_oauth_flow` — it must be preserved here so the downstream
    // `complete_oauth_flow` call can match it against a pending flow.
    let mut out = std::collections::HashMap::new();
    for key in &[
        "token",
        "code",
        "state",
        "username",
        "email",
        "user_id",
        "substrate_address",
        "error",
        "error_description",
    ] {
        if let Some(val) = params.get(*key) {
            out.insert(key.to_string(), val.clone());
        }
    }

    // Handle JSON `session` parameter (fallback source for code, username, user_id)
    if let Some(session_str) = params.get("session")
        && let Ok(session_data) = serde_json::from_str::<serde_json::Value>(session_str)
    {
        if !out.contains_key("code")
            && let Some(c) = session_data.get("code").and_then(|v| v.as_str())
        {
            out.insert("code".to_string(), c.to_string());
        }
        if !out.contains_key("username")
            && let Some(u) = session_data.get("username").and_then(|v| v.as_str())
        {
            out.insert("username".to_string(), u.to_string());
        }
        if !out.contains_key("user_id")
            && let Some(id) = session_data.get("id")
        {
            out.insert("user_id".to_string(), id.to_string().trim_matches('"').to_string());
        }
    }

    // Build callback path with proper URL encoding via reqwest::Url
    let mut builder = reqwest::Url::parse("http://localhost/auth/callback").map_err(|e| AppError::Other(format!("URL build error: {e}")))?;
    for (k, v) in &out {
        builder.query_pairs_mut().append_pair(k, v);
    }
    let callback_params = builder.query().unwrap_or("").to_string();

    Ok(ParsedDeepLink {
        is_callback: true,
        callback_path: Some(format!("/auth/callback?{callback_params}")),
        // Keyed on the URL as delivered (pre-fixup) — that's the exact
        // string the OS would redeliver, so it's what dedup must match.
        dedup_key: Some(deep_link_dedup_key(&url)),
    })
}

/// - If `code` is present, exchange it for a token.
/// - Store the resulting session in the DB.
/// Returns the session data for the frontend to update React state.
#[tauri::command]
#[expect(clippy::too_many_lines, reason = "OAuth protocol flow; splitting loses coherence")]
pub async fn complete_oauth_flow(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    params: OAuthCallbackParams,
) -> Result<OAuthSessionResult, AppError> {
    if let Some(ref err) = params.error {
        let desc = params.error_description.as_deref().unwrap_or("");
        error!("OAuth error from provider: {err} {desc}");
        return Err(AppError::Auth("Authentication failed".into()));
    }

    // CSRF binding: every incoming callback MUST carry a `state`
    // parameter that matches a non-expired entry in `pkce_states`. The
    // matching entry is consumed on first use so a replayed deep link
    // can't re-authenticate the same session. Without this, any call
    // with `hippiusapp://auth/callback?token=…&substrate_address=…`
    // would be accepted as a valid session by the app — and the
    // `hippiusapp://` custom scheme is OS-wide, so any program or
    // compromised browser tab could deliver one.
    // TEMPORARY — console bridge (`hippius-console`) currently drops the
    // `state` param when building the desktop deep link (its callback
    // page forwards it for mobile only), so an OAuth callback arrives
    // without one. Until that's fixed upstream, a state-less callback
    // consumes the NEWEST pending flow and drains the rest (see
    // `consume_fallback_flow` for why newest-wins and why draining
    // preserves the replay protection). An attacker still has to race a
    // real login in progress. Remove this branch once console forwards
    // `state` for desktop.
    let matched_provider = {
        let mut states = state.oauth.pkce_states.lock()?;
        purge_expired(&mut states);
        if let Some(received_state) = params.state.as_deref() {
            let Some(entry) = states.remove(received_state) else {
                warn!("Rejected OAuth callback: state did not match any pending flow");
                return Err(AppError::Auth(
                    "Unknown or expired OAuth state. Start a new login from the sign-in screen.".into(),
                ));
            };
            entry.provider
        } else {
            let Some(entry) = consume_fallback_flow(&mut states) else {
                warn!("Rejected OAuth callback: no state parameter and no pending flow to bind it to");
                return Err(AppError::Auth(
                    "Missing state parameter. Start a new login from the sign-in screen.".into(),
                ));
            };
            warn!(
                "OAuth callback missing state parameter; consuming the newest pending flow. \
                 This is a temporary workaround — fix console to propagate `state` for desktop \
                 (its callback page already does so for mobile)."
            );
            entry.provider
        }
    };

    let (token, user_id, username, email, substrate_address) = if let Some(ref t) = params.token {
        (
            t.clone(),
            params.user_id.unwrap_or(0),
            params.username.clone().unwrap_or_default(),
            params.email.clone().unwrap_or_default(),
            params.substrate_address.clone().unwrap_or_default(),
        )
    } else if let Some(ref code) = params.code {
        // The matched provider from the state lookup becomes the
        // `code_verifier` placeholder the Hippius server currently
        // expects on `/api/auth/exchange/`. (It ignores the value in
        // practice, but we keep the shape the server already accepts to
        // avoid surprising the backend.)
        let base = api_base_url();
        let resp = state
            .api_client
            .post(format!("{base}/api/auth/exchange/"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&serde_json::json!({
                "code": code,
                "code_verifier": matched_provider,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Api { status, body });
        }

        let data: ExchangeResponse = resp.json().await?;

        // The pending `PkceState` entry was already consumed by the
        // state-lookup block above — there is nothing to clean up
        // here. `matched_provider` owns the last reference to the
        // provider string and drops at the end of this scope.

        (
            data.token,
            data.user.id,
            data.user.username,
            data.user.email,
            data.user.substrate_address.unwrap_or_default(),
        )
    } else {
        return Err(AppError::Validation("Missing both token and authorization code".into()));
    };

    let expires_at = {
        let now = chrono::Utc::now();
        let expiry = now + chrono::Duration::days(30);
        expiry.to_rfc3339()
    };
    let token_expiry_ms = chrono::Utc::now().timestamp_millis() + 30 * 24 * 60 * 60 * 1000;

    // Both OAuth grant paths persist the same provider tag. If per-provider
    // tagging is ever needed, derive it from the matched PkceState.provider
    // instead.
    let provider_name = "oauth".to_string();

    if !substrate_address.is_empty() {
        let pool = state.pool()?;

        // Route through the repo so OAuth sessions get the same
        // COALESCE-on-NULL behavior for logout_time_minutes as mnemonic
        // logins, preserving the user's logout-timeout preference across
        // OAuth callbacks.
        crate::auth::auth_session_repo::upsert(
            pool,
            crate::auth::auth_session_repo::UpsertSession {
                substrate_address: &substrate_address,
                token: &token,
                token_expiry_ms,
                user_id: Some(user_id),
                username: &username,
                provider: &provider_name,
                logout_time_minutes: None, // preserve existing preference
            },
        )
        .await?;

        // Persist the API token via the existing helper so there's one
        // writer for `objectstore_auth_scoped` (shared with the mnemonic
        // login flow).
        crate::auth::tokens::save_api_token(pool, &substrate_address, &token).await?;

        // Populate AuthInfo so OAuth users participate in the same
        // get_mnemonic_for_account cache path as mnemonic-login users.
        // OAuth has no eth_address or sr25519_pair — those derive from a
        // BIP-39 mnemonic which is generated later by ensure_sync_mnemonic.
        state.set_active_account(&substrate_address, crate::auth::state::AuthCapabilities::OAuthOnly)?;

        // Ensure the one-time welcome notification exists for this
        // user. OAuth doesn't surface an `is_new` flag, so we rely on
        // the user-scoped dedup inside `ensure_welcome_notification`
        // to make repeat OAuth logins a no-op.
        if let Err(e) = crate::notifications::crud::ensure_welcome_notification(pool, &substrate_address).await {
            warn!(error = %e, "Failed to ensure welcome notification — will retry on next login");
        }

        // Probe recovery state before any sync init can race in.
        //
        // The recovery gate starts `Skipped` by default (so non-OAuth
        // login paths never block). We need to flip it to `Pending`
        // whenever the dialog is required so `ensure_sync_mnemonic`
        // parks until the user has entered their recovery password or
        // completed the signup wizard. The decision is based on the
        // `RecoveryCheck` we get from probing the server for a sealed
        // blob and checking local mnemonic presence.
        //
        // Bounded + best-effort (audit H-1): this probe hits hcfs-server
        // AFTER the session was persisted above, and the old unbounded
        // fatal `?` failed — or hung — the entire login at its last step
        // even though authentication had already succeeded (the user saw
        // "Authentication failed", then found themselves logged in on
        // the next launch). Timeout and error both collapse to `None`,
        // which parks the gate `Pending` — never `Skipped` — because an
        // unknown recovery state must not let `ensure_sync_mnemonic`
        // mint a fresh mnemonic that collides with a server blob. The
        // FE callback page runs its own `checkRecoveryState`, and
        // `restore_session` re-probes on the next launch.
        let recovery_check = crate::auth::session_restore::probe_recovery_state_bounded(crate::recovery::check_recovery_state_inner(&state)).await;
        state.set_recovery_state(crate::auth::session_restore::recovery_gate_target(recovery_check.as_ref()));

        // Tell the FE which dialog to show, if any. Emit before
        // `auth_ready` so the recovery dialog is mounted before sync
        // init fires — though the gate also prevents the race.
        if let Some(ref recovery_check) = recovery_check {
            if let Err(e) = app.emit("oauth_recovery_check_needed", recovery_check) {
                warn!(error = %e, "Failed to emit oauth_recovery_check_needed");
            }
        } else {
            warn!("complete_oauth_flow: recovery probe unavailable; gate parked Pending (dialog re-fires on next launch)");
        }

        // Signal the FE that auth is ready so `tryAutoInitSync` can
        // retry its auto-init ladder. Without this, OAuth users with
        // existing sync drives hit the full 10s listener timeout on
        // every login before giving up — the mnemonic-race fix in
        // `useHcfsSync.ts` listens on `hippius_auth_ready`, which the
        // mnemonic-login and session-restore paths already emit.
        state.sync_bridge.emit_auth_ready();
    }

    info!(
        provider = %provider_name,
        address = %substrate_address,
        "OAuth flow completed"
    );

    Ok(OAuthSessionResult {
        token,
        user_id,
        username,
        email,
        substrate_address,
        provider: provider_name,
        expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_state(age: Duration) -> PkceState {
        make_state_with("google", age)
    }

    fn make_state_with(provider: &str, age: Duration) -> PkceState {
        PkceState {
            provider: provider.to_string(),
            // `checked_sub` guards against Instant wraparound on exotic
            // clocks; in practice `age` is always small and this can't
            // fail, but clippy prefers the explicit form.
            created_at: Instant::now().checked_sub(age).expect("test age fits in Instant range"),
        }
    }

    #[test]
    fn purge_expired_removes_stale_entries() {
        let mut states = HashMap::new();
        states.insert("a".to_string(), make_state(Duration::from_secs(1)));
        states.insert("b".to_string(), make_state(PKCE_STATE_TTL + Duration::from_secs(1)));
        states.insert("c".to_string(), make_state(Duration::from_secs(10)));

        let remaining = purge_expired(&mut states);
        assert_eq!(remaining, 2, "one entry older than TTL should be dropped");
        assert!(states.contains_key("a"));
        assert!(!states.contains_key("b"));
        assert!(states.contains_key("c"));
    }

    #[test]
    fn purge_expired_keeps_everything_fresh() {
        let mut states = HashMap::new();
        states.insert("x".to_string(), make_state(Duration::from_secs(0)));
        states.insert("y".to_string(), make_state(Duration::from_secs(30)));
        let remaining = purge_expired(&mut states);
        assert_eq!(remaining, 2);
    }

    #[test]
    fn purge_expired_reports_zero_on_empty_map() {
        let mut states: HashMap<String, PkceState> = HashMap::new();
        assert_eq!(purge_expired(&mut states), 0);
    }

    #[test]
    fn purge_expired_clears_all_when_all_stale() {
        let mut states = HashMap::new();
        let very_old = PKCE_STATE_TTL * 2;
        states.insert("a".to_string(), make_state(very_old));
        states.insert("b".to_string(), make_state(very_old));
        assert_eq!(purge_expired(&mut states), 0);
        assert!(states.is_empty());
    }

    // ─── State-binding semantics ───────────────────────────────────
    //
    // These tests pin the invariants that protect the desktop from
    // a cold-deep-link CSRF. They don't spin up a Tauri runtime —
    // they exercise `pkce_states` directly the same way
    // `complete_oauth_flow` does.

    #[test]
    fn state_lookup_removes_entry_on_first_match() {
        let mut states = HashMap::new();
        states.insert("csrf-token-1".to_string(), make_state(Duration::from_secs(1)));

        // First match succeeds and removes the entry (mirrors the
        // `complete_oauth_flow` path: `states.remove(received_state)`).
        let entry = states.remove("csrf-token-1");
        assert!(entry.is_some(), "first lookup should succeed");
        assert_eq!(entry.unwrap().provider, "google");

        // Second lookup fails: a replayed deep link with the same
        // state cannot re-authenticate the session.
        assert!(states.remove("csrf-token-1").is_none(), "replay must fail");
    }

    #[test]
    fn state_lookup_fails_for_unknown_state() {
        let mut states = HashMap::new();
        states.insert("csrf-token-legit".to_string(), make_state(Duration::from_secs(1)));

        // An attacker delivers `hippiusapp://auth/callback?state=attacker-forged&...`
        // while a legitimate flow is in progress. The lookup must
        // miss — any forged state that doesn't collide with a minted
        // UUID v4 (2^122 entropy) is rejected.
        assert!(states.remove("attacker-forged").is_none());
        // And the legit entry is untouched so the real user can
        // still complete their flow.
        assert!(states.contains_key("csrf-token-legit"));
    }

    #[test]
    fn state_lookup_fails_after_ttl_purge() {
        let mut states = HashMap::new();
        states.insert("csrf-token-old".to_string(), make_state(PKCE_STATE_TTL + Duration::from_secs(1)));

        // Mirror `complete_oauth_flow`: purge_expired runs BEFORE the
        // state lookup. A deep link that surfaces after the 5-minute
        // TTL is therefore rejected even though the state string
        // matches a once-valid entry.
        purge_expired(&mut states);
        assert!(states.remove("csrf-token-old").is_none(), "expired state must be purged before lookup");
    }

    // ─── State-less fallback selection (audit H-2) ─────────────────
    //
    // The console does not yet forward `state` for desktop, so every
    // real callback takes the fallback path. These pin the tolerant
    // newest-wins rule that replaced the "exactly one pending" rule —
    // the old rule rejected every callback for the 5-minute TTL after
    // a routine double-started login.

    /// The regression case: TWO pending flows (double-started login)
    /// must resolve to the newest one, not reject the callback.
    #[test]
    fn fallback_consumes_newest_of_multiple_flows_and_drains_map() {
        let mut states = HashMap::new();
        states.insert("flow-old".to_string(), make_state_with("google", Duration::from_mins(1)));
        states.insert("flow-new".to_string(), make_state_with("github", Duration::from_secs(1)));

        let entry = consume_fallback_flow(&mut states).expect("a pending flow must be consumed");
        assert_eq!(entry.provider, "github", "the newest flow must win");
        assert!(
            states.is_empty(),
            "remaining state-less flows must be drained — nothing can legitimately complete them, \
             and leaving them pending would let a later forged deep link satisfy the check"
        );
    }

    /// The single-flow case behaves exactly like the old rule.
    #[test]
    fn fallback_consumes_single_flow() {
        let mut states = HashMap::new();
        states.insert("only".to_string(), make_state(Duration::from_secs(1)));
        let entry = consume_fallback_flow(&mut states).expect("single pending flow must be consumed");
        assert_eq!(entry.provider, "google");
        assert!(states.is_empty());
    }

    /// No pending flow at all → the callback stays rejected (the cold
    /// deep-link CSRF protection is unchanged).
    #[test]
    fn fallback_rejects_when_nothing_pending() {
        let mut states: HashMap<String, PkceState> = HashMap::new();
        assert!(consume_fallback_flow(&mut states).is_none());
    }

    // ─── Deep-link hygiene (audit S-1) ─────────────────────────────

    /// The loggable part must never include the query or fragment —
    /// that's where a direct-grant callback carries the bearer token.
    #[test]
    fn deep_link_public_part_strips_query_and_fragment() {
        assert_eq!(
            deep_link_public_part("hippiusapp://auth/callback?token=SECRET&state=x"),
            "hippiusapp://auth/callback"
        );
        assert_eq!(
            deep_link_public_part("hippiusapp://auth/callback#token=SECRET"),
            "hippiusapp://auth/callback"
        );
        assert_eq!(deep_link_public_part("hippiusapp://auth/callback"), "hippiusapp://auth/callback");
    }

    /// Callbacks get a stable, token-free dedup key; the same URL keys
    /// identically (so an OS redelivery is recognized) and different
    /// URLs key differently (so a retry with a fresh code is not
    /// swallowed as a duplicate).
    #[test]
    fn parse_deep_link_returns_stable_token_free_dedup_key() {
        // Triple-slash form: the exact shape hippius-console emits
        // (`hippiusapp:///auth/callback?...`), which parses with an empty
        // host and path `/auth/callback`.
        let url = "hippiusapp:///auth/callback?token=SECRET&state=x".to_string();
        let a = parse_oauth_deep_link(url.clone()).expect("parses");
        let b = parse_oauth_deep_link(url).expect("parses");
        assert!(a.is_callback);

        let key_a = a.dedup_key.expect("callback must carry a dedup key");
        let key_b = b.dedup_key.expect("callback must carry a dedup key");
        assert_eq!(key_a, key_b, "same URL must dedup to the same key");
        assert_eq!(key_a.len(), 64, "hex SHA-256");
        assert!(!key_a.contains("SECRET"), "dedup key must not embed the token");

        let other = parse_oauth_deep_link("hippiusapp:///auth/callback?token=OTHER&state=y".to_string()).expect("parses");
        assert_ne!(Some(key_a), other.dedup_key, "a different callback must not be treated as a duplicate");
    }

    /// Non-callback deep links carry no dedup key — there is nothing to
    /// dedup and the FE must not store anything for them.
    #[test]
    fn parse_deep_link_non_callback_has_no_dedup_key() {
        let parsed = parse_oauth_deep_link("hippiusapp://some/other/route".to_string()).expect("parses");
        assert!(!parsed.is_callback);
        assert!(parsed.dedup_key.is_none());
    }

    #[test]
    fn multiple_concurrent_flows_do_not_interfere() {
        // Two overlapping flows for the SAME provider are legal —
        // e.g. user clicks "Sign in with Google" twice. State-keyed
        // storage keeps both alive and lets each complete
        // independently.
        let mut states = HashMap::new();
        states.insert("flow-1".to_string(), make_state(Duration::from_secs(1)));
        states.insert("flow-2".to_string(), make_state(Duration::from_secs(1)));

        assert_eq!(states.len(), 2);

        // Completing flow-1 must not affect flow-2.
        let completed = states.remove("flow-1");
        assert!(completed.is_some());
        assert!(states.contains_key("flow-2"));
    }
}
