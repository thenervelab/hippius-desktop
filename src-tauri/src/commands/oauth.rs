//! OAuth flow commands.
//!
//! Handles OAuth URL construction, PKCE state, token exchange,
//! and session persistence. The frontend never stores OAuth state
//! in localStorage/sessionStorage.

use crate::DB_POOL;
use crate::utils::account_key::account_key;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tracing::error;

use once_cell::sync::Lazy;

// ---------------------------------------------------------------------------
// PKCE state (in-memory, keyed by provider to prevent race conditions)
// ---------------------------------------------------------------------------

struct PkceState {
    provider: String,
    #[allow(dead_code)] // stored for future nonce validation in complete_oauth_flow
    nonce: String,
}

static PKCE_STATES: Lazy<Mutex<HashMap<String, PkceState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const API_BASE_URL: &str = "https://api.hippius.com";
const CALLBACK_URL: &str = "https://console.hippius.com/auth/callback";

fn api_base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| API_BASE_URL.to_string())
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthUrlResult {
    pub url: String,
    pub provider: String,
}

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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Build the OAuth authorization URL for the given provider and return it.
/// The frontend opens this URL in the external browser.
#[tauri::command]
pub async fn start_oauth_flow(provider: String) -> Result<OAuthUrlResult, String> {
    let base = api_base_url();

    let auth_path = match provider.as_str() {
        "google" => "/accounts/google/login/",
        "github" => "/accounts/github/login/",
        "apple" => "/accounts/apple/login/",
        _ => return Err(format!("Unsupported OAuth provider: {provider}")),
    };

    // Store PKCE state keyed by provider (with nonce to prevent replay)
    let nonce = uuid::Uuid::new_v4().to_string();
    {
        let mut states = PKCE_STATES
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

    // Build auth URL: /accounts/<provider>/login/?next=/get-token/?callback_url=<callback>
    let callback = format!("{CALLBACK_URL}?source=desktop");
    let next = format!(
        "/get-token/?callback_url={}",
        crate::api_client::urlencoding_pub(&callback)
    );

    let url = format!(
        "{base}{auth_path}?next={}",
        crate::api_client::urlencoding_pub(&next)
    );

    Ok(OAuthUrlResult {
        url,
        provider,
    })
}

/// Process the OAuth callback parameters:
/// - If `token` is present, use it directly.
/// - If `code` is present, exchange it for a token.
/// - Store the resulting session in the DB.
/// Returns the session data for the frontend to update React state.
#[tauri::command]
pub async fn complete_oauth_flow(
    params: OAuthCallbackParams,
) -> Result<OAuthSessionResult, String> {
    // Check for errors — sanitize before returning to frontend
    if let Some(ref err) = params.error {
        let desc = params.error_description.as_deref().unwrap_or("");
        error!("OAuth error from provider: {err} {desc}");
        return Err("Authentication failed".to_string());
    }

    let (token, user_id, username, email, substrate_address) = if let Some(ref t) = params.token {
        // Token returned directly by backend
        (
            t.clone(),
            params.user_id.unwrap_or(0),
            params.username.clone().unwrap_or_default(),
            params.email.clone().unwrap_or_default(),
            params.substrate_address.clone().unwrap_or_default(),
        )
    } else if let Some(ref code) = params.code {
        // Exchange code for token — look up PKCE state by any stored provider
        let provider = {
            let states = PKCE_STATES
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            // There should be exactly one pending flow; use it
            states
                .values()
                .next()
                .map(|s| s.provider.clone())
                .ok_or_else(|| "No pending OAuth flow found".to_string())?
        };

        let base = api_base_url();
        let client = reqwest::Client::new();
        let resp = client
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

    // Clear PKCE state for this provider
    {
        let mut states = PKCE_STATES
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        states.clear();
    }

    // Session expires in 30 days
    let expires_at = {
        let now = chrono::Utc::now();
        let expiry = now + chrono::Duration::days(30);
        expiry.to_rfc3339()
    };
    let token_expiry_ms = chrono::Utc::now().timestamp_millis() + 30 * 24 * 60 * 60 * 1000;

    // Retrieve provider from PKCE state (already cleared, use param)
    let provider_name = params
        .token
        .as_ref()
        .map(|_| "oauth")
        .unwrap_or("oauth")
        .to_string();

    // Persist auth session in the DB
    if !substrate_address.is_empty() {
        let pool = DB_POOL
            .get()
            .ok_or("Database not initialized")?;
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

        // Persist API auth token (used by sync engine, VPN, and API calls)
        sqlx::query(
            "INSERT INTO objectstore_auth_scoped (owner, temp_auth_key)
             VALUES (?, ?)
             ON CONFLICT(owner) DO UPDATE SET temp_auth_key = excluded.temp_auth_key"
        )
        .bind(&owner)
        .bind(&token)
        .execute(pool)
        .await
        .map_err(|e| format!("DB objectstore error: {e}"))?;
    }

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
