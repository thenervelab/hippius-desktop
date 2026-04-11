//! Indexer API client — base URL resolution and typed HTTP wrappers.

use super::client::{ApiError, url_with_params};
use reqwest::header::ACCEPT;
use serde::de::DeserializeOwned;

const DEFAULT_INDEXER_URL: &str = "https://indexer.hippius.network";

fn indexer_base_url() -> String {
    std::env::var("HIPPIUS_INDEXER_URL").unwrap_or_else(|_| DEFAULT_INDEXER_URL.to_string())
}

/// HTTP client for the Hippius indexer. Uses `X-API-KEY` header for authentication.
pub struct IndexerClient {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl IndexerClient {
    pub fn new(client: reqwest::Client, api_key: String) -> Self {
        Self {
            client,
            base_url: indexer_base_url(),
            api_key,
        }
    }

    /// Create from the env var.
    pub fn from_env(client: reqwest::Client) -> Result<Self, ApiError> {
        let api_key = std::env::var("INDEXER_API_KEY").map_err(|_| ApiError::Other("INDEXER_API_KEY not set".into()))?;
        Ok(Self::new(client, api_key))
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
