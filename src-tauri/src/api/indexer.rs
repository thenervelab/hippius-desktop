//! Indexer API client — base URL resolution and typed HTTP wrappers.

use super::client::{ApiError, get_auth_token_for_account, url_with_params};
use crate::app_state::{AppState, SessionAccount};
use crate::error::AppError;
use reqwest::header::{ACCEPT, AUTHORIZATION};
use serde::de::DeserializeOwned;
use sqlx::sqlite::SqlitePool;
use std::sync::OnceLock;

const DEFAULT_INDEXER_URL: &str = "https://indexer.hippius.network";

/// Cache the resolved indexer base URL for the process lifetime.
///
/// `std::env::var` walks the process environment table on every call —
/// micro-cost individually, but billing/chart commands hit this dozens of
/// times during a single page render. One-shot caching is safe because the
/// var is read at process start (via dotenvy) and never reseeded at runtime.
static INDEXER_BASE_URL: OnceLock<String> = OnceLock::new();

fn indexer_base_url() -> &'static str {
    INDEXER_BASE_URL
        .get_or_init(|| std::env::var("HIPPIUS_INDEXER_URL").unwrap_or_else(|_| DEFAULT_INDEXER_URL.to_string()))
        .as_str()
}

/// HTTP client for the Hippius indexer, authenticated as the logged-in user.
///
/// This used to send a shared `X-API-KEY` read from a bundled `.env`, which meant one
/// operator credential — good for the whole indexer surface, cache invalidation included —
/// shipped inside every installer and could be unpacked out of any of them. The indexer now
/// takes the user's own Hippius session token, resolves it to an SS58, and answers only for
/// that account on the routes that carry account records.
///
/// **The credential and the queried account are deliberately separate.** The token is always
/// the *session* account's, minted here from [`AppState::current_session_account`]. What a
/// given call asks *about* stays in its query parameters, and the wallet page legitimately
/// asks about a local wallet the user holds but is not logged in as — the indexer allows that
/// for `/system-account-balance` and `/balance-transfers`, which serve public chain state.
pub struct IndexerClient {
    client: reqwest::Client,
    base_url: &'static str,
    pool: SqlitePool,
    session_account: SessionAccount,
}

impl IndexerClient {
    /// Build a client that authenticates as the current session account.
    ///
    /// # Errors
    ///
    /// [`AppError::Auth`] when nobody is logged in — indexer-backed screens then surface an
    /// error rather than a confident zero, which is the failure the old missing-key guard
    /// existed to prevent and is worth preserving as the credential changes.
    pub fn for_session(state: &AppState, client: reqwest::Client) -> Result<Self, AppError> {
        Ok(Self {
            client,
            base_url: indexer_base_url(),
            pool: state.pool()?.clone(),
            session_account: state.current_session_account()?,
        })
    }

    /// GET with query parameters.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, params: &[(&str, &str)]) -> Result<T, ApiError> {
        let token = get_auth_token_for_account(&self.pool, &self.session_account).await?;
        let url = url_with_params(self.base_url, path, params);
        let resp = self
            .client
            .get(&url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Token {token}"))
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
