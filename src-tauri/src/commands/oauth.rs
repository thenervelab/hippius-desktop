//! OAuth flow commands.
//!
//! Handles OAuth URL construction, PKCE state, token exchange,
//! and session persistence. The frontend never stores OAuth state
//! in localStorage/sessionStorage.

use crate::utils::account_key::account_key;
use serde::{Deserialize, Serialize};
use tracing::{error, info};

/// Transient PKCE state for an in-flight OAuth authorization.
///
/// Keyed by provider name in `OAuthState.pkce_states` to prevent
/// cross-provider confusion when multiple flows overlap.
pub struct PkceState {
    provider: String,
    #[allow(dead_code)] // stored for future nonce validation in complete_oauth_flow
    nonce: String,
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackParams {
    pub token: Option<String>,
    pub code: Option<String>,
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
#[tauri::command]
pub async fn start_oauth_flow(
    state: tauri::State<'_, crate::app_state::AppState>,
    provider: String,
) -> Result<OAuthUrlResult, String> {
    info!(provider = %provider, "OAuth flow started");
    let base = api_base_url();

    let auth_path = match provider.as_str() {
        "google" => "/accounts/google/login/",
        "github" => "/accounts/github/login/",
        "apple" => "/accounts/apple/login/",
        _ => return Err(format!("Unsupported OAuth provider: {provider}")),
    };

    let nonce = uuid::Uuid::new_v4().to_string();
    {
        let mut states = state
            .oauth
            .pkce_states
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        states.insert(
            provider.clone(),
            PkceState {
                provider: provider.clone(),
                nonce: nonce.clone(),
            },
        );
    }

    let callback = format!("{CALLBACK_URL}?source=desktop");
    let next = format!(
        "/get-token/?callback_url={}",
        crate::api_client::urlencoding_pub(&callback)
    );

    let url = format!(
        "{base}{auth_path}?next={}",
        crate::api_client::urlencoding_pub(&next)
    );

    Ok(OAuthUrlResult { url, provider })
}

/// Process the OAuth callback parameters:
/// - If `token` is present, use it directly.
/// - If `code` is present, exchange it for a token.
/// - Store the resulting session in the DB.
/// Returns the session data for the frontend to update React state.
#[tauri::command]
pub async fn complete_oauth_flow(
    state: tauri::State<'_, crate::app_state::AppState>,
    params: OAuthCallbackParams,
) -> Result<OAuthSessionResult, String> {
    if let Some(ref err) = params.error {
        let desc = params.error_description.as_deref().unwrap_or("");
        error!("OAuth error from provider: {err} {desc}");
        return Err("Authentication failed".to_string());
    }

    let (token, user_id, username, email, substrate_address) = if let Some(ref t) = params.token {
        {
            let mut states = state
                .oauth
                .pkce_states
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            states.clear();
        }
        (
            t.clone(),
            params.user_id.unwrap_or(0),
            params.username.clone().unwrap_or_default(),
            params.email.clone().unwrap_or_default(),
            params.substrate_address.clone().unwrap_or_default(),
        )
    } else if let Some(ref code) = params.code {
        let provider = {
            let states = state
                .oauth
                .pkce_states
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            if states.is_empty() {
                return Err("No pending OAuth flow found".to_string());
            }
            if states.len() > 1 {
                return Err("Multiple pending OAuth flows — cannot determine provider".to_string());
            }
            states
                .values()
                .next()
                .map(|s| s.provider.clone())
                .ok_or_else(|| "No pending OAuth flow found".to_string())?
        };

        let base = api_base_url();
        let resp = state
            .api_client
            .post(format!("{base}/api/auth/exchange/"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&serde_json::json!({
                "code": code,
                "code_verifier": provider,
            }))
            .send()
            .await
            .map_err(|e| format!("Token exchange request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Token exchange failed: HTTP {status}: {body}"));
        }

        let data: ExchangeResponse = resp
            .json()
            .await
            .map_err(|e| format!("Token exchange parse error: {e}"))?;

        {
            let mut states = state
                .oauth
                .pkce_states
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            states.remove(&provider);
        }

        (
            data.token,
            data.user.id,
            data.user.username,
            data.user.email,
            data.user.substrate_address.unwrap_or_default(),
        )
    } else {
        return Err("Missing both token and authorization code".into());
    };

    let expires_at = {
        let now = chrono::Utc::now();
        let expiry = now + chrono::Duration::days(30);
        expiry.to_rfc3339()
    };
    let token_expiry_ms = chrono::Utc::now().timestamp_millis() + 30 * 24 * 60 * 60 * 1000;

    let provider_name = params
        .token
        .as_ref()
        .map(|_| "oauth")
        .unwrap_or("oauth")
        .to_string();

    if !substrate_address.is_empty() {
        let pool = state.pool()?;
        let owner = account_key(&substrate_address);

        sqlx::query(
            "INSERT INTO auth_session (owner, auth_token, token_expiry, user_id, username, provider, substrate_address, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(owner) DO UPDATE SET
               auth_token = excluded.auth_token,
               token_expiry = excluded.token_expiry,
               user_id = excluded.user_id,
               username = excluded.username,
               provider = excluded.provider,
               substrate_address = excluded.substrate_address,
               updated_at = datetime('now')"
        )
        .bind(&owner)
        .bind(&token)
        .bind(token_expiry_ms)
        .bind(user_id)
        .bind(&username)
        .bind(&provider_name)
        .bind(&substrate_address)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error: {e}"))?;

        sqlx::query(
            "INSERT INTO objectstore_auth_scoped (owner, temp_auth_key)
             VALUES (?, ?)
             ON CONFLICT(owner) DO UPDATE SET temp_auth_key = excluded.temp_auth_key",
        )
        .bind(&owner)
        .bind(&token)
        .execute(pool)
        .await
        .map_err(|e| format!("DB objectstore error: {e}"))?;
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
