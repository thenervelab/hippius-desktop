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

/// Server feature flags. Struct-level `#[serde(default)]` makes every
/// missing field `false`, which is how an older deployment (predating a
/// given flag) reads as "feature unavailable" instead of a parse error.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCapabilities {
    pub shares: bool,
    /// Browsable folder shares (`/v1/folder-shares`). Mirrors
    /// `hcfs-server::shares::types::Capabilities::folder_shares`; servers
    /// that predate the routes omit the field entirely.
    pub folder_shares: bool,
    /// `/v1/folder-shares/by-hash/{token_hash}` revoke + re-expire, which
    /// let this device act on a share whose plaintext token it never held.
    ///
    /// Separate from [`Self::folder_shares`] because it ships later: a
    /// server can advertise folder shares and still lack these routes, which
    /// is exactly what production looks like between the two deploys. On
    /// such a server the routes answer a bare 404 — indistinguishable from
    /// "already revoked" — so acting on the older flag would report a live,
    /// anonymously readable share as turned off.
    pub folder_share_revoke_by_hash: bool,
    /// `PUT /v1/shares/owner-wraps` and `PUT /v1/folder-shares/owner-wraps`,
    /// plus `owner_wrap` on the owner listings. Absent on older servers.
    pub share_owner_wrap: bool,
    /// Folder grants: share one folder of a shared drive, read-only
    /// (`HCFS_FEATURE_FOLDER_GRANTS`). Requires shared drives. Absent on
    /// older servers and off in prod until clients are ready.
    pub folder_grants: bool,
    /// `POST /v1/folder-shares` takes `owner_ss58`, so an Editor can share
    /// a folder by link inside a drive somebody else owns
    /// (hcfs #458). Absent on older servers, which read that mint under the
    /// caller's own account and find nothing.
    pub member_folder_shares: bool,
    /// Writer (Editor) folder invites are accepted
    /// (`HCFS_FEATURE_FOLDER_GRANT_WRITES`, HCFS #475). A HINT only: the
    /// desktop still sends an Editor folder invite without it and turns the
    /// server's refusal into "coming soon", so the option lights up on its
    /// own the day the server turns it on. See `shared_drives::folder_roles`.
    pub folder_grant_writes: bool,
    /// Whether the response carried a `folder_grants` key AT ALL, true or
    /// false. Not a server field: set by [`parse_capabilities`].
    ///
    /// A server that knows folder invites refuses one it cannot honour. One
    /// that predates them ignores `path_prefix` and mints (or MAILS) a
    /// whole-drive invite in its place, so no folder request is sent to a
    /// server that does not know the key. Never serialized to the FE.
    #[serde(skip)]
    pub folder_grants_known: bool,
}

/// Parse a `/v1/capabilities` body, recording whether the server knows about
/// folder grants at all (see [`ServerCapabilities::folder_grants_known`]).
pub fn parse_capabilities(body: &str) -> Result<ServerCapabilities> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("capabilities parse failed: {e}")))?;
    let known = value.get("folder_grants").is_some_and(serde_json::Value::is_boolean);
    let mut caps: ServerCapabilities = serde_json::from_value(value).map_err(|e| AppError::Hcfs(format!("capabilities parse failed: {e}")))?;
    caps.folder_grants_known = known;
    Ok(caps)
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
    let body = resp.text().await.map_err(|e| AppError::Hcfs(format!("capabilities read failed: {e}")))?;
    parse_capabilities(&body)
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
    let account_id = state.require_session_account(&account_id)?;
    fetch_capabilities(&state, &account_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pre-folder-shares server advertises `{"shares":true}` only; the
    /// missing field must read as "folder shares unavailable", not a parse
    /// error — that is the whole deployment-skew story for the flag.
    #[test]
    fn missing_folder_shares_field_defaults_to_false() {
        let caps: ServerCapabilities = serde_json::from_str(r#"{"shares":true}"#).expect("parse old-server shape");
        assert!(caps.shares);
        assert!(!caps.folder_shares);
    }

    /// The by-hash revoke routes ship after folder shares, so a server can
    /// advertise `folder_shares` without them. That combination is what
    /// production looks like between the two deploys, and reading the
    /// by-hash flag as true there would let the desktop treat a "no such
    /// route" 404 as "already revoked" — telling the user a live,
    /// anonymously readable share had been turned off.
    #[test]
    fn folder_shares_without_by_hash_reads_as_by_hash_unavailable() {
        let caps: ServerCapabilities = serde_json::from_str(r#"{"shares":true,"folder_shares":true}"#).expect("parse");
        assert!(caps.folder_shares);
        assert!(!caps.folder_share_revoke_by_hash);
    }

    #[test]
    fn full_capabilities_shape_round_trips() {
        let caps: ServerCapabilities = serde_json::from_str(
            r#"{"shares":true,"folder_shares":true,"folder_share_revoke_by_hash":true,"share_owner_wrap":true,"folder_grants":true,"member_folder_shares":true,"folder_grant_writes":true}"#,
        )
        .expect("parse");
        assert!(caps.shares);
        assert!(caps.folder_shares);
        assert!(caps.folder_share_revoke_by_hash);
        assert!(caps.share_owner_wrap);
        assert!(caps.folder_grants);
        assert!(caps.member_folder_shares);
        assert!(caps.folder_grant_writes);

        // The IPC serializes this struct straight to the FE, which reads the
        // snake_case keys — pin them so a stray rename_all cannot drift the
        // wire silently.
        let json = serde_json::to_value(&caps).expect("serialize");
        let keys: std::collections::BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "folder_grant_writes",
                "folder_grants",
                "folder_share_revoke_by_hash",
                "folder_shares",
                "member_folder_shares",
                "share_owner_wrap",
                "shares"
            ]
            .into_iter()
            .collect(),
            "capabilities wire keys drifted"
        );

        let old: ServerCapabilities =
            serde_json::from_str(r#"{"shares":true,"folder_shares":true,"folder_share_revoke_by_hash":true}"#).expect("parse old");
        assert!(!old.share_owner_wrap);
        assert!(!old.folder_grants);
        assert!(!old.member_folder_shares, "an older server never claims member folder shares");
        assert!(!old.folder_grant_writes, "writer folder invites stay off until a server says otherwise");
    }

    /// A pre-folder-grants server omits the field; that must read as unavailable,
    /// never a parse error — same deployment-skew story as folder_shares.
    #[test]
    fn missing_folder_grants_field_defaults_to_false() {
        let caps: ServerCapabilities = serde_json::from_str(r#"{"shares":true,"folder_shares":true}"#).expect("parse");
        assert!(!caps.folder_grants);
    }

    /// A server that predates folder invites ignores `path_prefix` and would
    /// mint a whole-drive invite; one that knows them and has them off
    /// refuses. Only the key's presence tells the two apart.
    #[test]
    fn folder_grants_known_tracks_the_key_not_its_value() {
        let old = parse_capabilities(r#"{"shares":true,"folder_shares":true}"#).expect("parse");
        assert!(!old.folder_grants_known, "no key: the server predates folder invites");
        let off = parse_capabilities(r#"{"shares":true,"folder_grants":false}"#).expect("parse");
        assert!(off.folder_grants_known && !off.folder_grants, "key present and off: it refuses");
        let on = parse_capabilities(r#"{"folder_grants":true,"folder_grant_writes":false}"#).expect("parse");
        assert!(on.folder_grants_known && on.folder_grants && !on.folder_grant_writes);
        assert!(parse_capabilities("not json").is_err());
    }
}
