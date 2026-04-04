//! Indexer API key command.
//!
//! Exposes the `INDEXER_API_KEY` environment variable to the frontend
//! so it can authenticate directly with the blockchain indexer service.

use crate::error::AppError;

/// Return the indexer API key from the environment.
///
/// Fails if the variable is missing or empty so the frontend can
/// surface a clear error rather than making unauthorized requests.
#[tauri::command]
pub fn get_indexer_api_key() -> Result<String, AppError> {
    let key = std::env::var("INDEXER_API_KEY").map_err(|_| AppError::Validation("INDEXER_API_KEY is not set".into()))?;

    if key.trim().is_empty() {
        return Err(AppError::Validation("INDEXER_API_KEY is empty".into()));
    }

    Ok(key)
}

use reqwest::header::ACCEPT;
use serde::de::DeserializeOwned;
use super::client::{ApiError, url_with_params};

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
    pub fn new(api_key: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: indexer_base_url(),
            api_key,
        }
    }

    /// Create from the env var.
    pub fn from_env() -> Result<Self, ApiError> {
        let api_key = std::env::var("INDEXER_API_KEY")
            .map_err(|_| ApiError::Other("INDEXER_API_KEY not set".into()))?;
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
            Err(ApiError::Http { status: status.as_u16(), body })
        }
    }
}
