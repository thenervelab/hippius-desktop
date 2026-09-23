//! Invite/membership IPC commands over hcfs-server's shared-drive endpoints.
//!
//! HTTP plumbing mirrors the desktop's other one-shot hcfs-server calls
//! (`sync::recent_uploads`, `sync::migration`): the `HcfsClient` is reserved
//! for sync, so these are direct `reqwest` calls against
//! `region::resolve_base_url` with `Authorization: Bearer`. Every call is
//! bounded by [`REQUEST_TIMEOUT`]. The endpoint functions take
//! `(client, base_url, bearer, ...)` so the mock-server integration tests
//! (`tests/shared_drive_server_mock.rs`) exercise the real request/response
//! code with no Tauri runtime — the `migration_server_mock` seam.
//!
//! **Feature-off servers**: the routes are mounted only under
//! `HCFS_FEATURE_SHARED_DRIVES=1`; an unmounted route answers axum's bare 404
//! (empty body), while a mounted route's domain 404 carries the JSON
//! `{error, message}` envelope. [`classify_error_status`] tells them apart and
//! maps the bare 404 to `NotReady(SharedDrivesUnavailable)` so the FE can
//! hide the surface (matching the `subkind` EXPLICITLY — see the variant's
//! docs) instead of erroring.
//!
//! **Invite revocation goes through the invite id, never the token.** The
//! desktop deliberately never persists a minted token — a stored token is a
//! stored drive-access capability — so `list_drive_invites` reports the
//! server's own rows (id, role, expiry, use count, validity) and
//! `revoke_drive_invite` kills one by id. Removing a member is the other half
//! and answers a different question: it revokes someone who already joined,
//! not a link still circulating.
//!
//! **Secret hygiene**: the invite token and the folder-mnemonic entropy are
//! drive-access capabilities. Neither may be logged, and neither crosses IPC
//! except inside the returned invite URL. Log labels and folder hashes only.

use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};
use crate::shared_drives::grant;
use crate::sync::identity::MemberDriveIdentity;
use base64::Engine;
use hcfs_shared::network::{CreateDriveInviteRequest, CreateDriveInviteResponse, DriveMembersResponse, DriveMembershipsResponse};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tracing::{debug, info, warn};
use zeroize::Zeroizing;

/// Bound on every shared-drive HTTP call (the `recent_uploads` precedent —
/// these back interactive dialogs, not bulk transfers).
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Desktop invite policy applied when the IPC caller omits a parameter:
/// a minted link dies after 7 days or 50 claims, whichever comes first.
/// Both are blast-radius bounds on a leaked link — an unclaimed invite URL
/// is a standing drive-access capability (token + folder-key entropy), so
/// an OMITTED lifetime always resolves finite. An explicit caller value
/// passes through untouched — the FE's "Never expires" preset sends the
/// server's 100-year cap (`NEVER_EXPIRES_SECS` in `shareDriveModalState.ts`),
/// a deliberate product choice, not a default. The policy lives HERE, in
/// Rust, so it holds for every IPC caller instead of depending on each
/// FE wrapper filling the fields; the server keeps its own defaults/caps
/// as the backstop, but the desktop never leans on them.
const DEFAULT_INVITE_EXPIRES_IN_SECS: u64 = 7 * 24 * 60 * 60;
const DEFAULT_INVITE_MAX_USES: u32 = 50;

/// Resolve the caller's optional invite parameters against the desktop
/// policy defaults. Extracted (rather than inline `unwrap_or`s) so the
/// policy is unit-testable; [`create_drive_invite`] routes through it and
/// [`http_create_invite`] takes the resolved values, so no call path can
/// send an omitted field.
/// The wire roles the server accepts, in its own spelling. Kept in step with
/// `app/lib/shared-drives/roles.ts`, which holds the same list for the UI.
pub(crate) const WIRE_ROLES: [&str; 3] = ["reader", "writer", "manager"];

/// A manager invite is hard-capped by the server at one use and 24 hours.
pub(crate) const MANAGER_INVITE_MAX_USES: u32 = 1;
pub(crate) const MANAGER_INVITE_MAX_SECS: u64 = 24 * 60 * 60;

/// Resolve and check the role an invite is minted for.
///
/// An omitted role keeps the historical `writer`, so a caller that predates
/// the picker mints exactly what it always did.
///
/// Both refusals exist because the server answers a bare 400 and the user
/// cannot tell which of their choices it objected to. A typo rejected by name,
/// and a cap named as a cap, are the difference between "that role does not
/// exist" and "something went wrong" — and a manager link minted for 7 days
/// would be rejected AFTER the user had configured it.
pub(crate) fn resolve_invite_role(role: Option<String>, expires_in_secs: u64, max_uses: u32) -> Result<String> {
    let role = role.unwrap_or_else(|| "writer".to_string());
    if !WIRE_ROLES.contains(&role.as_str()) {
        return Err(AppError::Validation(format!(
            "Unknown drive role: {role}. Expected one of reader, writer, manager."
        )));
    }
    if role == "manager" {
        if max_uses > MANAGER_INVITE_MAX_USES {
            return Err(AppError::Validation("A manager invite can only be used once.".into()));
        }
        if expires_in_secs > MANAGER_INVITE_MAX_SECS {
            return Err(AppError::Validation("A manager invite expires within 24 hours.".into()));
        }
    }
    Ok(role)
}

fn resolve_invite_policy(expires_in_secs: Option<u64>, max_uses: Option<u32>) -> (u64, u32) {
    (
        expires_in_secs.unwrap_or(DEFAULT_INVITE_EXPIRES_IN_SECS),
        max_uses.unwrap_or(DEFAULT_INVITE_MAX_USES),
    )
}

/// Keep a real display string; drop blank/whitespace so the FE never draws a
/// gap where an ss58 fallback belonged (hcfs #455 / console `presentText`).
fn present_text(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Forward a server `member_count` of 0/omitted as `None` so the FE never
/// draws "0 members" from an unknown or empty listing signal.
fn present_member_count(count: u64) -> Option<u32> {
    if count == 0 {
        None
    } else {
        u32::try_from(count).ok()
    }
}

// ─── FE-facing wire types (camelCase, desktop-owned) ───────────────────────

/// Result of a successful invite mint. The URL embeds the invite token (path)
/// and the folder-key entropy (`#k=` fragment) — the ONLY channel either
/// secret crosses IPC on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInviteLink {
    pub invite_url: String,
}

/// One row of the owner-side members table. Deliberately blob-free, like the
/// server response it projects.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveMemberInfo {
    pub member_ss58: String,
    pub role: String,
    pub created_at: String,
    /// Display name from the account-profile projection (hcfs #455). Absent
    /// when the account has none on file — FE falls back to a shortened ss58.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    /// Email, only disclosed to the drive's owner/managers. Same absence rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_email: Option<String>,
}

/// One drive shared WITH this account ("Shared with me" row). The sealed
/// `grant_blob` is deliberately NOT here: it opens only inside
/// [`add_shared_drive`], never in the renderer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveMembershipInfo {
    pub owner_ss58: String,
    /// Owner display name (hcfs #455); absent when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    pub folder_hash: String,
    pub display_label: String,
    pub role: String,
    pub created_at: String,
    /// True when a local `sync_paths` member row already syncs this wire
    /// identity on this device — the FE routes such a row to "open the
    /// drive" instead of offering "Sync locally" a second time.
    pub synced_locally: bool,
    /// The local drive label of that row (`None` when not synced here).
    pub local_label: Option<String>,
    /// How many people currently hold a membership (owner excluded). `None`
    /// when the server omitted the field (old server / unknown) — the FE
    /// must never draw "0 members" from absence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u32>,
    /// Owner account limited (grace / lapsed): uploads refused; reads may
    /// still work. Omitted/`false` when unfrozen.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub frozen: bool,
    /// RFC 3339 end of the biller's grace window, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen_until: Option<String>,
}

/// Result of [`add_shared_drive`]: the local drive label actually allocated
/// (`display_label` suffixed on collision, e.g. `team-docs-2`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSharedDriveResult {
    pub label: String,
}

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────

/// Assemble the invite URL: `{console}/invite/{token}#k={base64url no-pad
/// entropy}`. The fragment never reaches the server (browsers do not send
/// fragments), so the key rides the link without the console ever seeing it —
/// the share-link `#k=` pattern.
fn build_invite_url(console_base: &str, invite_token: &str, entropy: &[u8; 32]) -> String {
    let fragment = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(entropy);
    format!("{}/invite/{}#k={}", console_base.trim_end_matches('/'), invite_token, fragment)
}

/// Map a non-success shared-drive endpoint response to a typed error.
///
/// A 404 whose body is NOT the server's JSON `{error, message}` envelope is
/// axum's unmounted-route answer — the feature-off server — and maps to
/// `NotReady(SharedDrivesUnavailable)`. A JSON-enveloped 404 is a domain
/// "no such invite/member/drive" and maps to `NotFound`. A 403 whose `error`
/// slug is `shared_drives_not_entitled` is the mint plan gate and maps to
/// `NotReady(SharedDrivesNotEntitled)` (the FE shows an upgrade prompt); other
/// 401/403 map to `Auth`; anything else is a surfaced `Hcfs` transport/server
/// error.
fn classify_error_status(status: reqwest::StatusCode, body: &str) -> AppError {
    #[derive(serde::Deserialize)]
    struct ErrorEnvelope {
        error: String,
        message: String,
    }

    let envelope: Option<ErrorEnvelope> = serde_json::from_str(body).ok();

    // The mint plan gate: a 403 carrying this exact slug is a "not entitled"
    // verdict the FE turns into an upgrade prompt. Match the SLUG, never the
    // English message. Checked before the general 401/403 → Auth arm.
    if status.as_u16() == 403 && envelope.as_ref().is_some_and(|env| env.error == "shared_drives_not_entitled") {
        return AppError::NotReady(NotReadyKind::SharedDrivesNotEntitled);
    }

    match (status.as_u16(), envelope) {
        (404, None) => AppError::NotReady(NotReadyKind::SharedDrivesUnavailable),
        (404, Some(env)) => AppError::NotFound(env.message),
        (401 | 403, env) => AppError::Auth(env.map_or_else(|| format!("shared-drive request rejected (status {status})"), |e| e.message)),
        (_, env) => AppError::Hcfs(env.map_or_else(
            || format!("shared-drive request failed (status {status})"),
            |e| format!("shared-drive request failed (status {status}): {}", e.message),
        )),
    }
}

// ─── HTTP layer (the mock-server test seam) ────────────────────────────────

/// `POST /v1/drive-invites` — mint an invite, returning the plaintext token.
/// The token is a capability: callers must not log or persist it.
///
/// Takes RESOLVED policy values, not `Option`s: the desktop always sends a
/// concrete lifetime and claim cap (see [`resolve_invite_policy`]), so the
/// server's own defaults never silently apply to a desktop mint.
/// What the mint endpoint needs — an args struct, the `MemberDriveInstall`
/// precedent, once delegation added the owner and the list outgrew a readable
/// positional call.
pub struct MintInvite<'a> {
    pub folder_hash: &'a str,
    pub expires_in_secs: u64,
    pub max_uses: u32,
    pub role: &'a str,
    /// Set by a MANAGER minting for a drive they do not own; `None` for an
    /// owner, which the server reads as caller-as-owner.
    pub owner: Option<&'a str>,
}

pub async fn http_create_invite(http: &reqwest::Client, base_url: &str, bearer: &str, mint: MintInvite<'_>) -> Result<String> {
    let MintInvite {
        folder_hash,
        expires_in_secs,
        max_uses,
        role,
        owner,
    } = mint;
    let req = CreateDriveInviteRequest {
        folder_hash: folder_hash.to_string(),
        // A MANAGER mints for the drive's OWNER, and names them here rather
        // than in a query param -- `folder_hash` alone is not globally
        // unique. Owners send `None`, which the server reads as
        // caller-as-owner.
        owner_ss58: owner.map(str::to_string),
        expires_in_secs: Some(expires_in_secs),
        max_uses: Some(max_uses),
        // Sent explicitly rather than omitted. An omitted role means `writer`
        // server-side, which is what every build before the picker minted --
        // fine as a default, wrong as a silent one now that the user chooses.
        role: Some(role.to_string()),
    };
    let resp = http
        .post(format!("{}/v1/drive-invites", base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&req)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("create-invite request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    let parsed: CreateDriveInviteResponse =
        serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("create-invite response did not parse: {e}")))?;
    Ok(parsed.invite_token)
}

/// `GET /v1/drives/{folder_hash}/members` — owner-side member listing.
pub async fn http_list_members(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    owner: Option<&str>,
) -> Result<DriveMembersResponse> {
    let resp = http
        .get(with_owner(
            &format!("{}/v1/drives/{}/members", base_url.trim_end_matches('/'), folder_hash),
            owner,
        )?)
        .header("Authorization", format!("Bearer {bearer}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("list-members request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("list-members response did not parse: {e}")))
}

/// `DELETE /v1/drives/{folder_hash}/members/{member_ss58}`.
///
/// `owner` MUST be `Some` on the self-leave path: `folder_hash` is
/// label-derived and collides across owners as a matter of course, and the
/// server's bare fallback deletes ALL of the caller's same-hash memberships
/// in one statement. Owner-removes-member calls pass `None` — the server
/// keys that path by the caller's own identity and ignores the param.
pub async fn http_remove_member(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    member_ss58: &str,
    owner: Option<&str>,
) -> Result<()> {
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1/drives/{}/members/{}",
        base_url.trim_end_matches('/'),
        folder_hash,
        member_ss58
    ))
    .map_err(|e| AppError::Hcfs(format!("invalid remove-member URL: {e}")))?;
    if let Some(owner) = owner {
        url.query_pairs_mut().append_pair("owner", owner);
    }

    let resp = http
        .delete(url)
        .header("Authorization", format!("Bearer {bearer}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("remove-member request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    Ok(())
}

/// `PATCH /v1/drives/{folder_hash}/members/{member_ss58}` — change a member's
/// role in place.
///
/// The new role binds on the member's very next request, so there is no
/// propagation delay to warn anyone about. The server refuses a caller
/// targeting themselves with a 400: a manager cannot demote themself, they
/// leave through the member DELETE instead.
///
/// A downward change is sticky. The server also revokes the invite that
/// admitted the member when that link still outranks the new role, and a
/// demotion out of `manager` additionally revokes every live invite that
/// member minted, so a spare link cannot re-escalate them. Nothing here has
/// to arrange that; it matters when explaining the result to the user.
pub async fn http_change_member_role(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    member_ss58: &str,
    role: &str,
    owner: Option<&str>,
) -> Result<()> {
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1/drives/{}/members/{}",
        base_url.trim_end_matches('/'),
        folder_hash,
        member_ss58
    ))
    .map_err(|e| AppError::Hcfs(format!("invalid change-role URL: {e}")))?;
    if let Some(owner) = owner {
        url.query_pairs_mut().append_pair("owner", owner);
    }

    let resp = http
        .patch(url)
        .header("Authorization", format!("Bearer {bearer}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "role": role }))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("change-role request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    Ok(())
}

/// One live invite for a drive, as the server lists it.
///
/// `invite_id` is the blake3 hash of the token, never the token itself — the
/// server cannot hand back a link, which is exactly why revoke-by-id exists:
/// it is the only way to kill an invite whose link the caller no longer holds,
/// and that is every link once the mint dialog has closed.
///
/// This type is BOTH the server's response shape and the FE's wire shape, and
/// the two are spelled differently. `rename` would set the name for
/// serialization AND deserialization, which is how every multi-word field
/// reached the renderer as snake_case while the TS read camelCase: the Links
/// tab rendered "undefined of undefined used" and "Expiry unknown", while
/// `role`, `valid` and `revoked` -- single words, so untouched by a rename --
/// looked perfectly fine and hid it. `rename_all` therefore owns the wire
/// name and each `alias` accepts the server's spelling on the way in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInviteInfo {
    #[serde(alias = "invite_id")]
    pub invite_id: String,
    pub role: String,
    /// Who minted it — the owner, or a manager they delegated to. Empty for
    /// invites predating provenance, and `#[serde(default)]` so those rows
    /// still parse rather than failing the whole listing.
    #[serde(default, alias = "minted_by")]
    pub minted_by: String,
    /// Minter display name (hcfs #455); absent when unknown or minted_by empty.
    #[serde(default, alias = "minted_by_name", skip_serializing_if = "Option::is_none")]
    pub minted_by_name: Option<String>,
    #[serde(alias = "expires_at")]
    pub expires_at: String,
    #[serde(alias = "max_uses")]
    pub max_uses: u32,
    #[serde(alias = "use_count")]
    pub use_count: u32,
    pub revoked: bool,
    pub valid: bool,
    #[serde(alias = "created_at")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct DriveInvitesResponse {
    #[serde(default)]
    invites: Vec<DriveInviteInfo>,
}

/// `GET /v1/drives/{folder_hash}/invites` — the live invites for a drive.
pub async fn http_list_invites(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    owner: Option<&str>,
) -> Result<Vec<DriveInviteInfo>> {
    let resp = http
        .get(with_owner(
            &format!("{}/v1/drives/{}/invites", base_url.trim_end_matches('/'), folder_hash),
            owner,
        )?)
        .header("Authorization", format!("Bearer {bearer}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("list-invites request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    let parsed: DriveInvitesResponse =
        serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("list-invites response did not parse: {e}")))?;
    Ok(parsed.invites)
}

/// `DELETE /v1/drives/{folder_hash}/invites/{invite_id}` — revoke one invite.
///
/// Malformed, unknown, another drive's and already-revoked ids all answer the
/// same plain 404, so a failure here is never proof the invite existed. The
/// caller treats 404 as "it is gone", which is the state the user asked for
/// either way.
pub async fn http_revoke_invite(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    invite_id: &str,
    owner: Option<&str>,
) -> Result<()> {
    let resp = http
        .delete(with_owner(
            &format!("{}/v1/drives/{}/invites/{}", base_url.trim_end_matches('/'), folder_hash, invite_id),
            owner,
        )?)
        .header("Authorization", format!("Bearer {bearer}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("revoke-invite request failed: {e}")))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    Ok(())
}

/// `GET /v1/drive-memberships` — the caller's memberships WITH sealed grant
/// blobs. Internal to the backend: the blobs must not cross IPC.
pub async fn http_list_memberships(http: &reqwest::Client, base_url: &str, bearer: &str) -> Result<DriveMembershipsResponse> {
    let resp = http
        .get(format!("{}/v1/drive-memberships", base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {bearer}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("list-memberships request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("list-memberships response did not parse: {e}")))
}

// ─── Shared command plumbing ───────────────────────────────────────────────

/// The resolved account + connection triple every command needs.
pub(crate) struct ApiCtx {
    account_id: String,
    base_url: String,
    bearer: String,
}

/// Resolve the session account, the concrete regional base URL, and the
/// bearer token — the `recent_uploads::fetch_search_files` plumbing.
/// [`api_ctx`] for callers outside this module (`sync::fileops::remote` needs
/// it to open a grant for a drive that was never synced here).
pub(crate) async fn api_ctx_for(state: &AppState) -> Result<ApiCtx> {
    api_ctx(state).await
}

async fn api_ctx(state: &AppState) -> Result<ApiCtx> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;

    let server_url = crate::sync::remote::get_server_url(pool, &account_id).await?;
    let base_url = crate::sync::region::resolve_base_url(&server_url).to_string();
    let bearer = crate::auth::tokens::get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;

    Ok(ApiCtx {
        account_id,
        base_url,
        bearer,
    })
}

/// Resolve `label` and require it to be an OWN drive. Member labels are
/// refused as `Validation` (surfaced, never FE-silenced): only the owner can
/// mint invites or manage members, and the server would reject the calls
/// anyway — refusing locally names the actual rule instead of a 403.
///
/// `pub` for the integration tests: this is the single owner-gate every
/// owner-side command (`create_drive_invite`, `list_drive_members`,
/// `remove_drive_member`) resolves through.
pub async fn resolve_own_drive(pool: &sqlx::SqlitePool, account_id: &str, label: &str) -> Result<crate::sync::identity::DriveIdentity> {
    // LENIENT on purpose, matching `create_folder_share_inner`.
    //
    // A drive can exist on the server with no local `sync_paths` row -- one
    // synced only from another device, or never synced here at all. The strict
    // resolver refused those by label, so an owner could not invite anyone to
    // a drive they own but do not happen to sync on this machine, which is
    // most of them on a second device.
    //
    // Nothing here needs the row: the invite is metadata plus a folder
    // mnemonic derived from the master and the label, so the key chain is
    // identical whether or not the drive is local. A row that DOES exist still
    // resolves normally, so a member row still resolves to member identity and
    // is refused below -- the owner-only gate is unchanged.
    //
    // Trade-off, same as the folder-share mint: a stale or mistyped label no
    // longer earns a client-side refusal. It reaches the server and comes back
    // as a domain 404 instead.
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, label).await?;
    if identity.is_member {
        return Err(AppError::Validation(format!(
            "'{label}' is a drive shared with you — only its owner can manage invites and members"
        )));
    }
    Ok(identity)
}

/// Append `?owner=` when a call is delegated.
///
/// One helper rather than a `query_pairs_mut` block per endpoint: the param
/// is what makes a manager's call address the right drive, and a route that
/// quietly forgets it falls back to a `folder_hash` that collides across
/// owners who both named a drive the same thing.
fn with_owner(url: &str, owner: Option<&str>) -> Result<reqwest::Url> {
    let mut parsed = reqwest::Url::parse(url).map_err(|e| AppError::Hcfs(format!("invalid shared-drive URL: {e}")))?;
    if let Some(owner) = owner {
        parsed.query_pairs_mut().append_pair("owner", owner);
    }
    Ok(parsed)
}

/// Resolve `label` for a MANAGEMENT operation — owner or delegated manager.
///
/// Unlike [`resolve_own_drive`] this admits a member drive, because the
/// server admits one: a manager manages a drive they do not own by naming its
/// owner (`?owner=` on the member/invite routes, `owner_ss58` in the mint
/// body). Refusing member drives locally is what made the desktop mint
/// Manager invites it could not then honour.
///
/// Role is NOT checked here, deliberately. Only the server knows it, and its
/// refusal is a domain 404 whose body is identical for "no such drive", "not
/// a member" and "insufficient role" — delegated management never leaks drive
/// existence. Guessing locally would either duplicate that rule badly or leak
/// what the server hides.
pub async fn resolve_manageable_drive(pool: &sqlx::SqlitePool, account_id: &str, label: &str) -> Result<crate::sync::identity::DriveIdentity> {
    crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, label).await
}

/// Resolve the drive a management call addresses.
///
/// A manager may hold a drive they have never synced here, and every manage
/// command resolved a LOCAL label — which for such a drive resolves to
/// nothing, and the lenient fallback then answers with THIS account's
/// namespace. So the caller may name the wire identity instead, exactly as
/// browsing does.
///
/// Half an identity is refused rather than guessed: falling through to the
/// label would manage the wrong drive instead of failing.
async fn resolve_manage_target(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    label: &str,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<crate::sync::identity::DriveIdentity> {
    match (owner_ss58, folder_hash) {
        (Some(owner), Some(hash)) => {
            let owner = owner.trim();
            let hash = hash.trim();
            if owner.is_empty() || hash.is_empty() {
                return Err(AppError::Validation(
                    "Managing a shared drive needs both its owner and its folder hash.".into(),
                ));
            }
            Ok(crate::sync::identity::DriveIdentity {
                wire_ss58: owner.to_string(),
                wire_folder_hash: hash.to_string(),
                // Somebody else's drive by construction; the flag is what
                // makes `delegated_owner` name them on the wire.
                is_member: true,
            })
        }
        (None, Some(_)) | (Some(_), None) => Err(AppError::Validation(
            "Managing a shared drive needs both its owner and its folder hash.".into(),
        )),
        (None, None) => resolve_manageable_drive(pool, account_id, label).await,
    }
}

/// The `owner` a delegated management call must name, or `None` for an own
/// drive where the server keys by the caller's own identity.
///
/// A member drive's `wire_ss58` IS the owner's address, so this is the whole
/// of the delegation: pass it and a manager's call addresses the right drive;
/// omit it and `folder_hash` alone collides across owners who both named a
/// drive the same thing.
fn delegated_owner(identity: &crate::sync::identity::DriveIdentity) -> Option<&str> {
    identity.is_member.then_some(identity.wire_ss58.as_str())
}

/// The inputs [`install_member_drive`] needs (an args struct — the row
/// allocation, seal, and repair paths all consume the same seven values).
pub struct MemberDriveInstall<'a> {
    /// The MEMBER's session account (the local `sync_paths` owner).
    pub account_id: &'a str,
    /// The drive OWNER's wire identity to persist onto the row.
    pub member: &'a MemberDriveIdentity,
    /// The caller-chosen local sync root (ignored when repairing an existing
    /// row — the row's own path wins, see [`install_member_drive`]).
    pub local_path: &'a str,
    /// The server-side display label the local label allocates from.
    pub display_label: &'a str,
    /// The OWNER's folder mnemonic to seal for the sync engine.
    pub folder_phrase: &'a Zeroizing<String>,
    /// The MEMBER's master mnemonic (decrypts the drive password).
    pub master_mnemonic: &'a str,
}

/// The local slot a member drive install resolved to: the drive label and
/// the sync root the caller must asset-scope and initialize.
#[derive(Debug)]
pub struct InstalledMemberDrive {
    pub label: String,
    pub sync_path: String,
}

/// Persist a member drive locally: allocate the labeled `sync_paths` row
/// carrying the owner's wire identity, then seal the owner's folder mnemonic
/// into the new config dir under the member's drive password — the seal
/// `initialize_sync_inner` later unlocks with (a member config dir has no
/// derive-from-master self-heal, so this file is the drive's only local key
/// source).
///
/// **Idempotent per wire identity.** If a row for `(owner_ss58,
/// wire_folder_hash)` already exists, no second slot is allocated — two local
/// roots syncing the same server folder would fight each other's baselines.
/// A healthy existing install (seal present) at a DIFFERENT path than the
/// caller asked for refuses as `Validation`, naming the existing label/path
/// so the user can find it. Otherwise (seal missing — an earlier crash
/// stranded the row — or the same path re-requested) the install REPAIRS in
/// place: the seal is rewritten unconditionally (safe: its inputs are
/// deterministic) at the ROW's own path, and the caller proceeds to the same
/// init funnel. A seal failure right after a FRESH allocate deletes the
/// just-inserted row, so the stranded row-without-seal state only survives a
/// crash between the two writes.
///
/// MUST be called with `AppState::recovery_lock` held: `master_mnemonic`
/// decrypts the drive password, and a concurrent password rotation between
/// the read and the seal write would strand the seal under the old password.
/// `pub` for the integration tests (`tests/shared_drive_server_mock.rs`),
/// which drive the row+seal effects against a temp HOME with the HTTP layer
/// mocked.
pub async fn install_member_drive(pool: &sqlx::SqlitePool, install: MemberDriveInstall<'_>) -> Result<InstalledMemberDrive> {
    let existing =
        crate::sync::identity::member_row_for_wire_identity(pool, install.account_id, &install.member.owner_ss58, &install.member.wire_folder_hash)
            .await?;

    if let Some(row) = existing {
        let seal_path = crate::sync::mnemonic::config_dir_for_folder(install.account_id, &row.label)?.join("enc_mnemonic.json");
        if seal_path.is_file() && row.path != install.local_path {
            return Err(AppError::Validation(format!(
                "This shared drive is already set up as '{}' at {}",
                row.label, row.path
            )));
        }

        // Repair in place: rewrite the seal into the existing label's config
        // dir and hand back the ROW's own path — never a second slot.
        seal_folder_mnemonic(pool, install.account_id, &row.label, install.folder_phrase, install.master_mnemonic).await?;
        return Ok(InstalledMemberDrive {
            label: row.label,
            sync_path: row.path,
        });
    }

    // Fresh install: allocate the local drive row atomically, persisting the
    // owner's wire identity (LabelMode::Allocate — member drives are created
    // exactly once, never upserted; the base label is suffixed on collision).
    let base = crate::sync::folders::sanitize_label(install.display_label)?;
    let label = crate::sync::paths::set_sync_path_internal(
        pool,
        install.account_id,
        install.local_path,
        false,
        crate::sync::paths::LabelMode::Allocate {
            base: &base,
            member: Some(install.member),
        },
    )
    .await?;

    // Belt-and-suspenders: a failed seal right after the fresh insert deletes
    // the row again, so a row-without-seal (which the repair path above must
    // otherwise heal) only survives a crash between the two writes.
    if let Err(e) = seal_folder_mnemonic(pool, install.account_id, &label, install.folder_phrase, install.master_mnemonic).await {
        if let Err(cleanup) = crate::sync::paths::remove_sync_path_internal(pool, install.account_id, &label).await {
            warn!(label = %label, error = %cleanup, "Failed to clean up the member drive row after a seal failure");
        }
        return Err(e);
    }

    Ok(InstalledMemberDrive {
        label,
        sync_path: install.local_path.to_string(),
    })
}

/// Seal `folder_phrase` into `label`'s config dir under the member's drive
/// password (decrypted via the master). The Argon2-free but disk-touching
/// write is offloaded to `spawn_blocking` like every other seal write.
async fn seal_folder_mnemonic(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    label: &str,
    folder_phrase: &Zeroizing<String>,
    master_mnemonic: &str,
) -> Result<()> {
    let drive_password = crate::sync::config::get_drive_password(pool, account_id, Some(master_mnemonic)).await?;
    let folder_dir = crate::sync::mnemonic::config_dir_for_folder(account_id, label)?;
    std::fs::create_dir_all(&folder_dir)?;

    let enc_path = folder_dir.join("enc_mnemonic.json");
    let phrase_owned = Zeroizing::new(folder_phrase.to_string());
    tokio::task::spawn_blocking(move || {
        hcfs_client::auth::save_encrypted_mnemonic(&enc_path, &phrase_owned, &drive_password).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::Other(format!("seal task failed to join: {e}")))?
    .map_err(AppError::Hcfs)?;
    Ok(())
}

// ─── IPC commands ──────────────────────────────────────────────────────────

/// This account's folder-key entropy for a member drive, from the grant the
/// server holds for it.
///
/// `pub(crate)` for `sync::fileops::remote`, which needs the same key to
/// upload into a shared drive that was never synced here.
///
/// The local seal is the usual source, but a drive that was never synced here
/// has none — and refusing on that basis made managing a drive conditional on
/// copying it to this machine. The grant blob carries the same key, sealed to
/// this account, so it is opened directly.
///
/// Argon2id at grant cost is multi-second, so the open is offloaded; running a
/// KDF on the runtime stalls every other IPC.
pub(crate) async fn open_grant_entropy_inner(
    state: &AppState,
    ctx: &ApiCtx,
    identity: &crate::sync::identity::DriveIdentity,
) -> Result<Zeroizing<[u8; 32]>> {
    let memberships = http_list_memberships(&state.api_client.clone(), &ctx.base_url, &ctx.bearer).await?;
    let entry = memberships
        .memberships
        .into_iter()
        .find(|m| m.owner_ss58 == identity.wire_ss58 && m.folder_hash == identity.wire_folder_hash)
        .ok_or_else(|| AppError::Validation("You are no longer a member of this drive.".into()))?;

    let grant_blob = base64::engine::general_purpose::STANDARD
        .decode(&entry.grant_blob)
        .map_err(|e| AppError::Crypto(format!("grant blob is not valid base64: {e}")))?;

    let master = crate::sync::mnemonic::get_mnemonic_for_account(state, &ctx.account_id).await?;
    let master_owned = Zeroizing::new(master.to_string());
    let member_ss58 = ctx.account_id.clone();
    tokio::task::spawn_blocking(move || grant::open_grant(&master_owned, &member_ss58, &grant_blob))
        .await
        .map_err(|e| AppError::Other(format!("grant-open task failed to join: {e}")))?
}

/// Mint an invite link for an OWN drive.
///
/// The link is assembled here, in Rust: the invite token and the folder-key
/// entropy exist nowhere else — not in logs, not in another IPC response —
/// and the FE only copies the finished URL to the clipboard.
#[tauri::command]
pub async fn create_drive_invite(
    app: tauri::AppHandle,
    label: String,
    expires_in_secs: Option<u64>,
    max_uses: Option<u32>,
    role: Option<String>,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<DriveInviteLink> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_manage_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    // The folder-key entropy the link's fragment carries. The master read is
    // serialized against password rotation (`recovery_lock`), the sanctioned
    // accessor discipline for every master-mnemonic consumer. `Zeroizing`
    // means every return path — including the HTTP error below — scrubs the
    // entropy by drop, with no manual zeroize choreography to miss.
    let entropy: Zeroizing<[u8; 32]> = {
        // The master read is serialized against password rotation
        // (`recovery_lock`), the sanctioned discipline for every
        // master-mnemonic consumer. `Zeroizing` means every return path --
        // including the HTTP error below -- scrubs the entropy by drop.
        let _recovery_guard = state.recovery_lock.lock().await;
        // ONE resolver for the folder key, shared with uploads and renames.
        // It knows all three sources: this account's master for an own drive,
        // the OWNER-sealed mnemonic for a member drive synced here, and this
        // account's own grant for one that never was. The mint used to carry
        // its own copy of that branch, which read the drive password without
        // the session mnemonic -- so an encrypted password could not be
        // decrypted and a manager simply could not mint.
        let mnemonic = crate::sync::remote::session_mnemonic(&state)?;
        let phrase = crate::sync::remote::folder_phrase_for_label(&state, &ctx.account_id, &label, &mnemonic, &identity).await?;
        grant::entropy_from_phrase(&phrase)?
    };

    // Omitted parameters resolve to the desktop policy here, not on the
    // server and not in the FE wrapper — see `resolve_invite_policy`.
    let (expires_in_secs, max_uses) = resolve_invite_policy(expires_in_secs, max_uses);

    let role = resolve_invite_role(role, expires_in_secs, max_uses)?;

    let http = state.api_client.clone();
    let token = http_create_invite(
        &http,
        &ctx.base_url,
        &ctx.bearer,
        MintInvite {
            folder_hash: &identity.wire_folder_hash,
            expires_in_secs,
            max_uses,
            role: &role,
            owner: delegated_owner(&identity),
        },
    )
    .await?;

    let invite_url = build_invite_url(&crate::shares::commands::console_base_url(), &token, &entropy);

    info!(label = %label, folder_hash = %identity.wire_folder_hash, "Drive invite minted");
    Ok(DriveInviteLink { invite_url })
}

/// List the members of an OWN drive.
#[tauri::command]
pub async fn list_drive_members(
    app: tauri::AppHandle,
    label: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<Vec<DriveMemberInfo>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_manage_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    let resp = http_list_members(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        delegated_owner(&identity),
    )
    .await?;
    // Logged because the sharing badge is derived from this count, and when it
    // fails to appear the first question is whether the call happened at all.
    // A frontend `console.warn` cannot answer that: it reaches devtools, never
    // the on-disk log a user can actually send.
    info!(label = %label, count = resp.members.len(), "Listed drive members");
    Ok(resp
        .members
        .into_iter()
        .map(|m| DriveMemberInfo {
            member_ss58: m.member_ss58,
            role: m.role,
            created_at: m.created_at,
            member_name: present_text(m.member_name),
            member_email: present_text(m.member_email),
        })
        .collect())
}

/// Remove a member from an OWN drive (the owner path — revocation of access).
/// The member's next request is denied server-side; their drive surfaces the
/// revoked state on its next sync cycle (Task 5).
#[tauri::command]
pub async fn remove_drive_member(
    app: tauri::AppHandle,
    label: String,
    member_ss58: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<()> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_manage_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    // `None` for an owner (the server keys the delete by the caller's own
    // identity); the owner's address for a manager removing somebody from a
    // drive they do not own.
    http_remove_member(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &member_ss58,
        delegated_owner(&identity),
    )
    .await?;

    info!(label = %label, folder_hash = %identity.wire_folder_hash, "Drive member removed");
    Ok(())
}

/// Change a member's role on a drive this account owns or manages.
///
/// The role is validated here rather than forwarded blind: the server answers
/// 400 for anything outside its vocabulary, and a typo reaching the wire as a
/// rejected request is a worse diagnostic than refusing it by name. Kept in
/// step with `app/lib/shared-drives/roles.ts`, which holds the same list for
/// the UI.
#[tauri::command]
pub async fn change_drive_member_role(
    app: tauri::AppHandle,
    label: String,
    member_ss58: String,
    role: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<()> {
    const WIRE_ROLES: [&str; 3] = ["reader", "writer", "manager"];
    if !WIRE_ROLES.contains(&role.as_str()) {
        return Err(AppError::Validation(format!(
            "Unknown drive role: {role}. Expected one of reader, writer, manager."
        )));
    }

    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_manage_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    // Targeting yourself is the server's 400 (a manager demotes themself by
    // leaving, not by PATCH). Refuse it here so the UI can say why instead of
    // surfacing a bare rejection.
    if member_ss58 == ctx.account_id {
        return Err(AppError::Validation("You cannot change your own role. Leave the drive instead.".into()));
    }

    // `None` for an owner; the owner's address for a manager re-roling
    // somebody on a drive they do not own.
    http_change_member_role(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &member_ss58,
        &role,
        delegated_owner(&identity),
    )
    .await?;

    // The member ss58 is an account identifier, not a secret, and the role is
    // the point of the line; the drive label stays as the operator's handle.
    info!(label = %label, folder_hash = %identity.wire_folder_hash, role = %role, "Drive member role changed");
    Ok(())
}

/// List the live invites for a drive this account owns.
///
/// The only place an invite id exists outside the server. Revoking needs one,
/// and the mint cannot supply it — the server returns a token, and the id is
/// that token's hash, which is precisely what makes a minted link
/// unrevocable without this listing.
#[tauri::command]
pub async fn list_drive_invites(
    app: tauri::AppHandle,
    label: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<Vec<DriveInviteInfo>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_manage_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    let invites = http_list_invites(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        delegated_owner(&identity),
    )
    .await?;
    let live = invites.iter().filter(|i| i.valid && !i.revoked).count();
    info!(label = %label, count = invites.len(), live, "Listed drive invites");
    Ok(invites)
}

/// What one drive row needs to know about its own sharing.
///
/// Folded HERE rather than in the renderer because the fold encodes a rule —
/// see [`fold_drive_sharing`] — and because two surfaces read it (the drive
/// page's folder list and the settings sync manager), which is exactly how
/// two copies of a rule come to disagree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSharingSummary {
    pub label: String,
    pub member_count: u32,
    /// Invite links that can still admit someone.
    pub live_invite_count: u32,
    /// Every invite the server still lists, expired and revoked included.
    ///
    /// The badge keys on this rather than on live links alone: an owner who
    /// shared a drive last week and whose link has since lapsed still shared
    /// it, and would not understand a row identical to one they never touched.
    pub total_invite_count: u32,
}

/// Fold one drive's two listings into what its row needs.
///
/// `None` for either argument means that listing FAILED, which is not the same
/// as it being empty. A drive whose listings both failed is omitted from the
/// result entirely: knowing nothing about a drive is not knowing it is
/// private, and a row rendered "not shared" off a failed request is a
/// confident wrong answer. One listing succeeding is enough — `/invites` is a
/// newer route than `/members`, so a server that serves one and not the other
/// must still describe the half it can.
///
/// Pure, so the rule is testable without a server.
fn fold_drive_sharing(label: &str, member_count: Option<usize>, invites: Option<&[DriveInviteInfo]>) -> Option<DriveSharingSummary> {
    if member_count.is_none() && invites.is_none() {
        return None;
    }
    Some(DriveSharingSummary {
        label: label.to_string(),
        member_count: member_count.unwrap_or(0) as u32,
        live_invite_count: invites.map_or(0, |i| i.iter().filter(|i| i.valid && !i.revoked).count()) as u32,
        total_invite_count: invites.map_or(0, <[_]>::len) as u32,
    })
}

/// Sharing state for every OWN drive named in `labels`, in one call.
///
/// Member counts come from the account's `/list_folders`
/// (`RemoteFolderInfo.member_count`) — one request for the set — rather than
/// a `/members` fan-out per drive. Invites are still per-drive, and are
/// fetched ONLY when a drive has no members: a drive with members is already
/// "shared" for the badge, and a link with no join yet leaves
/// `member_count == 0` while the Links tab still needs a signal.
///
/// A drive that fails entirely is ABSENT from the result rather than failing
/// the call: one unreachable drive must not blank the badge on eleven others.
/// A label that is not an own drive is skipped for the same reason — the
/// caller filters member drives out already, and a stale label mid-refresh
/// should not error the set.
#[tauri::command]
pub async fn list_owned_drive_sharing(app: tauri::AppHandle, labels: Vec<String>) -> Result<Vec<DriveSharingSummary>> {
    if labels.is_empty() {
        return Ok(Vec::new());
    }
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let pool = state.pool()?;
    let http = state.api_client.clone();

    // One listing for every own drive's member_count. Failure here means we
    // cannot answer counts; invites-only still describe a half we can.
    let folders_by_hash = match http_list_owner_folders(&http, &ctx.base_url, &ctx.bearer, &ctx.account_id).await {
        Ok(folders) => folders
            .into_iter()
            .map(|f| (f.folder_hash.clone(), f))
            .collect::<std::collections::HashMap<_, _>>(),
        Err(e) => {
            warn!(error = %e, "Own folder listing failed; sharing badge falls back to invites-only");
            std::collections::HashMap::new()
        }
    };

    let summaries = futures_util::future::join_all(labels.iter().map(|label| {
        let http = http.clone();
        let ctx = &ctx;
        let folders_by_hash = &folders_by_hash;
        async move {
            // Owner-only on purpose: this answers "which of MY drives have I
            // shared". A drive shared WITH this account is described by its
            // role badge, which needs no counts.
            let identity = resolve_own_drive(pool, &ctx.account_id, label).await.ok()?;
            let member_count = folders_by_hash
                .get(&identity.wire_folder_hash)
                .map(|f| f.member_count as usize);

            // Invites only when we have no members (or could not learn the
            // count): otherwise the badge already has its answer and N invite
            // GETs would be pure noise on every drive-list refresh.
            let invites = if member_count.unwrap_or(0) == 0 {
                match http_list_invites(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash, None).await {
                    Ok(invites) => Some(invites),
                    Err(err) => {
                        debug!(label = %label, error = %err, "Drive invites listing failed");
                        None
                    }
                }
            } else {
                None
            };

            fold_drive_sharing(label, member_count, invites.as_deref())
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    // One line for the set rather than one per drive: this runs for every
    // drive on the account whenever the list refreshes, and a per-drive line
    // would crowd the support bundle. The count is what answers "did the
    // badge have data to draw".
    info!(
        asked = labels.len(),
        answered = summaries.len(),
        shared = summaries.iter().filter(|s| s.member_count > 0 || s.total_invite_count > 0).count(),
        "Listed owned drive sharing"
    );
    Ok(summaries)
}

/// Revoke one invite for a drive this account owns.
///
/// Until this existed, a minted link could not be killed at all: the desktop
/// never persists tokens and the server stores only their hashes, so a
/// "never expires" link handed to the wrong person stayed live forever.
/// Removing a member does not help — that revokes someone who already joined,
/// not the link still circulating.
#[tauri::command]
pub async fn revoke_drive_invite(
    app: tauri::AppHandle,
    label: String,
    invite_id: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<()> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_manage_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    http_revoke_invite(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &invite_id,
        delegated_owner(&identity),
    )
    .await?;

    // The id is a token HASH, not the token, so it is safe to log -- it cannot
    // be turned back into a link.
    info!(label = %label, invite_id = %invite_id, "Drive invite revoked");
    Ok(())
}

/// List the drives shared WITH this account, each joined against the local
/// `sync_paths` member rows (`syncedLocally` / `localLabel`) so the FE can
/// route an already-synced row to the drive instead of a second "Sync
/// locally". Grant blobs stay in the backend — they open only inside
/// [`add_shared_drive`].
#[tauri::command]
pub async fn list_my_drive_memberships(app: tauri::AppHandle) -> Result<Vec<DriveMembershipInfo>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let pool = state.pool()?;

    let resp = http_list_memberships(&state.api_client.clone(), &ctx.base_url, &ctx.bearer).await?;
    let mut memberships = Vec::with_capacity(resp.memberships.len());
    for m in resp.memberships {
        let local = crate::sync::identity::member_row_for_wire_identity(pool, &ctx.account_id, &m.owner_ss58, &m.folder_hash).await?;
        memberships.push(DriveMembershipInfo {
            owner_ss58: m.owner_ss58,
            owner_name: present_text(m.owner_name),
            folder_hash: m.folder_hash,
            display_label: m.display_label,
            role: m.role,
            created_at: m.created_at,
            synced_locally: local.is_some(),
            local_label: local.map(|row| row.label),
            member_count: present_member_count(m.member_count),
            frozen: m.frozen,
            frozen_until: present_text(m.frozen_until),
        });
    }
    Ok(memberships)
}

/// Leave a shared drive: delete THIS account's membership server-side, then
/// remove the local member drive (row + in-memory state + sync baseline; the
/// local files stay on disk, exactly like removing an own drive).
///
/// The server delete ALWAYS carries `?owner=` — see [`http_remove_member`].
/// A domain 404 (the membership is already gone: the owner removed us first)
/// still proceeds to local removal — the goal state "this device no longer
/// syncs the drive" is already half-reached, and refusing would strand a
/// dead drive the UI can't clean up (the `delete_remote_folder` idempotency
/// precedent). A `SharedDrivesUnavailable` refusal (feature-off server), by
/// contrast, fails the command whole: the escape hatch for cleaning up the
/// local drive is the plain `remove_drive` path — Task 5's revoked-state
/// "Remove" affordance and Task 6 wire it deliberately rather than this
/// command guessing that the membership no longer matters.
/// Size, file count and last-changed for the drives shared with this account.
///
/// `/v1/drive-memberships` carries no counts at all, so a row listing a shared
/// drive has nothing to show beside its name. Only the OWNER's folder listing
/// has the figures, and `/list_folders/{owner}` serves a member a view
/// filtered to the drives they actually belong to — so this is one request per
/// distinct OWNER, not per drive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedDriveStats {
    pub owner_ss58: String,
    pub folder_hash: String,
    pub file_count: u64,
    pub total_bytes: u64,
    /// Server-side last-change time, Unix seconds.
    pub updated_at: i64,
}

/// The payload inside the server's envelope.
///
/// `folders` is NOT `#[serde(default)]`: every HCFS response is wrapped in
/// `NetworkResponse`, so a body parsed at the wrong level carries no
/// `folders` key at all -- and a default turned that into "this owner shares
/// nothing", indistinguishable from an empty account and reporting no error.
/// Without the default, the wrong level fails loudly instead.
#[derive(Deserialize)]
struct ListFoldersResult {
    folders: Vec<hcfs_shared::network::RemoteFolderInfo>,
}

/// Read a `/list_folders` body through the envelope every HCFS response
/// carries. Split out so the unwrapping is testable without a server: it is
/// the one thing about this endpoint that went wrong.
fn parse_list_folders(body: &str) -> Result<Vec<hcfs_shared::network::RemoteFolderInfo>> {
    let parsed: hcfs_shared::network::NetworkResponse<ListFoldersResult> =
        serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("list-folders response did not parse: {e}")))?;
    match parsed {
        hcfs_shared::network::NetworkResponse::Success(result) => Ok(result.folders),
        hcfs_shared::network::NetworkResponse::Error(err) => Err(AppError::Hcfs(format!("list-folders failed: {} ({})", err.message, err.error))),
        hcfs_shared::network::NetworkResponse::Conflict(_) => Err(AppError::Hcfs("list-folders answered with a conflict".into())),
    }
}

/// `GET /list_folders/{owner}` — the owner's drives, filtered by the server to
/// the ones the calling member belongs to.
async fn http_list_owner_folders(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    owner_ss58: &str,
) -> Result<Vec<hcfs_shared::network::RemoteFolderInfo>> {
    let resp = http
        .get(format!("{}/list_folders/{}", base_url.trim_end_matches('/'), owner_ss58))
        .header("Authorization", format!("Bearer {bearer}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("list-folders request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    parse_list_folders(&body)
}

/// Stats for every drive shared with this account by one of `owners`.
///
/// A drive whose owner's listing did not come back is ABSENT from the result,
/// never present with zeroes. An unknown size is not a zero: summing one in as
/// though it were under-reports the total while looking perfectly healthy,
/// which is the failure nobody files a bug for. The caller renders absence as
/// "not known yet" rather than as an empty drive.
#[tauri::command]
pub async fn list_shared_drive_stats(app: tauri::AppHandle, owners: Vec<String>) -> Result<Vec<SharedDriveStats>> {
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let http = state.api_client.clone();

    // One request per DISTINCT owner: several drives shared by the same
    // person come back in one listing.
    let mut distinct: Vec<String> = owners;
    distinct.sort();
    distinct.dedup();

    let stats = futures_util::future::join_all(distinct.iter().map(|owner| {
        let http = http.clone();
        let ctx = &ctx;
        async move {
            match http_list_owner_folders(&http, &ctx.base_url, &ctx.bearer, owner).await {
                Ok(folders) => folders
                    .into_iter()
                    .map(|f| SharedDriveStats {
                        owner_ss58: owner.clone(),
                        folder_hash: f.folder_hash,
                        file_count: f.file_count,
                        total_bytes: f.total_bytes,
                        updated_at: f.updated_at,
                    })
                    .collect::<Vec<_>>(),
                Err(e) => {
                    // WARN, not debug: the default filter drops debug, and a
                    // failure here renders as a row with no figures --
                    // identical on screen to an owner who shares nothing.
                    // That is the shape that hid this endpoint's envelope
                    // bug, so it has to reach the log a user can send.
                    warn!(owner = %owner, error = %e, "Owner folder listing failed; their drives stay unknown");
                    Vec::new()
                }
            }
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    info!(owners = distinct.len(), drives = stats.len(), "Listed shared-drive stats");
    Ok(stats)
}

/// Leave a shared drive named by its WIRE identity.
///
/// The label-keyed [`leave_shared_drive`] resolves a local `sync_paths` row,
/// which a drive browsed but never synced here does not have — so leaving one
/// was impossible from the surface that lists it. Membership is server-side
/// and does not depend on a local copy; this deletes it either way, and
/// removes the local drive too when one happens to exist.
#[tauri::command]
pub async fn leave_shared_drive_by_identity(app: tauri::AppHandle, owner_ss58: String, folder_hash: String) -> Result<()> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;

    let leave = http_remove_member(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &folder_hash,
        &ctx.account_id,
        // ALWAYS named: the server's bare fallback deletes every same-hash
        // membership this account holds, and folder hashes are label-derived
        // so two owners' "Documents" drives collide as a matter of course.
        Some(&owner_ss58),
    )
    .await;
    match leave {
        Ok(()) => {}
        // The owner removed us first. The end state is the one asked for.
        Err(AppError::NotFound(_)) => {
            info!(owner = %owner_ss58, "Membership already gone server-side");
        }
        Err(other) => return Err(other),
    }

    // A drive that IS synced here still has to go from this device; one that
    // never was has nothing to remove and must not error for it.
    if let Some(row) = crate::sync::identity::member_row_for_wire_identity(state.pool()?, &ctx.account_id, &owner_ss58, &folder_hash).await? {
        crate::sync::lifecycle::remove_drive(app.clone(), row.label.clone()).await?;
        info!(label = %row.label, "Left shared drive and removed its local copy");
    } else {
        info!(owner = %owner_ss58, "Left shared drive that was not synced here");
    }
    Ok(())
}

#[tauri::command]
pub async fn leave_shared_drive(app: tauri::AppHandle, label: String) -> Result<()> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;

    let identity = crate::sync::identity::resolve_drive_identity(state.pool()?, &ctx.account_id, &label).await?;
    if !identity.is_member {
        return Err(AppError::Validation(format!(
            "'{label}' is your own drive — remove it from sync instead of leaving it"
        )));
    }

    let leave = http_remove_member(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &ctx.account_id,
        Some(&identity.wire_ss58),
    )
    .await;
    match leave {
        Ok(()) => {}
        Err(AppError::NotFound(_)) => {
            info!(label = %label, "Membership already gone server-side; proceeding with local removal");
        }
        Err(other) => return Err(other),
    }

    crate::sync::lifecycle::remove_drive(app.clone(), label.clone()).await?;
    info!(label = %label, "Left shared drive");
    Ok(())
}

/// Sync a drive that was shared with this account: open the grant, allocate a
/// local member drive row, install the owner's folder key, and start sync.
///
/// NO credit-eligibility gate: storage on a shared drive bills the OWNER
/// (`initialize_sync_inner` skips its credits pre-gate for member drives on
/// the same grounds; the server's per-request 402 stays the backstop).
#[tauri::command]
pub async fn add_shared_drive(
    app: tauri::AppHandle,
    owner_ss58: String,
    folder_hash: String,
    local_path: String,
    display_label: String,
) -> Result<AddSharedDriveResult> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let pool = state.pool()?;

    let member_identity = MemberDriveIdentity {
        owner_ss58: owner_ss58.clone(),
        wire_folder_hash: folder_hash.clone(),
    };
    member_identity.validate()?;
    if owner_ss58 == ctx.account_id {
        return Err(AppError::Validation(
            "This drive belongs to your own account — it is already yours to sync".into(),
        ));
    }
    if !std::path::Path::new(&local_path).is_dir() {
        return Err(AppError::Validation(format!(
            "Sync folder does not exist or is not a directory: {local_path}"
        )));
    }

    // 1. The grant: fetch this account's memberships and find the row.
    let memberships = http_list_memberships(&state.api_client.clone(), &ctx.base_url, &ctx.bearer).await?;
    let entry = memberships
        .memberships
        .into_iter()
        .find(|m| m.owner_ss58 == owner_ss58 && m.folder_hash == folder_hash)
        .ok_or_else(|| AppError::NotFound("No membership grant found for this drive — accept its invite first".into()))?;
    let grant_blob = base64::engine::general_purpose::STANDARD
        .decode(&entry.grant_blob)
        .map_err(|e| AppError::Crypto(format!("stored grant blob is not valid base64: {e}")))?;

    // 2. Open the grant and install the drive (row + sealed folder key), all
    //    under ONE `recovery_lock` scope: the master read, the drive-password
    //    decrypt, and the seal write must not interleave with a password
    //    rotation, or the seal lands under the old password. The Argon2id
    //    open (~1.5 s) is offloaded — never run a KDF on the runtime.
    let installed = {
        let _recovery_guard = state.recovery_lock.lock().await;
        let master = crate::sync::mnemonic::get_mnemonic_for_account(&state, &ctx.account_id).await?;

        let master_owned = Zeroizing::new(master.to_string());
        let member_ss58 = ctx.account_id.clone();
        let entropy = tokio::task::spawn_blocking(move || grant::open_grant(&master_owned, &member_ss58, &grant_blob))
            .await
            .map_err(|e| AppError::Other(format!("grant-open task failed to join: {e}")))??;

        // Re-encode as the folder-mnemonic phrase the drive engine unlocks
        // with — this is also the "entropy derives a valid mnemonic" check.
        let mnemonic =
            bip39::Mnemonic::from_entropy(entropy.as_ref()).map_err(|e| AppError::Crypto(format!("grant entropy is not a folder key: {e}")))?;
        let phrase = Zeroizing::new(mnemonic.to_string());

        install_member_drive(
            pool,
            MemberDriveInstall {
                account_id: &ctx.account_id,
                member: &member_identity,
                local_path: &local_path,
                display_label: &display_label,
                folder_phrase: &phrase,
                master_mnemonic: &master,
            },
        )
        .await?
    };
    let label = installed.label;

    // 3. Let the webview render files under the resolved root (the install's
    //    repair path may hand back an EXISTING row's path rather than the
    //    caller's pick), then run the normal init funnel (it resolves the
    //    member identity from the row and applies every member skip). Mirror
    //    add_local_sync_folder's immediate "Preparing sync…" mark so the
    //    widget appears within a tick of the user's action instead of after
    //    the indexing window.
    crate::sync::files::allow_asset_directory(&app, &installed.sync_path);

    let preparing = state.preparing.clone();
    let sync = state.sync.clone();
    if preparing.mark_preparing(&label) {
        sync.emit_snapshot(true);
    }
    if let Err(e) = crate::sync::lifecycle::initialize_sync_inner(app.clone(), ctx.account_id.clone(), label.clone(), None, true, false, None).await {
        if preparing.clear(&label) {
            sync.emit_snapshot(true);
        }
        // The row + seal stay: init failures here are usually transient
        // (network), and the drive resumes through the normal retry surfaces.
        warn!(label = %label, error = %e, "Shared drive added but initial sync init failed");
        return Err(e);
    }

    info!(label = %label, folder_hash = %folder_hash, "Shared drive added");
    Ok(AddSharedDriveResult { label })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The invite URL is the one channel the token + entropy legitimately
    // travel on. Parse it back: path carries the token, fragment decodes to
    // the exact entropy, and nothing else leaks in.
    #[test]
    fn invite_url_round_trips_token_and_entropy() {
        let mut entropy = [0u8; 32];
        for (i, b) in entropy.iter_mut().enumerate() {
            *b = i as u8;
        }

        let url = build_invite_url("https://console.example.com/", "tok_abc123", &entropy);
        let parsed = reqwest::Url::parse(&url).expect("invite URL must parse");
        assert_eq!(parsed.path(), "/invite/tok_abc123");

        let fragment = parsed.fragment().expect("fragment present");
        let key = fragment.strip_prefix("k=").expect("fragment is k=<entropy>");
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(key).expect("decodes");
        assert_eq!(decoded, entropy, "fragment must decode back to the entropy");
        assert!(!key.contains(['=', '+', '/']), "fragment must be base64url no-pad");
        assert!(parsed.query().is_none(), "no query string — the key rides the fragment only");
    }

    // Feature-off discriminator: an unmounted route's bare 404 maps to the
    // typed SharedDrivesUnavailable; a mounted route's JSON-enveloped 404 is
    // a domain NotFound; auth statuses map to Auth.
    #[test]
    fn classify_error_status_discriminates_feature_off_from_domain_404() {
        let bare = classify_error_status(reqwest::StatusCode::NOT_FOUND, "");
        assert!(
            matches!(bare, AppError::NotReady(NotReadyKind::SharedDrivesUnavailable)),
            "bare 404 must map to SharedDrivesUnavailable, got {bare:?}"
        );

        let domain = classify_error_status(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"error":"not_found","message":"No such member on this drive"}"#,
        );
        match domain {
            AppError::NotFound(msg) => assert_eq!(msg, "No such member on this drive"),
            other => panic!("JSON 404 must map to NotFound, got {other:?}"),
        }

        let auth = classify_error_status(reqwest::StatusCode::FORBIDDEN, r#"{"error":"forbidden","message":"nope"}"#);
        assert!(matches!(auth, AppError::Auth(_)), "403 must map to Auth, got {auth:?}");

        let server = classify_error_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "");
        assert!(matches!(server, AppError::Hcfs(_)), "500 must map to Hcfs, got {server:?}");
    }

    // The mint plan gate: a 403 carrying the `shared_drives_not_entitled` slug
    // is a NotReady the FE turns into an upgrade prompt, discriminated on the
    // SLUG — every other 403 stays Auth.
    #[test]
    fn classify_error_status_maps_not_entitled_slug_to_not_ready() {
        let not_entitled = classify_error_status(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":"shared_drives_not_entitled","message":"Shared drives need a Plus, Max, or Scale plan"}"#,
        );
        assert!(
            matches!(not_entitled, AppError::NotReady(NotReadyKind::SharedDrivesNotEntitled)),
            "403 shared_drives_not_entitled must map to NotReady, got {not_entitled:?}"
        );

        // A 403 with any other slug (or none) stays Auth — the message is not
        // consulted, only the slug.
        let suspended = classify_error_status(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":"account_suspended","message":"shared_drives_not_entitled"}"#,
        );
        assert!(
            matches!(suspended, AppError::Auth(_)),
            "a different 403 slug must stay Auth even if the message echoes the slug, got {suspended:?}"
        );
    }

    // The desktop invite policy: omitted parameters resolve to the named
    // constants (7 days / 50 uses), explicit values pass through untouched.
    // `http_create_invite` takes the resolved values (no Options), so this
    // resolver is the only place an omission can be interpreted.
    /// An omitted role must keep minting what every pre-picker build minted.
    #[test]
    fn omitted_invite_role_stays_writer() {
        assert_eq!(resolve_invite_role(None, 3600, 5).expect("omitted role"), "writer");
    }

    #[test]
    fn every_wire_role_is_accepted() {
        for role in WIRE_ROLES {
            assert_eq!(resolve_invite_role(Some(role.to_string()), 3600, 1).expect("wire role"), role);
        }
    }

    /// The server answers a bare 400 for an unknown role, which tells the user
    /// nothing about which choice it objected to.
    #[test]
    fn an_unknown_role_is_refused_by_name() {
        let err = resolve_invite_role(Some("admin".into()), 3600, 1).expect_err("unknown role");
        assert!(format!("{err}").contains("admin"), "the refusal must name the role: {err}");
    }

    /// A manager link minted for a week would be rejected AFTER the user had
    /// configured it. Both caps are refused here, each naming the cap.
    #[test]
    fn a_manager_invite_is_held_to_the_server_caps() {
        let too_many = resolve_invite_role(Some("manager".into()), 3600, 2).expect_err("uses cap");
        assert!(format!("{too_many}").contains("once"), "{too_many}");

        let too_long = resolve_invite_role(Some("manager".into()), MANAGER_INVITE_MAX_SECS + 1, 1).expect_err("ttl cap");
        assert!(format!("{too_long}").contains("24 hours"), "{too_long}");

        // Exactly at the cap is allowed — the caps ARE the defaults.
        assert_eq!(
            resolve_invite_role(Some("manager".into()), MANAGER_INVITE_MAX_SECS, MANAGER_INVITE_MAX_USES).expect("at the cap"),
            "manager"
        );
    }

    /// The caps bind managers only; a reader or writer link is unaffected.
    #[test]
    fn the_manager_caps_do_not_bind_other_roles() {
        for role in ["reader", "writer"] {
            assert_eq!(
                resolve_invite_role(Some(role.to_string()), MANAGER_INVITE_MAX_SECS * 7, 50).expect("wide link"),
                role
            );
        }
    }

    /// The desktop and the UI must not drift apart on the wire vocabulary.
    #[test]
    fn wire_roles_match_the_frontend_list() {
        assert_eq!(WIRE_ROLES, ["reader", "writer", "manager"]);
    }

    #[test]
    fn resolve_invite_policy_applies_desktop_defaults() {
        assert_eq!(
            resolve_invite_policy(None, None),
            (DEFAULT_INVITE_EXPIRES_IN_SECS, DEFAULT_INVITE_MAX_USES)
        );
        assert_eq!(resolve_invite_policy(None, None), (7 * 24 * 60 * 60, 50));
        assert_eq!(resolve_invite_policy(Some(3600), Some(5)), (3600, 5));
        assert_eq!(resolve_invite_policy(Some(3600), None), (3600, DEFAULT_INVITE_MAX_USES));
        assert_eq!(resolve_invite_policy(None, Some(5)), (DEFAULT_INVITE_EXPIRES_IN_SECS, 5));
    }

    // FE wire pin: the "Shared with me" row's camelCase keys, including the
    // local-sync join (`syncedLocally`/`localLabel`) Task 6 routes on. A
    // dropped or renamed key ships as a silently-undefined FE field, so the
    // key set is asserted exactly. `localLabel` stays present (null) when the
    // drive is not synced here — a stable shape, not a conditional key.
    #[test]
    fn drive_membership_info_wire_keys_are_pinned() {
        let info = DriveMembershipInfo {
            owner_ss58: "5Owner".to_string(),
            owner_name: Some("Ada".to_string()),
            folder_hash: "0123456789abcdef".to_string(),
            display_label: "team-docs".to_string(),
            role: "writer".to_string(),
            created_at: "2026-08-20T00:00:00Z".to_string(),
            synced_locally: false,
            local_label: None,
            member_count: Some(4),
            frozen: true,
            frozen_until: Some("2026-10-01T00:00:00Z".to_string()),
        };
        let json = serde_json::to_value(&info).expect("serialize");
        let keys: std::collections::BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "createdAt",
                "displayLabel",
                "folderHash",
                "frozen",
                "frozenUntil",
                "localLabel",
                "memberCount",
                "ownerName",
                "ownerSs58",
                "role",
                "syncedLocally"
            ]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
            "DriveMembershipInfo wire keys must stay exactly these camelCase names"
        );
        assert_eq!(
            json["localLabel"],
            serde_json::Value::Null,
            "an unsynced row serializes localLabel as null"
        );
        assert_eq!(json["ownerName"], "Ada");
        assert_eq!(json["memberCount"], 4);
        assert_eq!(json["frozen"], true);
    }

    #[test]
    fn drive_membership_info_omits_unknown_profile_fields() {
        let info = DriveMembershipInfo {
            owner_ss58: "5Owner".to_string(),
            owner_name: None,
            folder_hash: "0123456789abcdef".to_string(),
            display_label: "team-docs".to_string(),
            role: "writer".to_string(),
            created_at: "2026-08-20T00:00:00Z".to_string(),
            synced_locally: false,
            local_label: None,
            member_count: None,
            frozen: false,
            frozen_until: None,
        };
        let json = serde_json::to_value(&info).expect("serialize");
        let obj = json.as_object().expect("object");
        assert!(!obj.contains_key("ownerName"));
        assert!(!obj.contains_key("memberCount"));
        assert!(!obj.contains_key("frozen"), "unfrozen must omit the key");
        assert!(!obj.contains_key("frozenUntil"));
    }

    fn invite(valid: bool, revoked: bool) -> DriveInviteInfo {
        DriveInviteInfo {
            invite_id: "i".into(),
            role: "writer".into(),
            minted_by: String::new(),
            minted_by_name: None,
            expires_at: String::new(),
            max_uses: 1,
            use_count: 0,
            revoked,
            valid,
            created_at: String::new(),
        }
    }

    // The fold that decides whether a drive row carries the badge. Each case
    // is one way the row was wrong before it lived here.
    #[test]
    fn fold_counts_members_and_splits_live_from_total_invites() {
        let invites = [invite(true, false), invite(false, false), invite(false, true)];
        let s = fold_drive_sharing("team", Some(2), Some(&invites)).expect("answered");
        assert_eq!(s.label, "team");
        assert_eq!(s.member_count, 2);
        assert_eq!(s.live_invite_count, 1, "expired and revoked links do not admit anyone");
        assert_eq!(s.total_invite_count, 3, "but they still count as having shared the drive");
    }

    // `/invites` is newer than `/members`: a server carrying only the older
    // route must still describe the members it can see.
    #[test]
    fn fold_keeps_members_when_the_invite_listing_failed() {
        let s = fold_drive_sharing("team", Some(2), None).expect("answered");
        assert_eq!(s.member_count, 2);
        assert_eq!(s.live_invite_count, 0);
        assert_eq!(s.total_invite_count, 0);
    }

    #[test]
    fn fold_keeps_invites_when_the_member_listing_failed() {
        let invites = [invite(true, false)];
        let s = fold_drive_sharing("team", None, Some(&invites)).expect("answered");
        assert_eq!(s.member_count, 0);
        assert_eq!(s.total_invite_count, 1);
    }

    // Knowing nothing is not knowing the drive is private: an omitted drive
    // draws no badge AND no "not shared" claim.
    #[test]
    fn fold_omits_a_drive_when_both_listings_failed() {
        assert_eq!(fold_drive_sharing("team", None, None), None);
    }

    #[test]
    fn fold_reports_an_unshared_drive_as_answered_with_zeros() {
        let s = fold_drive_sharing("team", Some(0), Some(&[])).expect("answered");
        assert_eq!((s.member_count, s.live_invite_count, s.total_invite_count), (0, 0, 0));
    }

    fn own(hash: &str) -> crate::sync::identity::DriveIdentity {
        crate::sync::identity::DriveIdentity {
            wire_ss58: "5Me".into(),
            wire_folder_hash: hash.into(),
            is_member: false,
        }
    }

    fn member_of(owner: &str, hash: &str) -> crate::sync::identity::DriveIdentity {
        crate::sync::identity::DriveIdentity {
            wire_ss58: owner.into(),
            wire_folder_hash: hash.into(),
            is_member: true,
        }
    }

    // `folder_hash` is label-derived, so two owners who both name a drive
    // "Documents" collide. A delegated call that forgets the owner addresses
    // whichever row the server finds first.
    #[test]
    fn a_member_drive_delegates_by_naming_its_owner() {
        assert_eq!(delegated_owner(&member_of("5Owner", "abc")), Some("5Owner"));
    }

    // An owner's own call must NOT carry it: the server keys those by the
    // caller's identity, and naming yourself is a different code path.
    #[test]
    fn an_own_drive_names_nobody() {
        assert_eq!(delegated_owner(&own("abc")), None);
    }

    #[test]
    fn with_owner_appends_the_param_only_when_delegated() {
        let base = "https://s.example.com/v1/drives/abc/members";
        assert_eq!(with_owner(base, None).unwrap().as_str(), base);
        assert_eq!(with_owner(base, Some("5Owner")).unwrap().as_str(), format!("{base}?owner=5Owner"));
    }

    // An ss58 is alphanumeric, but the encoder must still be used rather than
    // string concatenation -- a param assembled by hand is one server-side
    // rename away from injecting into the query.
    #[test]
    fn with_owner_encodes_rather_than_concatenates() {
        let url = with_owner("https://s.example.com/v1/drives/abc/invites", Some("a&b=c")).unwrap();
        assert_eq!(url.query(), Some("owner=a%26b%3Dc"));
    }

    /// A manager may hold a drive they never synced here. Resolving a LOCAL
    /// label for one falls through to this account's own namespace, which
    /// manages the wrong drive rather than failing, so the caller may name
    /// the wire identity instead.
    #[tokio::test]
    async fn a_named_drive_is_managed_in_its_owners_namespace() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.expect("pool");
        let id = resolve_manage_target(&pool, "5Me", "team-docs", Some("5Owner".into()), Some("abc123".into()))
            .await
            .expect("identity");

        assert_eq!(id.wire_ss58, "5Owner");
        assert_eq!(id.wire_folder_hash, "abc123");
        assert!(id.is_member, "somebody else's drive is never own");
        assert_eq!(delegated_owner(&id), Some("5Owner"), "and it is named on the wire");
    }

    /// Half an identity must not fall through to the label: the lenient
    /// resolver would answer with this account's namespace.
    #[tokio::test]
    async fn half_a_named_identity_is_refused() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.expect("pool");
        for (owner, hash) in [
            (Some("5Owner".to_string()), None),
            (None, Some("abc123".to_string())),
            (Some(String::new()), Some("abc123".to_string())),
            (Some("5Owner".to_string()), Some("  ".to_string())),
        ] {
            assert!(
                resolve_manage_target(&pool, "5Me", "team-docs", owner, hash).await.is_err(),
                "half an identity must fail rather than resolve the label"
            );
        }
    }

    /// The bug: every HCFS response is wrapped in `NetworkResponse`, and this
    /// body was parsed straight into the result. No `folders` key at the top
    /// level, a `#[serde(default)]` behind it, and the answer came back as an
    /// empty list -- which on screen is a shared drive with no size, no file
    /// count and no date, exactly like an owner who shares nothing. Nothing
    /// errored and nothing logged above debug.
    #[test]
    fn list_folders_is_read_through_the_envelope() {
        let body = r#"{"Success":{"base_address":"5Owner","folders":[
            {"label":"team-docs","folder_hash":"abc123","file_count":5,
             "total_bytes":5890000,"created_at":1,"updated_at":2}
        ]}}"#;
        let folders = parse_list_folders(body).expect("envelope must parse");
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].folder_hash, "abc123");
        assert_eq!(folders[0].file_count, 5);
        assert_eq!(folders[0].total_bytes, 5_890_000);
    }

    /// An owner who genuinely shares nothing answers with an empty list, and
    /// that is a real answer rather than a parse failure.
    #[test]
    fn an_owner_with_no_drives_parses_as_empty() {
        let body = r#"{"Success":{"base_address":"5Owner","folders":[]}}"#;
        assert!(parse_list_folders(body).expect("must parse").is_empty());
    }

    /// The shape that used to pass silently. Reading the result level
    /// directly must now FAIL rather than answer "nothing shared".
    #[test]
    fn an_unwrapped_body_is_refused_rather_than_read_as_empty() {
        let body = r#"{"base_address":"5Owner","folders":[]}"#;
        assert!(
            parse_list_folders(body).is_err(),
            "a body at the wrong level must fail loudly, not look like an empty account"
        );
    }

    /// A server error is an error, not an owner without drives.
    #[test]
    fn a_server_error_is_not_an_empty_listing() {
        let body = r#"{"Error":{"error":"unauthorized","message":"nope"}}"#;
        let err = parse_list_folders(body).expect_err("must not read as empty");
        assert!(format!("{err}").contains("nope"), "the server's words reach the log");
    }

    // The bug this pins: every multi-word field crossed IPC as snake_case
    // while the renderer read camelCase, so the Links tab showed "undefined
    // of undefined used" against a perfectly correct role and revoked state.
    #[test]
    fn drive_invite_info_reaches_the_frontend_in_camel_case() {
        let json = serde_json::to_value(invite(true, false)).unwrap();
        let keys = json.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            [
                "createdAt",
                "expiresAt",
                "inviteId",
                "maxUses",
                "mintedBy",
                "revoked",
                "role",
                "useCount",
                "valid"
            ]
            .into_iter()
            .map(String::from)
            .collect::<std::collections::BTreeSet<_>>(),
            "DriveInviteInfo wire keys must stay exactly these camelCase names when minted_by_name is absent"
        );
    }

    // ...while still reading the server's snake_case on the way in. Both
    // halves matter: this one type is the response shape AND the wire shape.
    #[test]
    fn drive_invite_info_still_parses_the_servers_snake_case() {
        let parsed: DriveInviteInfo = serde_json::from_str(
            r#"{"invite_id":"abc","role":"writer","expires_at":"2126-01-01T00:00:00Z",
                "max_uses":50,"use_count":2,"revoked":false,"valid":true,
                "created_at":"2026-01-01T00:00:00Z"}"#,
        )
        .expect("the server's spelling must still deserialize");
        assert_eq!(parsed.invite_id, "abc");
        assert_eq!(parsed.use_count, 2);
        assert_eq!(parsed.max_uses, 50);
        assert_eq!(parsed.expires_at, "2126-01-01T00:00:00Z");
    }

    // Wire pin: `useOwnedDriveSharing` reads these names and there is no
    // codegen across IPC to catch a rename.
    #[test]
    fn drive_sharing_summary_wire_keys_are_camel_case() {
        let json = serde_json::to_value(DriveSharingSummary {
            label: "team".into(),
            member_count: 1,
            live_invite_count: 2,
            total_invite_count: 3,
        })
        .unwrap();
        let keys = json.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            ["label", "liveInviteCount", "memberCount", "totalInviteCount"]
                .into_iter()
                .map(String::from)
                .collect::<std::collections::BTreeSet<_>>(),
        );
    }
}
