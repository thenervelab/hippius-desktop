//! Shared HTTP API client with automatic auth token injection.
//!
//! Provides `ApiClient` (for the main Hippius API) and `IndexerClient`
//! (for the indexer API with X-API-KEY auth). Both handle JSON
//! serialization, error mapping, and structured error responses.
//!
//! Pure logic (URL encoding, URL construction, `ApiError` type) lives in
//! `api_client_logic` so it can be unit-tested via the lib target without
//! pulling in the full binary dependency tree.

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sqlx::sqlite::SqlitePool;
use tracing::warn;

use crate::utils::account_key::account_key;

pub use crate::api_client_logic::{ApiError, url_with_params, urlencoding};

/// Public re-export kept for backward compatibility with callers
/// that used the old `urlencoding_pub` name.
pub fn urlencoding_pub(s: &str) -> String {
    urlencoding(s)
}

const DEFAULT_BASE_URL: &str = "https://api.hippius.com";
const DEFAULT_INDEXER_URL: &str = "https://indexer.hippius.network";

fn api_base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

fn indexer_base_url() -> String {
    std::env::var("HIPPIUS_INDEXER_URL").unwrap_or_else(|_| DEFAULT_INDEXER_URL.to_string())
}

// ---------------------------------------------------------------------------
// Auth token helper
// ---------------------------------------------------------------------------

/// Read the auth token for an account from the `auth_session` DB table.
pub async fn get_auth_token_for_account(pool: &SqlitePool, account_id: &str) -> Result<String, ApiError> {
    let owner = account_key(account_id);

    let row: Option<(String,)> = sqlx::query_as("SELECT auth_token FROM auth_session WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await
        .map_err(|e| ApiError::Other(format!("DB error: {e}")))?;

    match row {
        Some((token,)) if !token.is_empty() => Ok(token),
        _ => Err(ApiError::Other("No auth token found — please log in".into())),
    }
}

// ---------------------------------------------------------------------------
// ApiClient — main Hippius API
// ---------------------------------------------------------------------------

/// HTTP client for the main Hippius API (`https://api.hippius.com`).
/// Adds `Authorization: Token <token>` header automatically.
pub struct ApiClient {
    client: reqwest::Client,
    base_url: String,
    pool: SqlitePool,
}

impl ApiClient {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: api_base_url(),
            pool,
        }
    }

    /// GET request with auth.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, account_id: &str) -> Result<T, ApiError> {
        let token = get_auth_token_for_account(&self.pool, account_id).await?;
        let url = format!("{}{}", self.base_url, path);

        let resp = self
            .client
            .get(&url)
            .header(AUTHORIZATION, format!("Token {token}"))
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;

        Self::handle_response(resp).await
    }

    /// GET request with auth and query parameters.
    pub async fn get_with_params<T: DeserializeOwned>(&self, path: &str, params: &[(&str, &str)], account_id: &str) -> Result<T, ApiError> {
        let token = get_auth_token_for_account(&self.pool, account_id).await?;
        let url = url_with_params(&self.base_url, path, params);

        let resp = self
            .client
            .get(&url)
            .header(AUTHORIZATION, format!("Token {token}"))
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;

        Self::handle_response(resp).await
    }

    /// POST request with auth and JSON body.
    pub async fn post<T: DeserializeOwned, B: Serialize>(&self, path: &str, body: &B, account_id: &str) -> Result<T, ApiError> {
        let token = get_auth_token_for_account(&self.pool, account_id).await?;
        let url = format!("{}{}", self.base_url, path);

        let resp = self
            .client
            .post(&url)
            .header(AUTHORIZATION, format!("Token {token}"))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;

        Self::handle_response(resp).await
    }

    /// PATCH request with auth and JSON body.
    pub async fn patch<T: DeserializeOwned, B: Serialize>(&self, path: &str, body: &B, account_id: &str) -> Result<T, ApiError> {
        let token = get_auth_token_for_account(&self.pool, account_id).await?;
        let url = format!("{}{}", self.base_url, path);

        let resp = self
            .client
            .patch(&url)
            .header(AUTHORIZATION, format!("Token {token}"))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;

        Self::handle_response(resp).await
    }

    /// DELETE request with auth.
    pub async fn delete(&self, path: &str, account_id: &str) -> Result<(), ApiError> {
        let token = get_auth_token_for_account(&self.pool, account_id).await?;
        let url = format!("{}{}", self.base_url, path);

        let resp = self
            .client
            .delete(&url)
            .header(AUTHORIZATION, format!("Token {token}"))
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;

        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            warn!(status = status, path = %path, "API DELETE request failed");
            Err(ApiError::Http { status, body })
        }
    }

    async fn handle_response<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, ApiError> {
        let status = resp.status();
        let url = resp.url().path().to_string();
        if status.is_success() {
            resp.json::<T>().await.map_err(|e| ApiError::Other(format!("JSON parse error: {e}")))
        } else {
            let body = resp.text().await.unwrap_or_default();
            warn!(
                status = status.as_u16(),
                path = %url,
                "API request failed"
            );
            Err(ApiError::Http {
                status: status.as_u16(),
                body,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// IndexerClient — indexer API with X-API-KEY
// ---------------------------------------------------------------------------

/// HTTP client for the Hippius indexer (`https://indexer.hippius.network`).
/// Uses `X-API-KEY` header for authentication.
pub struct IndexerClient {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl IndexerClient {
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: indexer_base_url(),
            api_key,
        }
    }

    /// Create from the env var (same source as the Tauri `get_indexer_api_key` command).
    pub fn from_env() -> Result<Self, ApiError> {
        let api_key = std::env::var("INDEXER_API_KEY").map_err(|_| ApiError::Other("INDEXER_API_KEY not set".into()))?;
        Ok(Self::new(api_key))
    }

    /// GET with query parameters.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, params: &[(&str, &str)]) -> Result<T, ApiError> {
        let url = url_with_params(&self.base_url, path, params);

        let resp = self
            .client
            .get(&url)
            .header(ACCEPT, "application/json")
            .header("X-API-KEY", &self.api_key)
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;

        let status = resp.status();
        if status.is_success() {
            resp.json::<T>().await.map_err(|e| ApiError::Other(format!("JSON parse error: {e}")))
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(ApiError::Http {
                status: status.as_u16(),
                body,
            })
        }
    }
}
