//! `GET /v1/capabilities` — anonymous server feature advertisement.
//!
//! Returned shape from the server (see `hcfs-server::shares::types::Capabilities`):
//!
//! ```json
//! { "shares": true }
//! ```
//!
//! Old hcfs-server deployments don't have this route at all; a 404
//! collapses to `{ shares: false }` so a desktop pointed at a stale
//! server hides the share UI rather than throwing a "the route is
//! gone" error at the user.

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

/// Server feature flags. Currently only `shares` is exposed; future
/// flags can be added without a wire-format change because the FE
/// reads the struct field-by-field.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCapabilities {
    pub shares: bool,
}

/// Fetch the capabilities of the configured HCFS server for this
/// account. Uses the desktop's shared `reqwest::Client` so the request
/// participates in the same connection pool / timeouts as everything
/// else.
pub(crate) async fn fetch_capabilities(state: &crate::app_state::AppState, account_id: &str) -> Result<ServerCapabilities> {
    let pool = state.pool()?;
    // Resolve the server URL the same way the share commands do —
    // empty string means "let hcfs-client race regional endpoints",
    // which we can't do here because we're not going through
    // hcfs-client. Fall back to the prod URL constant in that case.
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let base = if server_url.is_empty() { DEFAULT_SERVER_URL } else { server_url.as_str() };
    let url = format!("{}/v1/capabilities", base.trim_end_matches('/'));

    let resp = match state.api_client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return Err(AppError::Hcfs(format!("capabilities fetch failed: {e}"))),
    };

    // 404 from a pre-shares deployment is not an error — the feature is
    // simply unavailable. Any other non-success status is opaque server
    // trouble, surfaced verbatim.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(ServerCapabilities::default());
    }
    if !resp.status().is_success() {
        return Err(AppError::Api {
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    resp.json::<ServerCapabilities>()
        .await
        .map_err(|e| AppError::Hcfs(format!("capabilities parse failed: {e}")))
}

/// Production console URL used as the fallback when the per-account
/// `hcfs_config.server_url` is the empty-string region-probe sentinel.
/// The capability endpoint has to make a concrete HTTP call — it can't
/// participate in hcfs-client's region race — so we anchor it on the
/// prod URL the rest of the app already trusts.
const DEFAULT_SERVER_URL: &str = "https://hcfs.hippius.io";

/// Tauri command exposing `ServerCapabilities` to the frontend so the
/// share-related UI surfaces (context-menu item, "My Shares" page) can
/// hide themselves on old servers.
#[tauri::command]
pub async fn hcfs_get_capabilities(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<ServerCapabilities> {
    fetch_capabilities(&state, &account_id).await
}
