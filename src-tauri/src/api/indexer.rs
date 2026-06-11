//! Indexer API client — base URL resolution and typed HTTP wrappers.

use super::client::{ApiError, url_with_params};
use reqwest::header::ACCEPT;
use serde::de::DeserializeOwned;
use std::sync::OnceLock;

const DEFAULT_INDEXER_URL: &str = "https://indexer.hippius.network";

/// Cache the resolved indexer base URL and API key for the process lifetime.
///
/// `std::env::var` walks the process environment table on every call —
/// micro-cost individually, but billing/chart commands hit `from_env`
/// dozens of times during a single page render. One-shot caching is
/// safe because both env vars are read at process start (via dotenvy)
/// and never reseeded at runtime.
static INDEXER_BASE_URL: OnceLock<String> = OnceLock::new();
static INDEXER_API_KEY: OnceLock<Option<String>> = OnceLock::new();

fn indexer_base_url() -> &'static str {
    INDEXER_BASE_URL
        .get_or_init(|| std::env::var("HIPPIUS_INDEXER_URL").unwrap_or_else(|_| DEFAULT_INDEXER_URL.to_string()))
        .as_str()
}

fn indexer_api_key() -> Option<&'static str> {
    INDEXER_API_KEY.get_or_init(|| std::env::var("INDEXER_API_KEY").ok()).as_deref()
}

/// HTTP client for the Hippius indexer. Uses `X-API-KEY` header for authentication.
///
/// `base_url` and `api_key` are `&'static str` borrowed from process-wide
/// `OnceLock`s populated at first access. Cloning a client is cheap (an
/// `Arc` bump on `reqwest::Client` plus two pointer copies); allocation-free.
pub struct IndexerClient {
    client: reqwest::Client,
    base_url: &'static str,
    api_key: &'static str,
}

impl IndexerClient {
    /// Create from the cached `INDEXER_API_KEY` env var.
    ///
    /// Reads the env var exactly once per process via [`indexer_api_key`].
    /// All subsequent calls return a client backed by the same `&'static`
    /// strings — no allocation, no env lookup.
    pub fn from_env(client: reqwest::Client) -> Result<Self, ApiError> {
        let api_key = indexer_api_key().ok_or_else(|| ApiError::Other("INDEXER_API_KEY not set".into()))?;
        Ok(Self {
            client,
            base_url: indexer_base_url(),
            api_key,
        })
    }

    /// GET with query parameters.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, params: &[(&str, &str)]) -> Result<T, ApiError> {
        let url = url_with_params(self.base_url, path, params);
        let resp = self
            .client
            .get(&url)
            .header(ACCEPT, "application/json")
            .header("X-API-KEY", self.api_key)
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;

        let status = resp.status();
        if status.is_success() {
            resp.json::<T>().await.map_err(|e| ApiError::Other(format!("JSON parse error: {e}")))
        } else {
            // Capture the request path before consuming `resp` with `.text()`, so
            // a failed indexer call is attributable in the logs. The bare
            // ApiError::Http carries only status + body, dropping which endpoint
            // failed — match the sibling api::client::handle_response, which logs
            // the path the same way.
            let req_path = resp.url().path().to_string();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!(status = status.as_u16(), path = %req_path, "Indexer API request failed");
            Err(ApiError::Http {
                status: status.as_u16(),
                body,
            })
        }
    }
}
