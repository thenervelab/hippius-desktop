//! Shared HTTP API client with automatic auth token injection.
//!
//! Provides `ApiClient` (for the main Hippius API) and `IndexerClient`
//! (for the indexer API with X-API-KEY auth). Both handle JSON
//! serialization, error mapping, and structured error responses.
//!
//! Pure logic (URL encoding, URL construction, `ApiError` type) lives in
//! `api_client` so it can be unit-tested via the lib target without
//! pulling in the full binary dependency tree.

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sqlx::sqlite::SqlitePool;
use tracing::warn;

/// Minimal percent-encoding for query parameter values.
///
/// Encodes all characters except unreserved characters (RFC 3986):
/// `A-Z`, `a-z`, `0-9`, `-`, `_`, `.`, `~`.
/// Spaces are encoded as `%20` (not `+`).
pub fn urlencoding(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => {
                result.push(c);
            }
            ' ' => result.push_str("%20"),
            _ => {
                use std::fmt::Write;
                for b in c.to_string().as_bytes() {
                    let _ = write!(result, "%{b:02X}");
                }
            }
        }
    }
    result
}

/// Build a URL with query parameters appended.
///
/// Keys and values are percent-encoded. An empty `params` slice
/// produces a URL with no `?` suffix.
pub fn url_with_params(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{base}{path}");
    if !params.is_empty() {
        url.push('?');
        for (i, (key, value)) in params.iter().enumerate() {
            if i > 0 {
                url.push('&');
            }
            url.push_str(&urlencoding(key));
            url.push('=');
            url.push_str(&urlencoding(value));
        }
    }
    url
}

/// Structured error from API calls.
#[derive(Debug)]
pub enum ApiError {
    /// HTTP error with status code and body.
    Http { status: u16, body: String },
    /// Network or serialization error.
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Http { status, body } => write!(f, "HTTP {status}: {body}"),
            ApiError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl From<ApiError> for String {
    fn from(e: ApiError) -> String {
        e.to_string()
    }
}

const DEFAULT_BASE_URL: &str = "https://api.hippius.com";

pub(crate) fn api_base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

// ---------------------------------------------------------------------------
// Auth token helper
// ---------------------------------------------------------------------------

/// Read the auth token for an account from the `auth_session` DB table.
///
/// Routes through [`crate::auth::auth_session_repo::get_token_and_expiry`]
/// so the repo stays the only direct reader of the table.
pub async fn get_auth_token_for_account(pool: &SqlitePool, account_id: &crate::app_state::SessionAccount) -> Result<String, ApiError> {
    let row = crate::auth::auth_session_repo::get_token_and_expiry(pool, account_id)
        .await
        .map_err(|e| ApiError::Other(format!("DB error: {e}")))?;

    match row {
        Some(crate::auth::auth_session_repo::TokenStatus { token: Some(token), .. }) if !token.is_empty() => Ok(token),
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
    pub fn new(client: reqwest::Client, pool: SqlitePool) -> Self {
        Self {
            client,
            base_url: api_base_url(),
            pool,
        }
    }

    /// GET request with auth.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, account_id: &crate::app_state::SessionAccount) -> Result<T, ApiError> {
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
    pub async fn get_with_params<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, &str)],
        account_id: &crate::app_state::SessionAccount,
    ) -> Result<T, ApiError> {
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
    pub async fn post<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
        account_id: &crate::app_state::SessionAccount,
    ) -> Result<T, ApiError> {
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
    pub async fn patch<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
        account_id: &crate::app_state::SessionAccount,
    ) -> Result<T, ApiError> {
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
    pub async fn delete(&self, path: &str, account_id: &crate::app_state::SessionAccount) -> Result<(), ApiError> {
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
        if status.is_success() {
            resp.json::<T>().await.map_err(|e| ApiError::Other(format!("JSON parse error: {e}")))
        } else {
            let url = resp.url().path().to_string();
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

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // URL encoding
    // -----------------------------------------------------------------------

    #[test]
    fn encode_unreserved_chars_unchanged() {
        assert_eq!(urlencoding("abc-XYZ_01.~"), "abc-XYZ_01.~");
    }

    #[test]
    fn encode_space_as_percent20() {
        assert_eq!(urlencoding("hello world"), "hello%20world");
    }

    #[test]
    fn encode_ampersand() {
        assert_eq!(urlencoding("foo&bar"), "foo%26bar");
    }

    #[test]
    fn encode_equals() {
        assert_eq!(urlencoding("a=b"), "a%3Db");
    }

    #[test]
    fn encode_slash() {
        assert_eq!(urlencoding("path/to/file"), "path%2Fto%2Ffile");
    }

    #[test]
    fn encode_empty_string() {
        assert_eq!(urlencoding(""), "");
    }

    #[test]
    fn encode_multibyte_utf8() {
        // Euro sign U+20AC is 3 bytes in UTF-8: E2 82 AC
        assert_eq!(urlencoding("\u{20AC}"), "%E2%82%AC");
    }

    #[test]
    fn encode_4byte_emoji() {
        // Grinning face U+1F600 is 4 bytes in UTF-8: F0 9F 98 80
        assert_eq!(urlencoding("\u{1F600}"), "%F0%9F%98%80");
    }

    #[test]
    fn encode_ss58_address_unchanged() {
        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        assert_eq!(urlencoding(addr), addr);
    }

    // -----------------------------------------------------------------------
    // URL construction
    // -----------------------------------------------------------------------

    #[test]
    fn url_no_params() {
        let url = url_with_params("https://api.example.com", "/v1/items", &[]);
        assert_eq!(url, "https://api.example.com/v1/items");
    }

    #[test]
    fn url_single_param() {
        let url = url_with_params("https://api.example.com", "/search", &[("q", "hello world")]);
        assert_eq!(url, "https://api.example.com/search?q=hello%20world");
    }

    #[test]
    fn url_multiple_params() {
        let url = url_with_params("https://api.example.com", "/search", &[("q", "rust"), ("page", "2")]);
        assert_eq!(url, "https://api.example.com/search?q=rust&page=2");
    }

    #[test]
    fn url_params_with_special_chars() {
        let url = url_with_params("https://api.example.com", "/data", &[("filter", "a&b=c")]);
        assert_eq!(url, "https://api.example.com/data?filter=a%26b%3Dc");
    }

    // -----------------------------------------------------------------------
    // ApiError formatting
    // -----------------------------------------------------------------------

    #[test]
    fn api_error_http_display() {
        let err = ApiError::Http {
            status: 401,
            body: "Unauthorized".into(),
        };
        assert_eq!(format!("{err}"), "HTTP 401: Unauthorized");
    }

    #[test]
    fn api_error_other_display() {
        let err = ApiError::Other("connection refused".into());
        assert_eq!(format!("{err}"), "connection refused");
    }

    #[test]
    fn api_error_to_string_conversion() {
        let err = ApiError::Http {
            status: 500,
            body: "Internal Server Error".into(),
        };
        let s: String = err.into();
        assert_eq!(s, "HTTP 500: Internal Server Error");
    }
}
