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
//!
//! ## Region handling
//!
//! When the per-account `hcfs_config.server_url` is empty (the
//! region-probe sentinel), we cannot route this anonymous call through
//! `HcfsClient` because the share endpoints aren't yet exposed there
//! and the resolved base URL accessor is `pub(super)` in hcfs-client.
//! We therefore walk the regional fallback list from
//! [`crate::sync::region`] and return the first 2xx (or "shares: false"
//! on 404). The list is mirrored from hcfs-client and pinned by a
//! drift-detection test in that module.

use crate::error::{AppError, Result};
use crate::sync::region::regional_fallback_urls;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// Server feature flags. Currently only `shares` is exposed; future
/// flags can be added without a wire-format change because the FE
/// reads the struct field-by-field.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCapabilities {
    pub shares: bool,
}

/// Hit `<base>/v1/capabilities` once. 404 collapses to a
/// `Default::default()` (i.e. `shares: false`) per the comment on
/// `hcfs-server::shares::types::Capabilities` — old deployments don't
/// have the route at all and we want them to look like "feature
/// unavailable" rather than "RPC error".
async fn fetch_one(client: &reqwest::Client, base: &str) -> Result<ServerCapabilities> {
    let url = format!("{}/v1/capabilities", base.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("capabilities fetch failed for {base}: {e}")))?;

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

/// Fetch the capabilities of the configured HCFS server for this
/// account. Uses the desktop's shared `reqwest::Client` so the request
/// participates in the same connection pool / timeouts as everything
/// else.
pub(crate) async fn fetch_capabilities(state: &crate::app_state::AppState, account_id: &str) -> Result<ServerCapabilities> {
    let pool = state.pool()?;
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;

    // Explicit per-account URL: hit it directly, no region race.
    if !server_url.is_empty() {
        debug!(server_url = %server_url, "[capabilities] using configured server URL");
        return fetch_one(&state.api_client, &server_url).await;
    }

    // Auto-detect mode: walk the regional fallbacks. We don't replicate
    // hcfs-client's parallel race because (a) capabilities is a one-shot
    // call per session and (b) the FE atom caches the result, so the
    // savings of a parallel probe wouldn't repay the complexity.
    let mut last_err: Option<AppError> = None;
    for base in regional_fallback_urls() {
        debug!(base, "[capabilities] probing regional URL");
        match fetch_one(&state.api_client, base).await {
            Ok(caps) => return Ok(caps),
            Err(e) => {
                warn!(base, error = %e, "[capabilities] regional probe failed; trying next");
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Hcfs("no regional URLs configured".into())))
}

/// Tauri command exposing `ServerCapabilities` to the frontend so the
/// share-related UI surfaces (context-menu item, "My Shares" page) can
/// hide themselves on old servers.
#[tauri::command]
pub async fn hcfs_get_capabilities(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<ServerCapabilities> {
    fetch_capabilities(&state, &account_id).await
}
