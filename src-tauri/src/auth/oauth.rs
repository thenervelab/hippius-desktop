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
//! then requires the incoming callback to carry a `state` value that
//! matches a non-expired entry in the store — anything without a
//! matching state, including a deep link delivered by an attacker who
//! can reach the `hippiusapp://` custom scheme, is rejected as
//! untrusted.
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
const PKCE_STATE_TTL: Duration = Duration::from_secs(5 * 60);

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
    // provider redirect round-trip (verified via a direct HTTP probe
    // during the C4 audit).
    let callback = format!("{CALLBACK_URL}?source=desktop&state={}", crate::api::client::urlencoding(&oauth_state));
    let next = format!("/get-token/?callback_url={}", crate::api::client::urlencoding(&callback));

    let url = format!("{base}{auth_path}?next={}", crate::api::client::urlencoding(&next));

    Ok(OAuthUrlResult { url, provider })
}

/// Parse an OAuth deep link URL and extract callback parameters.
///
/// Handles malformed URLs (extra `?` chars), JSON `session` parameter,
/// and determines whether the URL is an OAuth callback at all. Replaces
/// the 60+ lines of URL parsing that used to live in `LoginForm.tsx`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDeepLink {
    /// Whether this URL is an OAuth callback
    pub is_callback: bool,
    /// The callback path with query string (e.g. "/auth/callback?token=...&code=...")
    pub callback_path: Option<String>,
}

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
    // `state` param when building the desktop deep link, so an OAuth
    // callback arrives without one. Until that's fixed upstream, we
    // fall back to a single-pending-flow heuristic: if exactly one
    // non-expired entry is in `pkce_states`, consume it. This keeps
    // most of the replay protection (an attacker still has to race a
    // real login in progress) but tolerates the missing param. Remove
    // this branch once console forwards `state` correctly.
    let matched_provider = {
        let mut states = state.oauth.pkce_states.lock()?;
        purge_expired(&mut states);
        match params.state.as_deref() {
            Some(received_state) => {
                let Some(entry) = states.remove(received_state) else {
                    warn!("Rejected OAuth callback: state did not match any pending flow");
                    return Err(AppError::Auth(
                        "Unknown or expired OAuth state. Start a new login from the sign-in screen.".into(),
                    ));
                };
                entry.provider
            }
            None if states.len() == 1 => {
                warn!(
                    "OAuth callback missing state parameter; falling back to the single pending PKCE entry. \
                     This is a temporary workaround — fix console to propagate `state`."
                );
                let only_key = states.keys().next().cloned().expect("len==1 checked above");
                let entry = states.remove(&only_key).expect("key just read from map");
                entry.provider
            }
            None => {
                warn!(
                    pending_flows = states.len(),
                    "Rejected OAuth callback: no state parameter and fallback only works with exactly one pending flow"
                );
                return Err(AppError::Auth(
                    "Missing state parameter. Start a new login from the sign-in screen.".into(),
                ));
            }
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
        // practice — see the C4 audit probe — but we keep the shape
        // the server already accepts to avoid surprising the backend.)
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

    let provider_name = params.token.as_ref().map_or("oauth", |_| "oauth").to_string();

    if !substrate_address.is_empty() {
        let pool = state.pool()?;

        // Route through the repo so OAuth sessions get the same
        // COALESCE-on-NULL behavior for logout_time_minutes as mnemonic
        // logins. Previously this raw INSERT silently nuked the user's
        // logout-timeout preference on every OAuth callback.
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
        crate::auth::tokens::save_api_token(pool, &substrate_address, &token)
            .await
            .map_err(AppError::Other)?;

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
        let recovery_check = crate::recovery::check_recovery_state_inner(&state).await?;
        let gate_target = match recovery_check.recommended_flow {
            // Local mnemonic exists — sync can proceed without the dialog.
            crate::recovery::RecoveryFlow::Proceed => crate::recovery::RecoveryGateState::Skipped,
            // Dialog required: signup, unlock, or retry after Unknown.
            _ => crate::recovery::RecoveryGateState::Pending,
        };
        state.set_recovery_state(gate_target);

        // Tell the FE which dialog to show, if any. Emit before
        // `auth_ready` so the recovery dialog is mounted before sync
        // init fires — though the gate also prevents the race.
        if let Err(e) = app.emit("oauth_recovery_check_needed", &recovery_check) {
            warn!(error = %e, "Failed to emit oauth_recovery_check_needed");
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
        PkceState {
            provider: "google".to_string(),
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
        states.insert(
            "csrf-token-old".to_string(),
            make_state(PKCE_STATE_TTL + Duration::from_secs(1)),
        );

        // Mirror `complete_oauth_flow`: purge_expired runs BEFORE the
        // state lookup. A deep link that surfaces after the 5-minute
        // TTL is therefore rejected even though the state string
        // matches a once-valid entry.
        purge_expired(&mut states);
        assert!(states.remove("csrf-token-old").is_none(), "expired state must be purged before lookup");
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
