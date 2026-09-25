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
use hcfs_shared::network::{CreateDriveInviteRequest, DriveMembersResponse, DriveMembershipsResponse};
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

/// The roles this client offers and sends, in the server's spelling: Viewer
/// (`reader`) and Editor (`writer`). Kept in step with `DRIVE_ROLES` in
/// `app/lib/shared-drives/roles.ts`.
///
/// The server also knows `manager`. This client never offers it and never
/// sends it: only a drive's owner invites and removes people. A `manager` the
/// server still returns for an existing member reads as `writer`
/// ([`drive_role_from_wire`]).
pub(crate) const WIRE_ROLES: [&str; 2] = ["reader", "writer"];

/// The refusal for any role outside [`WIRE_ROLES`], `manager` included.
pub(crate) const DRIVE_ROLE_ONLY: &str = "Viewer or Editor only.";

/// Refuse a role this client does not send, before any request is made.
///
/// Every path that puts a role on the wire (the link mint, the emailed
/// invite, the role change) goes through this, so `manager` can never be
/// sent even by a caller that bypasses the pickers.
pub(crate) fn require_offered_role(role: &str) -> Result<()> {
    if WIRE_ROLES.contains(&role) {
        Ok(())
    } else {
        Err(AppError::Validation(DRIVE_ROLE_ONLY.into()))
    }
}

/// A whole-drive role as it comes off the wire, as this client shows and
/// gates it.
///
/// The server may still return `manager` for a member made one before this
/// client dropped the role. That member keeps what an Editor can do (open,
/// upload, delete, share a folder by link) and reads as an Editor everywhere,
/// so the UI never receives `manager`. Anything else passes through; the UI
/// reads an unknown role as a Viewer.
pub(crate) fn drive_role_from_wire(raw: &str) -> String {
    match raw.trim() {
        "manager" => "writer".to_string(),
        other => other.to_string(),
    }
}

/// Resolve the role an invite is minted for.
///
/// An omitted role keeps the historical `writer`, so a caller that predates
/// the picker mints exactly what it always did. Anything but Viewer or Editor
/// is refused (see [`require_offered_role`]).
pub(crate) fn resolve_invite_role(role: Option<String>) -> Result<String> {
    let role = role.unwrap_or_else(|| "writer".to_string());
    require_offered_role(&role)?;
    Ok(role)
}

/// Resolve the caller's optional invite parameters against the desktop
/// policy defaults. Extracted (rather than inline `unwrap_or`s) so the
/// policy is unit-testable; [`create_drive_invite`] routes through it and
/// [`http_create_invite`] takes the resolved values, so no call path can
/// send an omitted field.
fn resolve_invite_policy(expires_in_secs: Option<u64>, max_uses: Option<u32>) -> (u64, u32) {
    (
        expires_in_secs.unwrap_or(DEFAULT_INVITE_EXPIRES_IN_SECS),
        max_uses.unwrap_or(DEFAULT_INVITE_MAX_USES),
    )
}

/// Keep a real display string; drop blank/whitespace so the FE never draws a
/// gap where an ss58 fallback belonged (hcfs #455 / console `presentText`).
pub(crate) fn present_text(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// [`present_text`] for an email: also drops a system placeholder
/// (`@hippius.local`), so the row falls back to the name, then the address.
pub(crate) fn present_email(value: Option<String>) -> Option<String> {
    crate::utils::display_email::display_email(value.as_deref())
}

/// Forward a server `member_count` of 0/omitted as `None` so the FE never
/// draws "0 members" from an unknown or empty listing signal.
fn present_member_count(count: u64) -> Option<u32> {
    if count == 0 { None } else { u32::try_from(count).ok() }
}

// ─── FE-facing wire types (camelCase, desktop-owned) ───────────────────────

/// Result of a successful invite mint. The URL embeds the invite token (path)
/// and the folder-key entropy (`#k=` fragment) — the ONLY channel either
/// secret crosses IPC on.
///
/// The policy fields are what was actually SENT, after the defaults and the
/// folder caps: the Share dialog describes the link from these, so
/// it can never quote a lifetime or a uses count the server was not asked for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInviteLink {
    pub invite_url: String,
    /// The server's id for the new invite (the blake3 hash of its token, never
    /// the token), so the Share dialog can revoke the link it just made.
    pub invite_id: String,
    /// `reader` or `writer`.
    pub role: String,
    pub expires_in_secs: u64,
    /// Always 1 for a folder link.
    pub max_uses: u32,
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
    /// Email, only disclosed to the drive's owner. Same absence rules.
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
pub(crate) fn classify_error_status(status: reqwest::StatusCode, body: &str) -> AppError {
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

    // Folder-grant mint / replace: some files under the folder have paths the
    // server cannot trust to place them there. Match the slug, never English.
    if status.as_u16() == 409 && envelope.as_ref().is_some_and(|env| env.error == "folder_paths_unreliable") {
        return AppError::Validation("Some files in this folder need repair before it can be shared.".into());
    }
    if status.as_u16() == 409 && envelope.as_ref().is_some_and(|env| env.error == "overlapping_folder_grant") {
        return AppError::Validation("This person already has access to this folder, a folder inside it, or a folder around it.".into());
    }
    if status.as_u16() == 409 && envelope.as_ref().is_some_and(|env| env.error == "already_member") {
        return AppError::Validation("This person already has access to the whole drive.".into());
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
/// precedent, once the list outgrew a readable positional call.
///
/// There is no owner field: only a drive's owner mints, and the server reads
/// an omitted `owner_ss58` as caller-as-owner.
pub struct MintInvite<'a> {
    pub folder_hash: &'a str,
    pub expires_in_secs: u64,
    pub max_uses: u32,
    /// `reader` or `writer`; anything else is refused before the request.
    pub role: &'a str,
    /// Drive-relative folder for a folder invite. `None` = whole-drive invite.
    /// When set, the response MUST echo it or the mint is refused (an older
    /// server ignoring the field would mint a whole-drive invite).
    pub path_prefix: Option<&'a str>,
}

/// Token + invite id from a successful mint. The id is `hex(blake3(token))`;
/// when the server omits it (older builds) we compute it locally so seal-back
/// still has a row to park against.
#[derive(Debug)]
pub struct MintedInvite {
    pub token: String,
    pub invite_id: String,
}

pub async fn http_create_invite(http: &reqwest::Client, base_url: &str, bearer: &str, mint: MintInvite<'_>) -> Result<MintedInvite> {
    let MintInvite {
        folder_hash,
        expires_in_secs,
        max_uses,
        role,
        path_prefix,
    } = mint;
    // Belt and braces behind the command's own check: `manager` never
    // reaches the wire, whoever calls this.
    require_offered_role(role)?;
    // `Some("")` would read as a folder invite here and as no folder at all
    // on the wire. Refused before anything is sent.
    if path_prefix.is_some_and(|p| p.trim_matches('/').is_empty()) {
        return Err(AppError::Validation(
            "A folder invite needs a folder path; it cannot cover the whole drive.".into(),
        ));
    }
    let req = CreateDriveInviteRequest {
        folder_hash: folder_hash.to_string(),
        // Only the owner mints, and the server reads `None` as
        // caller-as-owner.
        owner_ss58: None,
        expires_in_secs: Some(expires_in_secs),
        max_uses: Some(max_uses),
        // Sent explicitly rather than omitted. An omitted role means `writer`
        // server-side, which is what every build before the picker minted --
        // fine as a default, wrong as a silent one now that the user chooses.
        role: Some(role.to_string()),
        path_prefix: path_prefix.map(str::to_string),
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
        // A folder mint's refusals ("coming soon") are told apart by message;
        // the folder module owns that mapping.
        if path_prefix.is_some()
            && let Some(err) = super::folder_roles::classify_folder_invite_refusal(status, &body)
        {
            return Err(err);
        }
        return Err(classify_error_status(status, &body));
    }
    // Prefer a local shape: hcfs-shared's `CreateDriveInviteResponse` may
    // lag `invite_id`, and seal-back needs the id either way. Fall back to
    // blake3(token) when the server omits it.
    #[derive(serde::Deserialize)]
    struct MintBody {
        invite_token: String,
        #[serde(default)]
        invite_id: Option<String>,
        #[serde(default)]
        path_prefix: Option<String>,
    }
    let parsed: MintBody = serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("create-invite response did not parse: {e}")))?;
    let invite_id = parsed
        .invite_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| super::invite_token::invite_id_for_token(&parsed.invite_token));
    // A folder mint MUST see its path_prefix echoed. A server that ignored the
    // field minted a WHOLE-DRIVE invite: its token never leaves this function,
    // it is revoked on the spot (best effort), and the user is told folder
    // sharing is coming soon. Never handed back as if it were the folder's.
    if let Some(asked) = path_prefix
        && parsed.path_prefix.as_deref() != Some(asked)
    {
        if let Err(e) = http_revoke_invite(http, base_url, bearer, folder_hash, &invite_id).await {
            warn!(error = %e, "could not revoke a whole-drive invite minted in place of a folder invite");
        }
        return Err(AppError::NotReady(NotReadyKind::FolderInvitesUnavailable));
    }
    Ok(MintedInvite {
        token: parsed.invite_token,
        invite_id,
    })
}

/// `PUT /v1/drives/{fh}/invites/{id}/sealed-token` — park the token sealed
/// under the drive key so the Links tab can rebuild the URL later.
///
/// WRITE-ONCE server-side; only the invite's minter may call it. Callers
/// treat failure as cosmetic (console `sealMintedToken`).
pub async fn http_put_sealed_token(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    invite_id: &str,
    sealed_token: &str,
) -> Result<()> {
    let resp = http
        .put(format!(
            "{}/v1/drives/{}/invites/{}/sealed-token",
            base_url.trim_end_matches('/'),
            folder_hash,
            invite_id
        ))
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&serde_json::json!({ "sealed_token": sealed_token }))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("seal-token request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_error_status(status, &body));
    }
    Ok(())
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
    let body = super::folder_roles::default_missing_grant_roles(&body);
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
/// targeting themselves with a 400; a member leaves through the member
/// DELETE instead.
///
/// A downward change is sticky: the server also revokes the invite that
/// admitted the member when that link still outranks the new role. Nothing
/// here has to arrange that; it matters when explaining the result to the
/// user.
///
/// Only the owner changes roles, so no `?owner=` is ever sent, and `role` is
/// Viewer or Editor only: `manager` is refused before the request.
pub async fn http_change_member_role(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    member_ss58: &str,
    role: &str,
) -> Result<()> {
    require_offered_role(role)?;
    let url = reqwest::Url::parse(&format!(
        "{}/v1/drives/{}/members/{}",
        base_url.trim_end_matches('/'),
        folder_hash,
        member_ss58
    ))
    .map_err(|e| AppError::Hcfs(format!("invalid change-role URL: {e}")))?;

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
    /// Who minted it: the owner, or (for an older link) a member the server
    /// once let invite. Empty for
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
    /// Token sealed under the drive key (hcfs #457/#458). Read from the
    /// server listing; never serialized to the FE — only the rebuilt
    /// `invite_url` crosses IPC.
    #[serde(default, alias = "sealed_token", skip_serializing)]
    pub sealed_token: Option<String>,
    /// Full invite URL when `sealed_token` opened under this session's drive
    /// key. FE truncates and strips `#k=` for display; copy uses the full
    /// string. Absent when there is no blob, the invite is dead, or open
    /// failed (locked stand-in).
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub invite_url: Option<String>,
    /// True when the listing carried a sealed blob for a still-valid invite.
    /// The FE shows the link field; `invite_url` fills it or the locked
    /// stand-in when absent.
    #[serde(default, skip_deserializing, skip_serializing_if = "std::ops::Not::not")]
    pub link_available: bool,
    /// Folder of a folder invite; absent for a whole-drive invite. The Links
    /// tab must show it, or a folder invite reads as access to everything.
    #[serde(default, alias = "path_prefix", skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    /// Where a MAILED invitation was sent (hcfs #459). Absent on a link
    /// invite, on an expired mailed one (the sweep erases it), and for a
    /// caller who may not read the row's management data.
    #[serde(default, alias = "recipient_email", skip_serializing_if = "Option::is_none")]
    pub recipient_email: Option<String>,
    /// How far a mailed invitation has got: `sent`, `awaiting_seal` or
    /// `sealed`. Anything else is dropped by [`normalize_invite_fields`], so
    /// the FE only ever sees the three it knows. The approve action keys on
    /// this, never on `requester_pubkey` being present.
    #[serde(default, alias = "email_status", skip_serializing_if = "Option::is_none")]
    pub email_status: Option<String>,
    /// The account that claimed a mailed invitation. Shown on the row so an
    /// owner can see who they are approving.
    #[serde(default, alias = "requester_ss58", skip_serializing_if = "Option::is_none")]
    pub requester_ss58: Option<String>,
    /// The recipient's ephemeral X25519 key. Read from the server for the
    /// approve path only; never serialized to the FE, which approves by id
    /// and lets Rust re-read the row.
    #[serde(default, alias = "requester_pubkey", skip_serializing)]
    pub requester_pubkey: Option<String>,
}

/// The mailed-invite stages this build understands.
pub(crate) const EMAIL_STATUSES: [&str; 3] = ["sent", "awaiting_seal", "sealed"];

/// Trim the mailed-invite fields and drop a stage this build does not know,
/// the console's `isEmailStatus` rule. A blank email is absent, not an empty
/// line on the row. An older link minted as `manager` reads as `writer`
/// ([`drive_role_from_wire`]).
fn normalize_invite_fields(invite: &mut DriveInviteInfo) {
    invite.role = drive_role_from_wire(&invite.role);
    invite.recipient_email = present_email(invite.recipient_email.take());
    invite.requester_ss58 = present_text(invite.requester_ss58.take());
    invite.email_status = invite.email_status.take().filter(|s| EMAIL_STATUSES.contains(&s.as_str()));
}

#[derive(Debug, Deserialize)]
struct DriveInvitesResponse {
    #[serde(default)]
    invites: Vec<DriveInviteInfo>,
}

/// `GET /v1/drives/{folder_hash}/invites` — the live invites for a drive.
/// Only ever asked about the caller's own drive, so no `?owner=`.
pub async fn http_list_invites(http: &reqwest::Client, base_url: &str, bearer: &str, folder_hash: &str) -> Result<Vec<DriveInviteInfo>> {
    let resp = http
        .get(format!("{}/v1/drives/{}/invites", base_url.trim_end_matches('/'), folder_hash))
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
pub async fn http_revoke_invite(http: &reqwest::Client, base_url: &str, bearer: &str, folder_hash: &str, invite_id: &str) -> Result<()> {
    let resp = http
        .delete(format!(
            "{}/v1/drives/{}/invites/{}",
            base_url.trim_end_matches('/'),
            folder_hash,
            invite_id
        ))
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
    let body = super::folder_roles::default_missing_grant_roles(&body);
    serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("list-memberships response did not parse: {e}")))
}

// ─── Shared command plumbing ───────────────────────────────────────────────

/// The resolved account + connection triple every command needs.
pub(crate) struct ApiCtx {
    account_id: String,
    base_url: String,
    bearer: String,
}

impl ApiCtx {
    /// The concrete regional base URL, for callers outside this module that
    /// issue their own requests (the member folder-share mint).
    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The session's API bearer. A credential: never log it.
    pub(crate) fn bearer(&self) -> &str {
        &self.bearer
    }
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

/// Append `?owner=` when a read names somebody else's drive.
///
/// One helper rather than a `query_pairs_mut` block per endpoint: the param
/// is what makes a member's read address the right drive, and a route that
/// quietly forgets it falls back to a `folder_hash` that collides across
/// owners who both named a drive the same thing.
fn with_owner(url: &str, owner: Option<&str>) -> Result<reqwest::Url> {
    let mut parsed = reqwest::Url::parse(url).map_err(|e| AppError::Hcfs(format!("invalid shared-drive URL: {e}")))?;
    if let Some(owner) = owner {
        parsed.query_pairs_mut().append_pair("owner", owner);
    }
    Ok(parsed)
}

/// Resolve the drive an access call addresses: an own drive, or a drive
/// shared with this account.
///
/// A member may hold a drive they have never synced here, and every access
/// command resolved a LOCAL label, which for such a drive resolves to
/// nothing, and the lenient fallback then answers with THIS account's
/// namespace. So the caller may name the wire identity instead, exactly as
/// browsing does. Naming this account as the owner is an own drive.
///
/// Half an identity is refused rather than guessed: falling through to the
/// label would address the wrong drive instead of failing.
///
/// Admits a member drive, so it is the gate for READS only (who has access,
/// the panel). Anything that changes access goes through
/// [`resolve_owned_target`].
async fn resolve_access_target(
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
                    "A shared drive is named by both its owner and its folder hash.".into(),
                ));
            }
            Ok(crate::sync::identity::DriveIdentity {
                wire_ss58: owner.to_string(),
                wire_folder_hash: hash.to_string(),
                // Somebody else's drive unless it names this account; the flag
                // is what makes `member_owner` name them on the wire.
                is_member: owner != account_id,
            })
        }
        (None, Some(_)) | (Some(_), None) => Err(AppError::Validation(
            "A shared drive is named by both its owner and its folder hash.".into(),
        )),
        (None, None) => crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, label).await,
    }
}

/// The refusal for any access change on a drive this account does not own.
pub(crate) const OWNER_ONLY: &str = "Only the drive's owner can invite and remove people.";

/// Resolve the drive an access CHANGE addresses, and require it to be this
/// account's own.
///
/// Only a drive's owner invites, removes people, changes roles, revokes or
/// approves invites and changes folder grants. The server still admits a
/// member it made a `manager` to do some of that on the owner's behalf; this
/// client does not, so a member drive is refused here, before any key is read
/// or any request is made.
pub(crate) async fn resolve_owned_target(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    label: &str,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<crate::sync::identity::DriveIdentity> {
    let identity = resolve_access_target(pool, account_id, label, owner_ss58, folder_hash).await?;
    if identity.is_member {
        return Err(AppError::Validation(OWNER_ONLY.into()));
    }
    Ok(identity)
}

/// The `owner` a member's read must name, or `None` for an own drive where
/// the server keys by the caller's own identity.
///
/// A member drive's `wire_ss58` IS the owner's address: pass it and the read
/// addresses the right drive; omit it and `folder_hash` alone collides across
/// owners who both named a drive the same thing.
fn member_owner(identity: &crate::sync::identity::DriveIdentity) -> Option<&str> {
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

/// What a grant held by this account opens to.
pub(crate) enum MemberKey {
    /// A whole-drive membership: the drive's folder-mnemonic entropy.
    DriveEntropy(Zeroizing<[u8; 32]>),
    /// A folder grant: only the folder's DERIVED file key (folder roles,
    /// assumption 7 in `folder_roles`).
    FolderFileKey(Zeroizing<[u8; 32]>),
}

/// This account's key for a drive it does not own, from the grant the server
/// holds for it.
///
/// `pub(crate)` for `sync::fileops::remote`, which needs the same key to
/// upload into a shared drive that was never synced here.
///
/// The local seal is the usual source, but a drive that was never synced here
/// has none — and refusing on that basis made managing a drive conditional on
/// copying it to this machine. The grant blob carries the same key, sealed to
/// this account, so it is opened directly. A whole-drive membership wins; a
/// FOLDER grant on the drive is the fallback, and opens to the derived file
/// key rather than entropy.
///
/// Argon2id at grant cost is multi-second, so the open is offloaded; running a
/// KDF on the runtime stalls every other IPC.
pub(crate) async fn open_member_key_inner(state: &AppState, ctx: &ApiCtx, identity: &crate::sync::identity::DriveIdentity) -> Result<MemberKey> {
    let memberships = http_list_memberships(&state.api_client.clone(), &ctx.base_url, &ctx.bearer).await?;
    let (grant_b64, folder) = pick_member_grant(&memberships, &identity.wire_ss58, &identity.wire_folder_hash)?;

    let grant_blob = base64::engine::general_purpose::STANDARD
        .decode(grant_b64)
        .map_err(|e| AppError::Crypto(format!("grant blob is not valid base64: {e}")))?;

    let master = crate::sync::mnemonic::get_mnemonic_for_account(state, &ctx.account_id).await?;
    let master_owned = Zeroizing::new(master.to_string());
    let member_ss58 = ctx.account_id.clone();
    let key = tokio::task::spawn_blocking(move || grant::open_grant(&master_owned, &member_ss58, &grant_blob))
        .await
        .map_err(|e| AppError::Other(format!("grant-open task failed to join: {e}")))??;
    Ok(if folder {
        MemberKey::FolderFileKey(key)
    } else {
        MemberKey::DriveEntropy(key)
    })
}

/// Which grant blob to open for `(owner, hash)`: the whole-drive membership
/// when there is one, else the first folder grant on that drive that carries
/// a blob (every folder grant on a drive seals the same derived key). The
/// flag says which it was. Pure, so the precedence is testable.
pub(crate) fn pick_member_grant<'a>(
    memberships: &'a hcfs_shared::network::DriveMembershipsResponse,
    owner_ss58: &str,
    folder_hash: &str,
) -> Result<(&'a str, bool)> {
    if let Some(m) = memberships
        .memberships
        .iter()
        .find(|m| m.owner_ss58 == owner_ss58 && m.folder_hash == folder_hash)
    {
        return Ok((m.grant_blob.as_str(), false));
    }
    memberships
        .folder_grants
        .iter()
        .find(|g| g.owner_ss58 == owner_ss58 && g.folder_hash == folder_hash && !g.grant_blob.is_empty())
        .map(|g| (g.grant_blob.as_str(), true))
        .ok_or_else(|| AppError::Validation("You are no longer a member of this drive.".into()))
}

/// What an invite link admits to.
enum InviteScope {
    /// The whole drive. `max_uses` is the caller's (policy default otherwise).
    Drive { max_uses: Option<u32> },
    /// One folder, by its VIEW-relative path (rooted at a grant when the
    /// label browses one). Never empty once planned.
    Folder { path: String },
}

/// Mint an invite link for a WHOLE drive this account owns.
///
/// The link is assembled here, in Rust: the invite token and the fragment
/// key exist nowhere else -- not in logs, not in another IPC response --
/// and the FE only copies the finished URL to the clipboard.
///
/// A folder is never shared through this command: that is
/// [`create_folder_invite`], which cannot send a request without a folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC surface: invite fields + the drive target
pub async fn create_drive_invite(
    app: tauri::AppHandle,
    label: String,
    expires_in_secs: Option<u64>,
    max_uses: Option<u32>,
    role: Option<String>,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<DriveInviteLink> {
    // A granted folder is not the drive; minting the drive from inside one
    // would hand out more than this account holds.
    if crate::sync::identity::folder_grant_browse(&label).is_some() {
        return Err(AppError::Validation("From a shared folder you can only share that folder.".into()));
    }
    let state = app.state::<AppState>();
    mint_invite_link(
        &state,
        &label,
        owner_ss58,
        folder_hash,
        expires_in_secs,
        role,
        InviteScope::Drive { max_uses },
    )
    .await
}

/// Mint a FOLDER invite link: one person, one folder, at most 30 days.
///
/// `path_prefix` is required and validated before any request, so a folder
/// share can never go out as a whole-drive invite; the fragment carries the
/// folder's DERIVED file key (never drive entropy), and a response that does
/// not echo the folder is revoked and refused (`folder_roles`). Refusals the
/// server words as "not enabled" come back as structured "coming soon" kinds.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC surface: invite fields + the drive target
pub async fn create_folder_invite(
    app: tauri::AppHandle,
    label: String,
    path_prefix: String,
    expires_in_secs: Option<u64>,
    role: Option<String>,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<DriveInviteLink> {
    let state = app.state::<AppState>();
    mint_invite_link(
        &state,
        &label,
        owner_ss58,
        folder_hash,
        expires_in_secs,
        role,
        InviteScope::Folder { path: path_prefix },
    )
    .await
}

/// The one mint funnel behind both invite commands. Owner only.
async fn mint_invite_link(
    state: &AppState,
    label: &str,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
    expires_in_secs: Option<u64>,
    role: Option<String>,
    scope: InviteScope,
) -> Result<DriveInviteLink> {
    // The role first, before the session, the key or the network: a
    // `manager` (or any role this client does not offer) is refused here.
    let role = match &scope {
        InviteScope::Drive { .. } => Some(resolve_invite_role(role)?),
        InviteScope::Folder { .. } => role,
    };
    let ctx = api_ctx(state).await?;
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, label, owner_ss58, folder_hash).await?;

    // Resolve the policy BEFORE touching the key or the network: a folder
    // with no path is refused here, not sent.
    let (secs, _) = resolve_invite_policy(expires_in_secs, None);
    let (folder_prefix, expires_in_secs, max_uses, role_owned) = match scope {
        InviteScope::Folder { path } => {
            // `rooted_path` puts a browsed grant in front (identity for an
            // ordinary drive).
            let plan = super::folder_roles::plan_folder_invite(&crate::sync::identity::rooted_path(label, &path), role, secs)?;
            let caps = crate::shares::capabilities::fetch_capabilities(state, &ctx.account_id).await?;
            super::folder_roles::require_server_knows_folder_invites(&caps)?;
            (Some(plan.path_prefix), plan.expires_in_secs, plan.max_uses, plan.role)
        }
        InviteScope::Drive { max_uses } => {
            let (secs, uses) = resolve_invite_policy(expires_in_secs, max_uses);
            (None, secs, uses, resolve_invite_role(role)?)
        }
    };

    // Fragment key material. Whole-drive invites carry folder-mnemonic
    // ENTROPY; folder invites carry the DERIVED file key (`seed[..32]`).
    // Mixing them up would hand a grant holder the wrong kind of key.
    // A folder grant holder has only the derived key, which is exactly what
    // a folder invite carries and never enough for a whole-drive one.
    let fragment_key: Zeroizing<[u8; 32]> = {
        let _recovery_guard = state.recovery_lock.lock().await;
        let mnemonic = crate::sync::remote::session_mnemonic(state)?;
        let material = crate::sync::remote::drive_key_material_for_label(state, &ctx.account_id, label, &mnemonic, &identity).await?;
        sealed_invite_payload(material, folder_prefix.is_some())?
    };

    let http = state.api_client.clone();
    let minted = http_create_invite(
        &http,
        &ctx.base_url,
        &ctx.bearer,
        MintInvite {
            folder_hash: &identity.wire_folder_hash,
            expires_in_secs,
            max_uses,
            role: &role_owned,
            path_prefix: folder_prefix.as_deref(),
        },
    )
    .await?;

    // Best-effort seal-back: seal under the SAME key the link fragment uses
    // so the Links tab rebuilds the correct `#k=` on open.
    if let Ok(sealed) = super::invite_token::seal_invite_token(fragment_key.as_ref(), &minted.invite_id, &minted.token) {
        let _ = http_put_sealed_token(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash, &minted.invite_id, &sealed).await;
    }

    let invite_url = build_invite_url(&crate::shares::commands::console_base_url(), &minted.token, &fragment_key);

    info!(
        label = %label,
        folder_hash = %identity.wire_folder_hash,
        path_prefix = folder_prefix.as_deref().unwrap_or(""),
        "Drive invite minted"
    );
    Ok(DriveInviteLink {
        invite_url,
        invite_id: minted.invite_id.clone(),
        role: role_owned,
        expires_in_secs,
        max_uses,
    })
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
    let identity = resolve_access_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    let resp = http_list_members(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        member_owner(&identity),
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
            role: drive_role_from_wire(&m.role),
            created_at: m.created_at,
            member_name: present_text(m.member_name),
            member_email: present_email(m.member_email),
        })
        .collect())
}

/// Everyone with access to what the Share dialog is sharing, folded in Rust
/// so the dialog never decides who belongs to a drive or a folder.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAccess {
    /// The drive's owner, who is never in `members`.
    pub owner_ss58: String,
    pub owner_is_you: bool,
    /// Whole-drive members. Drive target only; empty for a folder.
    pub members: Vec<ShareAccessMember>,
    /// Folder target only: one row per person holding a grant at or above
    /// the folder (so a holder of `Clients` has access to `Clients/ACME`).
    pub folder_holders: Vec<ShareAccessHolder>,
    /// Emailed invitations still waiting for this target: whole-drive ones for
    /// a drive, ones for exactly this folder for a folder. Live only.
    pub pending_invites: Vec<DriveInviteInfo>,
    /// People with whole-drive access, so a folder dialog can say that they
    /// can open the folder too.
    pub drive_member_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAccessMember {
    pub member_ss58: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_email: Option<String>,
    /// This account: its own role is not changeable here (a member leaves).
    pub is_you: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAccessHolder {
    pub member_ss58: String,
    /// `reader` or `writer`, of the grant that gives them this folder.
    pub role: String,
    /// That grant's folder: this one, or a folder it sits inside.
    pub path_prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_email: Option<String>,
    /// Folders on this drive they hold besides that one. Removing their access
    /// removes those too, and the confirmation has to say so.
    pub other_folder_count: usize,
}

/// Fold the member listing and the invite listing into what one Share dialog
/// shows. `folder` is the drive-relative folder being shared, `None` for the
/// whole drive. Pure, so the membership rules are unit-tested.
pub(crate) fn fold_share_access(
    account_id: &str,
    owner_ss58: &str,
    folder: Option<&str>,
    listing: DriveMembersResponse,
    invites: Vec<DriveInviteInfo>,
) -> ShareAccess {
    use super::folder_grant_path::prefix_covers;

    let drive_member_count = listing.members.len();
    let members = if folder.is_some() {
        Vec::new()
    } else {
        listing
            .members
            .into_iter()
            .map(|m| ShareAccessMember {
                is_you: m.member_ss58 == account_id,
                member_ss58: m.member_ss58,
                role: drive_role_from_wire(&m.role),
                member_name: present_text(m.member_name),
                member_email: present_email(m.member_email),
            })
            .collect()
    };

    let mut folder_holders: Vec<ShareAccessHolder> = Vec::new();
    if let Some(folder) = folder {
        for grant in &listing.folder_grants {
            if !prefix_covers(&grant.path_prefix, folder) {
                continue;
            }
            let held = listing.folder_grants.iter().filter(|g| g.member_ss58 == grant.member_ss58).count();
            let row = ShareAccessHolder {
                member_ss58: grant.member_ss58.clone(),
                role: super::folder_roles::grant_role(Some(&grant.role)),
                path_prefix: grant.path_prefix.clone(),
                member_name: present_text(grant.member_name.clone()),
                member_email: present_email(grant.member_email.clone()),
                other_folder_count: held.saturating_sub(1),
            };
            match folder_holders.iter_mut().find(|h| h.member_ss58 == row.member_ss58) {
                // Two grants cover the folder (a parent and the folder itself):
                // the nearer one is the one that describes their access here.
                Some(existing) if row.path_prefix.len() > existing.path_prefix.len() => *existing = row,
                Some(_) => {}
                None => folder_holders.push(row),
            }
        }
    }

    let pending_invites = invites
        .into_iter()
        .map(|mut i| {
            i.role = drive_role_from_wire(&i.role);
            i
        })
        .filter(|i| i.valid && !i.revoked && i.email_status.is_some())
        .filter(|i| match (folder, i.path_prefix.as_deref().map(|p| p.trim_matches('/'))) {
            (None, None) => true,
            (None, Some(p)) => p.is_empty(),
            (Some(f), Some(p)) => p == f,
            (Some(_), None) => false,
        })
        .collect();

    ShareAccess {
        owner_is_you: owner_ss58 == account_id,
        owner_ss58: owner_ss58.to_string(),
        members,
        folder_holders,
        pending_invites,
        drive_member_count,
    }
}

/// Who has access to a drive, or to one folder of it, for the Share dialog's
/// "People with access" list. `path_prefix` present means a folder (rooted
/// at a browsed grant like every other folder path). The member listing is
/// required; the invite listing is best effort, since a list of people is
/// still right without the pending ones.
#[tauri::command]
pub async fn list_share_access(
    app: tauri::AppHandle,
    label: String,
    path_prefix: Option<String>,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<ShareAccess> {
    let folder = match path_prefix {
        Some(path) => Some(super::folder_grant_path::folder_grant_path_prefix(&crate::sync::identity::rooted_path(
            &label, &path,
        ))?),
        None => None,
    };
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_access_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;
    let http = state.api_client.clone();

    // Pending invitations are the owner's to see: somebody else's drive is
    // never asked for them.
    let invites = async {
        if identity.is_member {
            Ok(Vec::new())
        } else {
            http_list_invites(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash).await
        }
    };
    let (listing, invites) = tokio::join!(
        http_list_members(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash, member_owner(&identity)),
        invites,
    );
    let listing = listing?;
    let mut invites = invites.unwrap_or_else(|e| {
        warn!(label = %label, error = %e, "Share dialog: invite listing failed; pending invites omitted");
        Vec::new()
    });
    invites.iter_mut().for_each(normalize_invite_fields);

    Ok(fold_share_access(
        &ctx.account_id,
        &identity.wire_ss58,
        folder.as_deref(),
        listing,
        invites,
    ))
}

/// Everything the Manage access panel shows for a drive, or for one folder of
/// it, folded by [`super::access_panel::fold_access_panel`]: people (members
/// and folder holders), emailed invitations still waiting, and link invites
/// split into working and ended, with their sealed links opened here.
///
/// The member listing is required (any member of the drive may read it). The
/// invite listing is fetched for an own drive only, and best effort: a list
/// of people is still right without the links.
#[tauri::command]
pub async fn list_access_panel(
    app: tauri::AppHandle,
    label: String,
    path_prefix: Option<String>,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<super::access_panel::AccessPanel> {
    let folder = match path_prefix {
        Some(path) => Some(super::folder_grant_path::folder_grant_path_prefix(&crate::sync::identity::rooted_path(
            &label, &path,
        ))?),
        None => None,
    };
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_access_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;
    let http = state.api_client.clone();

    // Invites and links are the owner's to see in the panel: somebody else's
    // drive is never asked for them (and its sealed links never opened).
    let invites = async {
        if identity.is_member {
            Ok(Vec::new())
        } else {
            http_list_invites(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash).await
        }
    };
    let (listing, invites) = tokio::join!(
        http_list_members(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash, member_owner(&identity)),
        invites,
    );
    let listing = listing?;
    let mut invites = invites.unwrap_or_else(|e| {
        warn!(label = %label, error = %e, "Access panel: invite listing failed; links omitted");
        Vec::new()
    });
    let key_unavailable = open_invite_links(&state, &ctx.account_id, &label, &identity, &mut invites).await;

    let panel = super::access_panel::fold_access_panel(
        &ctx.account_id,
        &identity.wire_ss58,
        folder.as_deref(),
        listing,
        invites,
        key_unavailable,
        chrono::Utc::now(),
    );
    info!(
        label = %label,
        members = panel.members.len(),
        holders = panel.folder_holders.len(),
        links = panel.links.len(),
        links_locked = panel.links_locked,
        "Listed access panel"
    );
    Ok(panel)
}

/// One folder grant on a drive, as its owner sees it (no grant blob).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFolderGrantInfo {
    pub member_ss58: String,
    pub path_prefix: String,
    pub role: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_email: Option<String>,
}

/// Folder grants on a drive, one row per (holder, folder). Holders never
/// appear in [`list_drive_members`]. A read: the server sends folder grants
/// to the owner, and this answers whatever it sends.
#[tauri::command]
pub async fn list_drive_folder_grants(
    app: tauri::AppHandle,
    label: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<Vec<DriveFolderGrantInfo>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_access_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    let caps = crate::shares::capabilities::fetch_capabilities(&state, &ctx.account_id).await?;
    if !caps.folder_grants {
        return Ok(Vec::new());
    }

    let resp = http_list_members(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        member_owner(&identity),
    )
    .await?;
    // Read from inside a granted folder, only the holders at or below it.
    let scope = crate::sync::identity::folder_grant_browse(&label).map(|(_, root)| root);
    Ok(resp
        .folder_grants
        .into_iter()
        .filter(|g| in_scope(scope.as_deref(), Some(&g.path_prefix)))
        .map(|g| DriveFolderGrantInfo {
            member_ss58: g.member_ss58,
            path_prefix: g.path_prefix,
            role: super::folder_roles::grant_role(Some(&g.role)),
            created_at: g.created_at,
            member_name: present_text(g.member_name),
            member_email: present_email(g.member_email),
        })
        .collect())
}

/// Whether a row belongs to what the caller is reading. No scope (the whole
/// drive) sees everything; a folder scope (a granted folder) sees only rows
/// for that folder or below it, and never a whole-drive row.
pub(crate) fn in_scope(scope: Option<&str>, row_path: Option<&str>) -> bool {
    match (scope, row_path) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(root), Some(path)) => super::folder_grant_path::prefix_covers(root, path),
    }
}

/// A holder's folders after a replace, as the server stored them. `roles` is
/// in the same order as `path_prefixes`: a folder they already held keeps its
/// role, and only the folders this call added took the requested one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFolderGrants {
    pub member_ss58: String,
    pub path_prefixes: Vec<String>,
    pub roles: Vec<String>,
}

impl From<hcfs_shared::network::ReplaceFolderGrantsResponse> for ReplacedFolderGrants {
    fn from(resp: hcfs_shared::network::ReplaceFolderGrantsResponse) -> Self {
        Self {
            member_ss58: resp.member_ss58,
            path_prefixes: resp.path_prefixes,
            // Read defensively, like every other grant role: an unknown role
            // is a Viewer, never more.
            roles: resp.roles.iter().map(|r| super::folder_roles::grant_role(Some(r))).collect(),
        }
    }
}

/// Replace the folders a grant holder may reach
/// (`PUT /v1/drives/{fh}/grants/{ss58}`): add folders, or narrow to fewer.
///
/// `role` applies only to folders this call ADDS (`reader` when omitted); a
/// folder the holder already has keeps its role on the server. `manager` and
/// anything else are refused here by name. An Editor folder while the server
/// has writer grants off comes back as `NotReady(FolderEditorInvitesUnavailable)`.
/// Owner only.
#[tauri::command]
pub async fn replace_folder_grants(
    app: tauri::AppHandle,
    label: String,
    member_ss58: String,
    path_prefixes: Vec<String>,
    role: Option<String>,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<ReplacedFolderGrants> {
    let (normalized, role) = plan_folder_grant_replace(&path_prefixes, role)?;

    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    let caps = crate::shares::capabilities::fetch_capabilities(&state, &ctx.account_id).await?;
    // Same guard as the mint: a server that does not know folder grants has
    // no such route, so say "coming soon" rather than send.
    super::folder_roles::require_server_knows_folder_invites(&caps)?;

    let resp = http_replace_folder_grants(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &member_ss58,
        &normalized,
        role.as_deref(),
    )
    .await?;
    info!(
        label = %label,
        folder_hash = %identity.wire_folder_hash,
        count = resp.path_prefixes.len(),
        "Folder grants replaced"
    );
    Ok(resp.into())
}

/// Validate a replace before any request: every folder a legal drive-relative
/// path, at least one, no duplicates, and the role for added folders Viewer or
/// Editor. `None` role stays `None` so the server applies its own default.
pub(crate) fn plan_folder_grant_replace(path_prefixes: &[String], role: Option<String>) -> Result<(Vec<String>, Option<String>)> {
    let mut normalized: Vec<String> = Vec::with_capacity(path_prefixes.len());
    for raw in path_prefixes {
        let folder = super::folder_grant_path::folder_grant_path_prefix(raw)?;
        if !normalized.contains(&folder) {
            normalized.push(folder);
        }
    }
    if normalized.is_empty() {
        return Err(AppError::Validation(
            "At least one folder is required. To remove every grant, remove the person instead.".into(),
        ));
    }
    let role = match role {
        Some(r) => Some(super::folder_roles::resolve_folder_role(Some(r))?),
        None => None,
    };
    Ok((normalized, role))
}

/// `PUT /v1/drives/{folder_hash}/grants/{member_ss58}`. Owner only, so no
/// `?owner=`.
#[allow(clippy::too_many_arguments)]
pub async fn http_replace_folder_grants(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    member_ss58: &str,
    path_prefixes: &[String],
    role: Option<&str>,
) -> Result<hcfs_shared::network::ReplaceFolderGrantsResponse> {
    let resp = http
        .put(format!(
            "{}/v1/drives/{}/grants/{}",
            base_url.trim_end_matches('/'),
            folder_hash,
            member_ss58
        ))
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&hcfs_shared::network::ReplaceFolderGrantsRequest {
            path_prefixes: path_prefixes.to_vec(),
            role: role.map(str::to_string),
        })
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("replace-folder-grants request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        if let Some(err) = super::folder_roles::classify_folder_grant_refusal(status, &body) {
            return Err(err);
        }
        return Err(classify_error_status(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("replace-folder-grants response did not parse: {e}")))
}

/// One folder grant held by this account (blob-free for the FE).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyFolderGrantInfo {
    pub owner_ss58: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    pub folder_hash: String,
    pub display_label: String,
    pub path_prefix: String,
    pub role: String,
    pub created_at: String,
    /// Whether this account may change files in the folder: an Editor grant,
    /// writer grants on at the server, and the owner not frozen. Decided here
    /// so the frontend never combines role and capability itself.
    pub can_write: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub frozen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen_until: Option<String>,
}

/// Folder grants shared WITH this account — kept apart from whole-drive
/// memberships so an older FE never treats a grant as the whole drive.
#[tauri::command]
pub async fn list_my_folder_grants(app: tauri::AppHandle) -> Result<Vec<MyFolderGrantInfo>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;

    let caps = crate::shares::capabilities::fetch_capabilities(&state, &ctx.account_id).await?;
    if !caps.folder_grants {
        return Ok(Vec::new());
    }

    let resp = http_list_memberships(&state.api_client.clone(), &ctx.base_url, &ctx.bearer).await?;
    Ok(resp
        .folder_grants
        .into_iter()
        .map(|g| {
            let role = super::folder_roles::grant_role(Some(&g.role));
            MyFolderGrantInfo {
                can_write: super::folder_roles::grant_can_write(&role, caps.folder_grant_writes, g.frozen),
                owner_ss58: g.owner_ss58,
                owner_name: present_text(g.owner_name),
                folder_hash: g.folder_hash,
                display_label: g.display_label,
                path_prefix: g.path_prefix,
                role,
                created_at: g.created_at,
                frozen: g.frozen,
                frozen_until: present_text(g.frozen_until),
            }
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
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    // Owner only, so no `?owner=`: the server keys the delete by the caller's
    // own identity. Leaving a drive is `leave_shared_drive`, not this.
    http_remove_member(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &member_ss58,
        None,
    )
    .await?;

    info!(label = %label, folder_hash = %identity.wire_folder_hash, "Drive member removed");
    Ok(())
}

/// Change a member's role on a drive this account owns.
///
/// The role is validated here, before anything else, rather than forwarded
/// blind: Viewer or Editor only ([`require_offered_role`]). The server still
/// accepts `manager`, and this client never sends it.
#[tauri::command]
pub async fn change_drive_member_role(
    app: tauri::AppHandle,
    label: String,
    member_ss58: String,
    role: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<()> {
    require_offered_role(&role)?;

    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    // Targeting yourself is the server's 400. Refuse it here so the UI can
    // say why instead of surfacing a bare rejection.
    if member_ss58 == ctx.account_id {
        return Err(AppError::Validation("You cannot change your own role. Leave the drive instead.".into()));
    }

    http_change_member_role(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &member_ss58,
        &role,
    )
    .await?;

    // The member ss58 is an account identifier, not a secret, and the role is
    // the point of the line; the drive label stays as the operator's handle.
    info!(label = %label, folder_hash = %identity.wire_folder_hash, role = %role, "Drive member role changed");
    Ok(())
}

/// Open each invite's sealed token under the drive key and attach the rebuilt
/// `invite_url`, then strip the ciphertext and normalise the mailed fields.
///
/// Rows without a blob (pre-seal-back, revoked, or not readable by this
/// caller) leave `link_available` false; a blob that will not open leaves it
/// true and `invite_url` empty (the locked field). The key is read only when
/// some row has a blob: for a folder grant it is an Argon2id open.
///
/// Returns true when a sealed link could not be opened because the drive key
/// is not available in this session (the panel then asks to unlock).
async fn open_invite_links(
    state: &AppState,
    account_id: &str,
    label: &str,
    identity: &crate::sync::identity::DriveIdentity,
    invites: &mut [DriveInviteInfo],
) -> bool {
    let any_sealed = invites
        .iter()
        .any(|i| i.valid && i.sealed_token.as_deref().is_some_and(|s| !s.is_empty()));
    // Folder invites are sealed under the derived file key; whole-drive under
    // folder-mnemonic entropy. Failure is not fatal to the listing: rows keep
    // their metadata and show the locked link field.
    let (entropy, file_key) = if any_sealed {
        let _recovery_guard = state.recovery_lock.lock().await;
        let mnemonic = crate::sync::remote::session_mnemonic(state).ok();
        match mnemonic {
            Some(mnemonic) => {
                match crate::sync::remote::drive_key_material_for_label(state, account_id, label, &mnemonic, identity).await {
                    Ok(crate::sync::remote::DriveKeyMaterial::Phrase(phrase)) => {
                        let entropy = grant::entropy_from_phrase(&phrase).ok();
                        let file_key = crate::sync::remote::encryption_key_from_phrase(&phrase).ok().map(Zeroizing::new);
                        (entropy, file_key)
                    }
                    // A folder grant holder can open folder invites only.
                    Ok(crate::sync::remote::DriveKeyMaterial::FileKey(key)) => (None, Some(key)),
                    Err(_) => (None, None),
                }
            }
            None => (None, None),
        }
    } else {
        (None, None)
    };

    let console_base = crate::shares::commands::console_base_url();
    let mut key_unavailable = false;
    for invite in invites.iter_mut() {
        let sealed = invite.sealed_token.as_deref().filter(|s| !s.is_empty());
        invite.link_available = sealed.is_some() && invite.valid;
        invite.invite_url = None;
        let open_key: Option<&[u8; 32]> = if invite.path_prefix.is_some() {
            file_key.as_deref()
        } else {
            entropy.as_deref()
        };
        match (sealed, open_key) {
            (Some(sealed), Some(key)) => {
                if let Some(token) = super::invite_token::open_invite_token(key, &invite.invite_id, sealed) {
                    invite.invite_url = Some(build_invite_url(&console_base, &token, key));
                }
            }
            (Some(_), None) if invite.link_available => key_unavailable = true,
            _ => {}
        }
        // Never leave ciphertext on the FE wire.
        invite.sealed_token = None;
        normalize_invite_fields(invite);
    }
    key_unavailable
}

/// List the live invites for a drive this account owns.
///
/// Opens each row's sealed token under the drive key and attaches a rebuilt
/// `invite_url` so the Links tab can copy a link minted earlier. Rows without
/// a blob (pre-seal-back, revoked, or not readable by this caller) leave
/// `link_available` false; a blob that will not open leaves the field true
/// and `invite_url` empty (locked stand-in).
#[tauri::command]
pub async fn list_drive_invites(
    app: tauri::AppHandle,
    label: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<Vec<DriveInviteInfo>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    let mut invites = http_list_invites(&state.api_client.clone(), &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash).await?;

    open_invite_links(&state, &ctx.account_id, &label, &identity, &mut invites).await;

    let live = invites.iter().filter(|i| i.valid && !i.revoked).count();
    info!(label = %label, count = invites.len(), live, "Listed drive invites");
    Ok(invites)
}

// ─── Emailed invites (hcfs #459), owner side ───────────────────────────────
//
// The recipient side (open the mail, publish a key, join) lives in the
// console. The desktop mints a mailed invitation, shows its progress on the
// Links tab, and approves it by sealing the drive key to the recipient.

/// Bounds the server enforces on a mailed invitation's lifetime.
pub(crate) const EMAIL_INVITE_MIN_SECS: u64 = 60 * 60;
pub(crate) const EMAIL_INVITE_MAX_SECS: u64 = 30 * 24 * 60 * 60;

/// A validated emailed-invite request, ready for the wire.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct EmailInvitePolicy {
    pub email: String,
    pub role: String,
    pub expires_in_secs: u64,
}

/// Validate what the dialog asked for, before any network call.
///
/// Rules are the server's, refused here by name so the dialog can say which
/// one: one address; Viewer or Editor only ([`require_offered_role`]); a
/// lifetime between one hour and thirty days, defaulting to the ordinary
/// seven.
pub(crate) fn resolve_email_invite(email: &str, role: Option<String>, expires_in_secs: Option<u64>) -> Result<EmailInvitePolicy> {
    let email = validate_invite_email(email)?;
    let role = resolve_invite_role(role)?;
    let expires_in_secs = expires_in_secs.unwrap_or(DEFAULT_INVITE_EXPIRES_IN_SECS);
    if !(EMAIL_INVITE_MIN_SECS..=EMAIL_INVITE_MAX_SECS).contains(&expires_in_secs) {
        return Err(AppError::Validation(
            "An emailed invitation must expire between 1 hour and 30 days from now.".into(),
        ));
    }
    Ok(EmailInvitePolicy {
        email,
        role,
        expires_in_secs,
    })
}

/// What the Share dialog is told about a typed address, as it is typed.
const INVALID_INVITE_EMAIL: &str = "Enter one email address, like name@example.com.";

/// The one address rule, shared by the send and by the as-you-type check, so
/// the field can never accept what the send then refuses. Returns the address
/// trimmed.
///
/// Deliberately loose: the server is the authority on what it can mail. This
/// only stops the obvious slip of a name, a list or a blank field.
pub(crate) fn validate_invite_email(email: &str) -> Result<String> {
    let email = email.trim();
    let looks_like_address = email.len() <= 254
        && !email.contains(char::is_whitespace)
        && !email.contains(',')
        && email.matches('@').count() == 1
        && email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
    if !looks_like_address {
        return Err(AppError::Validation(INVALID_INVITE_EMAIL.into()));
    }
    Ok(email.to_string())
}

/// The as-you-type verdict on an invite address.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InviteEmailCheck {
    /// Whether "Send invite" may be pressed.
    pub valid: bool,
    /// What to say under the field. Absent while the field is empty, so an
    /// untouched field is not scolded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn invite_email_check(email: &str) -> InviteEmailCheck {
    if email.trim().is_empty() {
        return InviteEmailCheck { valid: false, message: None };
    }
    match validate_invite_email(email) {
        Ok(_) => InviteEmailCheck { valid: true, message: None },
        Err(_) => InviteEmailCheck {
            valid: false,
            message: Some(INVALID_INVITE_EMAIL.into()),
        },
    }
}

/// Check a typed invite address against the same rule the send applies, with
/// no network call: the Share dialog asks on every change so it can say what
/// is wrong before anyone presses Send.
#[tauri::command]
pub fn check_invite_email(email: String) -> InviteEmailCheck {
    invite_email_check(&email)
}

/// Map a failed `POST /v1/drive-invites/email`.
///
/// Three outcomes need their own words, each matched on status or slug and
/// never on the English message:
/// - 503 `email_invites_unavailable`: no mail service; the FE says email
///   invites are coming soon.
/// - 400 on a folder: folder invites cannot be mailed yet (`folder_roles`).
/// - 429 `rate_limited`: too many invitations; say how long to wait.
/// - 502 `mail_send_failed`: the server could not send it and has already
///   revoked the invite, so trying again is safe and is what we say.
fn classify_email_invite_error(status: reqwest::StatusCode, retry_after_header: Option<u64>, body: &str) -> AppError {
    #[derive(serde::Deserialize, Default)]
    struct Envelope {
        #[serde(default)]
        error: String,
        #[serde(default)]
        retry_after_secs: Option<u64>,
    }
    let envelope: Envelope = serde_json::from_str(body).unwrap_or_default();
    let code = status.as_u16();
    if code == 503 || envelope.error == "email_invites_unavailable" {
        return AppError::NotReady(NotReadyKind::EmailInvitesUnavailable);
    }
    if let Some(err) = super::folder_roles::classify_folder_email_refusal(status, body) {
        return err;
    }
    if code == 429 || envelope.error == "rate_limited" {
        let wait = envelope.retry_after_secs.or(retry_after_header);
        return AppError::NotReady(NotReadyKind::RateLimited {
            message: rate_limited_message(wait),
        });
    }
    if code == 502 || envelope.error == "mail_send_failed" {
        return AppError::Validation("The invitation email could not be sent, so the invite was cancelled. Try again.".into());
    }
    classify_error_status(status, body)
}

/// "Try again in N minutes" for a rate-limited mint, rounded UP so the user is
/// never told a time at which the server will still refuse them.
fn rate_limited_message(retry_after_secs: Option<u64>) -> String {
    match retry_after_secs {
        Some(secs) if secs >= 3600 => {
            let hours = secs.div_ceil(3600);
            format!(
                "Too many invitations sent recently. Try again in {hours} hour{}.",
                if hours == 1 { "" } else { "s" }
            )
        }
        Some(secs) if secs >= 60 => {
            let minutes = secs.div_ceil(60);
            format!(
                "Too many invitations sent recently. Try again in {minutes} minute{}.",
                if minutes == 1 { "" } else { "s" }
            )
        }
        Some(secs) => format!("Too many invitations sent recently. Try again in {} seconds.", secs.max(1)),
        None => "Too many invitations sent recently. Try again later.".into(),
    }
}

/// The body of `POST /v1/drive-invites/email`. `path_prefix` is only ever
/// set for a folder (`folder_roles`), and only to a server that knows it.
/// No `owner_ss58`: only the owner invites, and the server reads its absence
/// as caller-as-owner.
#[derive(Debug, Serialize)]
pub struct EmailInviteBody<'a> {
    pub folder_hash: &'a str,
    pub email: &'a str,
    pub role: &'a str,
    pub expires_in_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<&'a str>,
}

/// `POST /v1/drive-invites/email`. Returns the new invite's id; the token
/// exists only in the message, by design.
pub async fn http_email_invite(http: &reqwest::Client, base_url: &str, bearer: &str, body: &EmailInviteBody<'_>) -> Result<String> {
    // `manager` never reaches the wire, whoever calls this.
    require_offered_role(body.role)?;
    let resp = http
        .post(format!("{}/v1/drive-invites/email", base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {bearer}"))
        .json(body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("email-invite request failed: {e}")))?;

    let status = resp.status();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(classify_email_invite_error(status, retry_after, &text));
    }
    #[derive(Deserialize)]
    struct Minted {
        invite_id: String,
    }
    let minted: Minted = serde_json::from_str(&text).map_err(|e| AppError::Hcfs(format!("email-invite response did not parse: {e}")))?;
    Ok(minted.invite_id)
}

/// Result of a mailed-invite mint. No link: the token is only in the mail.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailInviteResult {
    pub invite_id: String,
}

/// Invite someone into a drive this account owns, by email.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC surface: the invite fields plus the drive target and folder
pub async fn email_drive_invite(
    app: tauri::AppHandle,
    label: String,
    email: String,
    role: Option<String>,
    expires_in_secs: Option<u64>,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
    path_prefix: Option<String>,
) -> Result<EmailInviteResult> {
    let policy = resolve_email_invite(&email, role, expires_in_secs)?;
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    // A folder email invite (`folder_roles`, assumption 3). The server
    // refuses `path_prefix` on this route today; the request is still sent so
    // it works the day that changes, and the refusal reads "coming soon". A
    // server that does not know folder invites would ignore the field and
    // mail a WHOLE-DRIVE invite, so nothing is sent to one.
    let folder_prefix = match path_prefix {
        Some(raw) => {
            let relative = crate::sync::identity::rooted_path(&label, &raw);
            let prefix = super::folder_grant_path::folder_grant_path_prefix(&relative)?;
            let caps = crate::shares::capabilities::fetch_capabilities(&state, &ctx.account_id).await?;
            super::folder_roles::require_server_knows_folder_invites(&caps)?;
            Some(prefix)
        }
        None => None,
    };

    let invite_id = http_email_invite(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &EmailInviteBody {
            folder_hash: &identity.wire_folder_hash,
            email: &policy.email,
            role: &policy.role,
            expires_in_secs: policy.expires_in_secs,
            path_prefix: folder_prefix.as_deref(),
        },
    )
    .await?;

    // The address is not logged: it is personal data and the id is enough to
    // correlate with the server.
    info!(label = %label, folder_hash = %identity.wire_folder_hash, invite_id = %invite_id, "Drive invite emailed");
    Ok(EmailInviteResult { invite_id })
}

/// Whether this server can send invitations by email, asked without sending
/// one. The route answers 503 before validating anything when mail is not
/// configured, so an empty address tells the two apart: 503 (or a feature-off
/// 404) is "not yet", a 400 about the address is "yes". Nothing is minted.
#[tauri::command]
pub async fn email_invites_available(app: tauri::AppHandle, label: String, owner_ss58: Option<String>, folder_hash: Option<String>) -> Result<bool> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;
    let probe = http_email_invite(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &EmailInviteBody {
            folder_hash: &identity.wire_folder_hash,
            email: "",
            role: "reader",
            expires_in_secs: DEFAULT_INVITE_EXPIRES_IN_SECS,
            path_prefix: None,
        },
    )
    .await;
    Ok(email_probe_says_available(&probe))
}

/// The probe's verdict, pure so it is testable. Only the two "no mail here"
/// answers read as unavailable; anything else (the expected 400 about the
/// empty address, or even an unexpected success) means the route is live.
fn email_probe_says_available(probe: &Result<String>) -> bool {
    !matches!(
        probe,
        Err(AppError::NotReady(
            NotReadyKind::EmailInvitesUnavailable | NotReadyKind::SharedDrivesUnavailable
        ))
    )
}

/// What a `PUT .../sealed-key` came back as.
#[derive(Debug, PartialEq, Eq)]
pub enum SealKeyPut {
    Sealed,
    /// 409: somebody approved it first. The state the user wanted.
    AlreadySealed,
    /// 404: the recipient replaced their key since the row was read (or the
    /// invite expired or was spent). Re-read the row before trying again.
    Stale,
}

/// `PUT /v1/drives/{folder_hash}/invites/{invite_id}/sealed-key`.
#[allow(clippy::too_many_arguments)] // one request's worth of wire fields
pub async fn http_put_sealed_key(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    invite_id: &str,
    sealed_key: &str,
    sealed_for: &str,
) -> Result<SealKeyPut> {
    let resp = http
        .put(format!(
            "{}/v1/drives/{}/invites/{}/sealed-key",
            base_url.trim_end_matches('/'),
            folder_hash,
            invite_id
        ))
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&serde_json::json!({ "sealed_key": sealed_key, "sealed_for": sealed_for }))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("seal-key request failed: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    match status.as_u16() {
        200..=299 => Ok(SealKeyPut::Sealed),
        409 => Ok(SealKeyPut::AlreadySealed),
        // A mounted route's 404 is "stale"; a bare 404 is a feature-off
        // server, which is not something re-reading the row can fix.
        404 if !body.trim().is_empty() => Ok(SealKeyPut::Stale),
        _ => Err(classify_error_status(status, &body)),
    }
}

/// What an approve needs from the invite row: who to seal to, and which key
/// the row's link would have carried.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ApprovableInvite {
    pub requester_pubkey: String,
    pub path_prefix: Option<String>,
}

/// Find the row and check it is waiting for approval.
///
/// Decided by `email_status`, NOT by `requester_pubkey` being present: the key
/// stays on the row after sealing too, and offering an already-sealed row for
/// sealing again earns a 409.
pub(crate) fn approvable_invite(invites: &[DriveInviteInfo], invite_id: &str) -> Result<ApprovableInvite> {
    let row = invites
        .iter()
        .find(|i| i.invite_id == invite_id)
        .ok_or_else(|| AppError::NotFound("This invitation no longer exists.".into()))?;
    match row.email_status.as_deref() {
        Some("awaiting_seal") => {}
        Some("sealed") => return Err(AppError::Validation("This invitation has already been approved.".into())),
        Some("sent") => {
            return Err(AppError::Validation(
                "They have not opened the invitation yet. You can approve it once they do.".into(),
            ));
        }
        _ => return Err(AppError::Validation("Only an emailed invitation can be approved.".into())),
    }
    let requester_pubkey = row
        .requester_pubkey
        .clone()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| AppError::Validation("This invitation is not ready to approve yet. Refresh and try again.".into()))?;
    Ok(ApprovableInvite {
        requester_pubkey,
        path_prefix: row.path_prefix.clone(),
    })
}

/// Outcome of an approve, for the toast.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveInviteResult {
    /// `sealed`, or `already_sealed` when somebody approved it first.
    pub status: String,
}

/// Approve an emailed invitation: seal the DRIVE's key to the recipient's
/// published key and hand the blob to the server.
///
/// Owner only. The sealed secret is resolved exactly like the link mint
/// resolves it (`drive_key_material_for_label`), through the one funnel that
/// knows where a drive's key lives.
///
/// A 404 means the recipient replaced their key after the row was read; the
/// row is re-read once and sealed again for the new key.
#[tauri::command]
pub async fn approve_email_invite(
    app: tauri::AppHandle,
    label: String,
    invite_id: String,
    owner_ss58: Option<String>,
    folder_hash: Option<String>,
) -> Result<ApproveInviteResult> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;
    let http = state.api_client.clone();

    // Resolve the key material once; both attempts seal the same drive key.
    // Through the one funnel the link mint uses: never this account's master.
    let (drive_entropy, folder_key) = {
        let _recovery_guard = state.recovery_lock.lock().await;
        let mnemonic = crate::sync::remote::session_mnemonic(&state)?;
        // A folder grant holder gets their derived key only, which can
        // approve a folder invitation and never a whole-drive one.
        match crate::sync::remote::drive_key_material_for_label(&state, &ctx.account_id, &label, &mnemonic, &identity).await? {
            crate::sync::remote::DriveKeyMaterial::Phrase(phrase) => (
                Some(grant::entropy_from_phrase(&phrase)?),
                Zeroizing::new(crate::sync::remote::encryption_key_from_phrase(&phrase)?),
            ),
            crate::sync::remote::DriveKeyMaterial::FileKey(key) => (None, key),
        }
    };

    for attempt in 0..2 {
        let invites = http_list_invites(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash).await?;
        let row = approvable_invite(&invites, &invite_id)?;
        let key: Zeroizing<[u8; 32]> = if row.path_prefix.is_some() {
            folder_key.clone()
        } else {
            drive_entropy
                .clone()
                .ok_or_else(|| AppError::Validation("Only someone with access to the whole drive can approve this invitation.".into()))?
        };
        let sealed = super::invite_key::seal_invite_key(key.as_ref(), &row.requester_pubkey, &invite_id)
            .map_err(|e| AppError::Crypto(format!("could not seal the drive key: {e}")))?;
        match http_put_sealed_key(
            &http,
            &ctx.base_url,
            &ctx.bearer,
            &identity.wire_folder_hash,
            &invite_id,
            &sealed,
            &row.requester_pubkey,
        )
        .await?
        {
            SealKeyPut::Sealed => {
                info!(label = %label, invite_id = %invite_id, "Emailed invite approved");
                return Ok(ApproveInviteResult { status: "sealed".into() });
            }
            SealKeyPut::AlreadySealed => {
                return Ok(ApproveInviteResult {
                    status: "already_sealed".into(),
                });
            }
            SealKeyPut::Stale if attempt == 0 => {
                info!(invite_id = %invite_id, "Recipient key changed before the seal landed; re-reading the invite");
            }
            SealKeyPut::Stale => {}
        }
    }
    Err(AppError::Validation(
        "The invitation changed while it was being approved. Refresh the list and try again.".into(),
    ))
}

/// The 32 bytes an approval seals: the drive's folder-key ENTROPY for a
/// whole-drive invite, the DERIVED file key for a folder invite. The same
/// split the link mint makes, so a recipient ends up holding exactly what a
/// link would have handed them.
fn sealed_invite_payload(material: crate::sync::remote::DriveKeyMaterial, folder_invite: bool) -> Result<Zeroizing<[u8; 32]>> {
    if folder_invite {
        Ok(Zeroizing::new(material.encryption_key()?))
    } else {
        grant::entropy_from_phrase(&material.into_phrase()?)
    }
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
    /// Whole-drive members. Folder holders are not counted: a drive where
    /// only a folder is shared is not a shared drive.
    pub member_count: u32,
    /// Whole-drive invite links that can still admit someone.
    pub live_invite_count: u32,
    /// Every whole-drive invite the server still lists, expired and revoked
    /// included. Folder invites are the folder's (see [`FolderSharingSummary`]).
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
/// Only WHOLE-DRIVE invites count. A folder invite shares one folder, not the
/// drive, and counting it here marked a drive "Invite sent" when the owner had
/// only ever shared a folder inside it. Folder sharing is described on the
/// folder's own row by [`list_owned_folder_sharing`]. `member_count` is
/// already whole-drive only: the server's `member_count` does not include
/// folder holders.
///
/// Pure, so the rule is testable without a server.
fn fold_drive_sharing(label: &str, member_count: Option<usize>, invites: Option<&[DriveInviteInfo]>) -> Option<DriveSharingSummary> {
    if member_count.is_none() && invites.is_none() {
        return None;
    }
    let whole_drive = || invites.into_iter().flatten().filter(|i| invite_folder(i).is_none());
    Some(DriveSharingSummary {
        label: label.to_string(),
        member_count: member_count.unwrap_or(0) as u32,
        live_invite_count: whole_drive().filter(|i| i.valid && !i.revoked).count() as u32,
        total_invite_count: whole_drive().count() as u32,
    })
}

/// The folder a folder invite names, drive-relative with no surrounding `/`
/// and NFC, as a grant's `path_prefix` is. `None` for a whole-drive invite
/// (no prefix, or an empty one).
fn invite_folder(invite: &DriveInviteInfo) -> Option<String> {
    invite.path_prefix.as_deref().and_then(folder_key)
}

/// A folder path as the folder sharing map keys it: no surrounding `/`, NFC.
/// `None` when nothing is left, which is the whole drive, never a folder.
fn folder_key(path: &str) -> Option<String> {
    use unicode_normalization::UnicodeNormalization;
    let trimmed = path.trim_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.nfc().collect())
}

/// One folder of an own drive that is shared on its own: people hold a grant
/// on exactly this folder, or a folder invite for it is listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSharingSummary {
    /// Drive-relative folder, no surrounding `/`, NFC.
    pub path: String,
    /// People holding a grant on exactly this folder. A grant on a folder
    /// around it is that folder's, not this one's, so nobody is counted twice.
    pub holder_count: u32,
    /// A folder invite for exactly this folder is listed, live or spent: the
    /// same "any invite" rule the drive mark keys on, since an owner whose
    /// folder link lapsed still shared the folder.
    pub has_invite: bool,
}

/// Fold one own drive's folder grants and folder invites into the folders
/// that are shared on their own, sorted by path. Whole-drive members and
/// whole-drive invites are the drive's, never a folder's, so they are left
/// out. `None` for either listing means it failed; the other still answers.
///
/// Pure, so the rule is testable without a server.
fn fold_folder_sharing(
    grants: Option<&[hcfs_shared::network::DriveGrantHolderEntry]>,
    invites: Option<&[DriveInviteInfo]>,
) -> Vec<FolderSharingSummary> {
    use std::collections::{BTreeMap, BTreeSet};
    let mut by_path: BTreeMap<String, (BTreeSet<&str>, bool)> = BTreeMap::new();
    for grant in grants.into_iter().flatten() {
        if let Some(path) = folder_key(&grant.path_prefix) {
            by_path.entry(path).or_default().0.insert(grant.member_ss58.as_str());
        }
    }
    for invite in invites.into_iter().flatten() {
        if let Some(path) = invite_folder(invite) {
            by_path.entry(path).or_default().1 = true;
        }
    }
    by_path
        .into_iter()
        .map(|(path, (holders, has_invite))| FolderSharingSummary {
            path,
            holder_count: holders.len() as u32,
            has_invite,
        })
        .collect()
}

/// The folders of ONE own drive that are shared on their own, for the marks
/// on its folder rows and on the header of an open shared folder. Asked only
/// for the drive being browsed: the drive list never fans this out.
///
/// Both listings are fetched together and either may fail on its own; the
/// call fails only when both do, so the webview draws no folder mark rather
/// than claiming every folder is private.
#[tauri::command]
pub async fn list_owned_folder_sharing(app: tauri::AppHandle, label: String) -> Result<Vec<FolderSharingSummary>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_own_drive(state.pool()?, &ctx.account_id, &label).await?;
    let http = state.api_client.clone();

    let (listing, invites) = tokio::join!(
        http_list_members(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash, None),
        http_list_invites(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash),
    );
    let (listing, invites) = match (listing, invites) {
        (Err(e), Err(_)) => return Err(e),
        (listing, invites) => (
            listing
                .map_err(|e| debug!(label = %label, error = %e, "Folder sharing: member listing failed"))
                .ok(),
            invites
                .map_err(|e| debug!(label = %label, error = %e, "Folder sharing: invite listing failed"))
                .ok(),
        ),
    };

    let folders = fold_folder_sharing(listing.as_ref().map(|l| l.folder_grants.as_slice()), invites.as_deref());
    info!(label = %label, shared_folders = folders.len(), "Listed owned folder sharing");
    Ok(folders)
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
            let member_count = folders_by_hash.get(&identity.wire_folder_hash).map(|f| f.member_count as usize);

            // Invites only when we have no members (or could not learn the
            // count): otherwise the badge already has its answer and N invite
            // GETs would be pure noise on every drive-list refresh.
            let invites = if member_count.unwrap_or(0) == 0 {
                match http_list_invites(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash).await {
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
    let identity = resolve_owned_target(state.pool()?, &ctx.account_id, &label, owner_ss58, folder_hash).await?;

    http_revoke_invite(
        &state.api_client.clone(),
        &ctx.base_url,
        &ctx.bearer,
        &identity.wire_folder_hash,
        &invite_id,
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
            role: drive_role_from_wire(&m.role),
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
        assert_eq!(resolve_invite_role(None).expect("omitted role"), "writer");
    }

    #[test]
    fn every_wire_role_is_accepted() {
        for role in WIRE_ROLES {
            assert_eq!(resolve_invite_role(Some(role.to_string())).expect("wire role"), role);
        }
    }

    /// Anything outside Viewer and Editor is refused as a Validation error
    /// before any request, `manager` included: this client never offers it.
    #[test]
    fn manager_and_unknown_roles_are_refused_as_viewer_or_editor_only() {
        for role in ["manager", "admin", "Manager", ""] {
            let err = resolve_invite_role(Some(role.into())).expect_err("not offered");
            assert!(
                matches!(&err, AppError::Validation(m) if m == DRIVE_ROLE_ONLY),
                "{role:?} must be refused as Viewer or Editor only, got {err:?}"
            );
            assert!(require_offered_role(role).is_err());
        }
    }

    /// A member the server still calls `manager` reads as an Editor: the same
    /// write access, never the management it used to carry.
    #[test]
    fn a_wire_manager_reads_as_an_editor() {
        assert_eq!(drive_role_from_wire("manager"), "writer");
        assert_eq!(drive_role_from_wire(" manager "), "writer");
        assert_eq!(drive_role_from_wire("writer"), "writer");
        assert_eq!(drive_role_from_wire("reader"), "reader");
        // An unknown role passes through; the UI reads it as a Viewer.
        assert_eq!(drive_role_from_wire("owner"), "owner");
    }

    /// The desktop and the UI must not drift apart on the wire vocabulary.
    #[test]
    fn wire_roles_match_the_frontend_list() {
        assert_eq!(WIRE_ROLES, ["reader", "writer"]);
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
            sealed_token: None,
            invite_url: None,
            link_available: false,
            path_prefix: None,
            recipient_email: None,
            email_status: None,
            requester_ss58: None,
            requester_pubkey: None,
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

    fn folder_invite(path: &str, valid: bool) -> DriveInviteInfo {
        DriveInviteInfo {
            path_prefix: Some(path.into()),
            ..invite(valid, false)
        }
    }

    fn grant(ss58: &str, path: &str) -> hcfs_shared::network::DriveGrantHolderEntry {
        serde_json::from_value(serde_json::json!({
            "member_ss58": ss58, "path_prefix": path, "role": "reader", "created_at": "t",
        }))
        .expect("grant row")
    }

    // A folder invite shares one folder. Counting it on the drive marked the
    // drive "Invite sent" when only a folder inside it had been shared.
    #[test]
    fn fold_counts_only_whole_drive_invites_on_the_drive() {
        let invites = [folder_invite("Clients", true), folder_invite("Work", false)];
        let s = fold_drive_sharing("team", Some(0), Some(&invites)).expect("answered");
        assert_eq!((s.member_count, s.live_invite_count, s.total_invite_count), (0, 0, 0));

        let invites = [folder_invite("Clients", true), invite(true, false), folder_invite("/", false)];
        let s = fold_drive_sharing("team", Some(0), Some(&invites)).expect("answered");
        assert_eq!(s.live_invite_count, 1, "only the whole-drive link is the drive's");
        assert_eq!(s.total_invite_count, 2, "an empty prefix is the whole drive");
    }

    #[test]
    fn folder_fold_counts_holders_per_exact_folder_and_marks_invites() {
        let grants = [
            grant("5Bo", "Clients/ACME"),
            grant("5Cy", "/Clients/ACME/"),
            grant("5Bo", "Clients/ACME"),
            grant("5Di", "Work"),
        ];
        let invites = [folder_invite("Clients/ACME", false), folder_invite("Photos", false), invite(true, false)];
        let folders = fold_folder_sharing(Some(&grants), Some(&invites));
        assert_eq!(
            folders,
            vec![
                FolderSharingSummary {
                    path: "Clients/ACME".into(),
                    holder_count: 2,
                    has_invite: true,
                },
                FolderSharingSummary {
                    path: "Photos".into(),
                    holder_count: 0,
                    has_invite: true,
                },
                FolderSharingSummary {
                    path: "Work".into(),
                    holder_count: 1,
                    has_invite: false,
                },
            ],
            "a nested grant marks its own folder, never the one around it; the whole-drive invite is left out"
        );
    }

    #[test]
    fn folder_fold_answers_from_either_listing_and_normalises_paths() {
        let grants = [grant("5Bo", "Cafe\u{0301}")];
        let folders = fold_folder_sharing(Some(&grants), None);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].path, "Caf\u{00E9}", "keyed NFC, as the server stores a grant");

        let folders = fold_folder_sharing(None, Some(&[folder_invite("Work", true)]));
        assert_eq!((folders[0].holder_count, folders[0].has_invite), (0, true));

        assert!(fold_folder_sharing(None, None).is_empty());
        assert!(fold_folder_sharing(Some(&[]), Some(&[invite(true, false)])).is_empty());
    }

    #[test]
    fn folder_sharing_serializes_camel_case() {
        let json = serde_json::to_value(FolderSharingSummary {
            path: "Work".into(),
            holder_count: 2,
            has_invite: false,
        })
        .expect("serialize");
        assert_eq!(json, serde_json::json!({"path": "Work", "holderCount": 2, "hasInvite": false}));
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
    // "Documents" collide. A member's read that forgets the owner addresses
    // whichever row the server finds first.
    #[test]
    fn a_member_read_names_the_drives_owner() {
        assert_eq!(member_owner(&member_of("5Owner", "abc")), Some("5Owner"));
    }

    // An owner's own call must NOT carry it: the server keys those by the
    // caller's identity, and naming yourself is a different code path.
    #[test]
    fn an_own_drive_names_nobody() {
        assert_eq!(member_owner(&own("abc")), None);
    }

    #[test]
    fn with_owner_appends_the_param_only_when_named() {
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

    /// A member may hold a drive they never synced here. Resolving a LOCAL
    /// label for one falls through to this account's own namespace, which
    /// reads the wrong drive rather than failing, so the caller may name the
    /// wire identity instead.
    #[tokio::test]
    async fn a_named_drive_is_read_in_its_owners_namespace() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.expect("pool");
        let id = resolve_access_target(&pool, "5Me", "team-docs", Some("5Owner".into()), Some("abc123".into()))
            .await
            .expect("identity");

        assert_eq!(id.wire_ss58, "5Owner");
        assert_eq!(id.wire_folder_hash, "abc123");
        assert!(id.is_member, "somebody else's drive is never own");
        assert_eq!(member_owner(&id), Some("5Owner"), "and it is named on the wire");
    }

    /// Only the owner changes access. Somebody else's drive, whatever this
    /// account's role on it (a former Manager included), is refused before
    /// any key is read or any request is made; the owner naming their own
    /// drive by identity is still the owner.
    #[tokio::test]
    async fn access_changes_are_refused_on_a_drive_this_account_does_not_own() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.expect("pool");
        let err = resolve_owned_target(&pool, "5Me", "team-docs", Some("5Owner".into()), Some("abc123".into()))
            .await
            .expect_err("somebody else's drive");
        assert!(matches!(&err, AppError::Validation(m) if m == OWNER_ONLY), "got {err:?}");

        let own = resolve_owned_target(&pool, "5Me", "team-docs", Some("5Me".into()), Some("abc123".into()))
            .await
            .expect("naming yourself is your own drive");
        assert!(!own.is_member);
        assert_eq!(member_owner(&own), None, "an owner never sends ?owner=");
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
                resolve_access_target(&pool, "5Me", "team-docs", owner, hash).await.is_err(),
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
            "DriveInviteInfo wire keys must stay exactly these camelCase names when optional link fields are absent"
        );
    }

    #[test]
    fn drive_invite_info_carries_invite_url_when_opened() {
        let mut row = invite(true, false);
        row.link_available = true;
        row.invite_url = Some("https://console.example/invite/tok#k=abc".into());
        let json = serde_json::to_value(&row).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(obj.get("linkAvailable"), Some(&serde_json::json!(true)));
        assert_eq!(obj.get("inviteUrl"), Some(&serde_json::json!("https://console.example/invite/tok#k=abc")));
        assert!(!obj.contains_key("sealedToken"), "ciphertext must not cross IPC");
    }

    #[test]
    fn drive_invite_info_parses_sealed_token_from_server() {
        let parsed: DriveInviteInfo = serde_json::from_str(
            r#"{"invite_id":"abc","role":"writer","expires_at":"2126-01-01T00:00:00Z",
                "max_uses":50,"use_count":2,"revoked":false,"valid":true,
                "created_at":"2026-01-01T00:00:00Z","sealed_token":"c2VhbGVk"}"#,
        )
        .expect("sealed_token must deserialize");
        assert_eq!(parsed.sealed_token.as_deref(), Some("c2VhbGVk"));
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

    // ── Emailed invites ───────────────────────────────────────────────────

    #[test]
    fn email_invite_policy_accepts_viewer_and_editor_within_the_window() {
        let p = resolve_email_invite("  ada@example.com ", Some("reader".into()), Some(3600)).expect("ok");
        assert_eq!(p.email, "ada@example.com");
        assert_eq!(p.role, "reader");
        assert_eq!(p.expires_in_secs, 3600);

        let p = resolve_email_invite("ada@example.com", None, None).expect("defaults");
        assert_eq!(p.role, "writer", "the dialog's default role");
        assert_eq!(p.expires_in_secs, DEFAULT_INVITE_EXPIRES_IN_SECS);
        assert!(resolve_email_invite("ada@example.com", None, Some(EMAIL_INVITE_MAX_SECS)).is_ok());
    }

    #[test]
    fn email_invite_policy_refuses_manager_as_viewer_or_editor_only() {
        for role in ["manager", "admin"] {
            let err = resolve_email_invite("ada@example.com", Some(role.into()), None).expect_err("not offered");
            assert!(matches!(&err, AppError::Validation(m) if m == DRIVE_ROLE_ONLY), "{role}: {err:?}");
        }
    }

    #[test]
    fn email_invite_policy_refuses_out_of_window_lifetimes() {
        assert!(resolve_email_invite("ada@example.com", None, Some(EMAIL_INVITE_MIN_SECS - 1)).is_err());
        assert!(resolve_email_invite("ada@example.com", None, Some(EMAIL_INVITE_MAX_SECS + 1)).is_err());
        // The link dialog's "Never expires" preset must not slip through.
        assert!(resolve_email_invite("ada@example.com", None, Some(100 * 365 * 24 * 3600)).is_err());
    }

    #[test]
    fn email_invite_policy_refuses_what_is_not_one_address() {
        for bad in [
            "",
            "   ",
            "ada",
            "ada@",
            "@example.com",
            "ada@example",
            "a b@example.com",
            "ada@.com",
            "a@b.c,d@e.f g",
        ] {
            assert!(resolve_email_invite(bad, None, None).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn email_invite_policy_refuses_two_addresses_in_one_field() {
        for bad in ["ada@example.com,bob@example.com", "ada@b@example.com"] {
            assert!(resolve_email_invite(bad, None, None).is_err(), "{bad:?} must be refused");
        }
    }

    // The field and the send share one rule: whatever the as-you-type check
    // accepts, the send accepts, and the reverse.
    #[test]
    fn the_typed_address_check_agrees_with_the_send() {
        for input in [
            "ada@example.com",
            "  ada@example.com ",
            "ada",
            "ada@",
            "@example.com",
            "ada@example",
            "a b@example.com",
            "ada@.com",
            "ada@example.com,bob@example.com",
        ] {
            let check = invite_email_check(input);
            assert_eq!(check.valid, validate_invite_email(input).is_ok(), "{input:?}");
            assert_eq!(check.message.is_some(), !check.valid, "{input:?}: an invalid address says why");
        }
    }

    #[test]
    fn an_empty_field_is_not_valid_and_not_scolded() {
        for input in ["", "   "] {
            assert_eq!(invite_email_check(input), InviteEmailCheck { valid: false, message: None });
        }
    }

    #[test]
    fn invite_email_check_wire_keys_are_pinned() {
        let json = serde_json::to_value(invite_email_check("ada")).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "valid": false, "message": "Enter one email address, like name@example.com." })
        );
        let json = serde_json::to_value(invite_email_check("ada@example.com")).expect("serialize");
        assert_eq!(json, serde_json::json!({ "valid": true }));
    }

    // The Share dialog describes a new link from these fields, so a renamed
    // key would ship as an undefined lifetime or uses count.
    #[test]
    fn drive_invite_link_wire_keys_are_pinned() {
        let link = DriveInviteLink {
            invite_url: "https://console.example/invite/t#k=x".into(),
            invite_id: "abc123".into(),
            role: "reader".into(),
            expires_in_secs: 3600,
            max_uses: 1,
        };
        let json = serde_json::to_value(&link).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "inviteUrl": "https://console.example/invite/t#k=x",
                "inviteId": "abc123",
                "role": "reader",
                "expiresInSecs": 3600,
                "maxUses": 1,
            })
        );
    }

    fn access_listing() -> DriveMembersResponse {
        serde_json::from_value(serde_json::json!({
            "members": [
                {"member_ss58": "5Me", "role": "manager", "created_at": "t"},
                {"member_ss58": "5Ann", "role": "writer", "created_at": "t", "member_name": " Ann ", "member_email": ""},
            ],
            "folder_grants": [
                {"member_ss58": "5Bo", "path_prefix": "Clients", "role": "reader", "created_at": "t"},
                {"member_ss58": "5Bo", "path_prefix": "Clients/ACME", "role": "writer", "created_at": "t"},
                {"member_ss58": "5Bo", "path_prefix": "Work", "role": "reader", "created_at": "t"},
                {"member_ss58": "5Cy", "path_prefix": "Clients/ACME Photos", "role": "writer", "created_at": "t"},
                {"member_ss58": "5Di", "path_prefix": "Clients/ACME/2026", "role": "reader", "created_at": "t"},
            ],
        }))
        .expect("listing")
    }

    fn mailed_invite(id: &str, path: Option<&str>, status: Option<&str>, valid: bool) -> DriveInviteInfo {
        serde_json::from_value(serde_json::json!({
            "invite_id": id, "role": "reader", "expires_at": "2026-10-01T00:00:00Z", "max_uses": 1,
            "use_count": 0, "revoked": false, "valid": valid, "created_at": "t",
            "path_prefix": path, "email_status": status, "recipient_email": "a@example.com",
        }))
        .expect("invite")
    }

    #[test]
    fn a_drive_dialog_lists_members_and_its_own_pending_emails() {
        let invites = vec![
            mailed_invite("drive-mail", None, Some("awaiting_seal"), true),
            mailed_invite("folder-mail", Some("Clients/ACME"), Some("sent"), true),
            mailed_invite("a-link", None, None, true),
            mailed_invite("dead-mail", None, Some("sent"), false),
        ];
        let access = fold_share_access("5Me", "5Owner", None, access_listing(), invites);
        assert_eq!(access.owner_ss58, "5Owner");
        assert!(!access.owner_is_you, "a former manager is not the owner");
        let people: Vec<(&str, &str, bool)> = access
            .members
            .iter()
            .map(|m| (m.member_ss58.as_str(), m.role.as_str(), m.is_you))
            .collect();
        assert_eq!(
            people,
            [("5Me", "writer", true), ("5Ann", "writer", false)],
            "a wire manager reads as an Editor"
        );
        assert_eq!(access.members[1].member_name.as_deref(), Some("Ann"));
        assert_eq!(access.members[1].member_email, None, "a blank email is absent");
        assert!(access.folder_holders.is_empty(), "holders are not drive members");
        let pending: Vec<&str> = access.pending_invites.iter().map(|i| i.invite_id.as_str()).collect();
        assert_eq!(pending, ["drive-mail"], "only live emailed whole-drive invites");
    }

    /// Access-key and wallet accounts carry a system placeholder email; the
    /// Share dialog must fall back to the name or address, never show it.
    #[test]
    fn a_share_dialog_never_shows_a_placeholder_email() {
        let listing: DriveMembersResponse = serde_json::from_value(serde_json::json!({
            "members": [
                {"member_ss58": "5Ann", "role": "writer", "created_at": "t", "member_email": "user_ann@hippius.local"},
            ],
            "folder_grants": [
                {"member_ss58": "5Bo", "path_prefix": "Clients", "role": "reader", "created_at": "t", "member_email": "User_Bo@HIPPIUS.local"},
            ],
        }))
        .expect("listing");
        let drive = fold_share_access("5Owner", "5Owner", None, listing, Vec::new());
        assert_eq!(drive.members[0].member_email, None);
        let listing: DriveMembersResponse = serde_json::from_value(serde_json::json!({
            "members": [],
            "folder_grants": [
                {"member_ss58": "5Bo", "path_prefix": "Clients", "role": "reader", "created_at": "t", "member_email": "User_Bo@HIPPIUS.local"},
            ],
        }))
        .expect("listing");
        let folder = fold_share_access("5Owner", "5Owner", Some("Clients"), listing, Vec::new());
        assert_eq!(folder.folder_holders[0].member_email, None);
    }

    /// An older invitation minted as `manager` still reads as Editor, in the
    /// dialog's fold and in every invite listing.
    #[test]
    fn a_wire_manager_invite_reads_as_an_editor() {
        let mut mail = mailed_invite("drive-mail", None, Some("sent"), true);
        mail.role = "manager".into();
        let access = fold_share_access("5Owner", "5Owner", None, access_listing(), vec![mail]);
        assert_eq!(access.pending_invites[0].role, "writer");

        let mut row = mailed_invite("link", None, None, true);
        row.role = "manager".into();
        normalize_invite_fields(&mut row);
        assert_eq!(row.role, "writer");
    }

    #[test]
    fn a_folder_dialog_lists_whoever_holds_it_or_a_folder_around_it() {
        let invites = vec![
            mailed_invite("drive-mail", None, Some("sent"), true),
            mailed_invite("folder-mail", Some("Clients/ACME"), Some("sent"), true),
            mailed_invite("other-folder", Some("Work"), Some("sent"), true),
        ];
        let access = fold_share_access("5Owner", "5Owner", Some("Clients/ACME"), access_listing(), invites);
        assert!(access.owner_is_you);
        assert!(access.members.is_empty());
        assert_eq!(access.drive_member_count, 2);
        let holders: Vec<(&str, &str, &str, usize)> = access
            .folder_holders
            .iter()
            .map(|h| (h.member_ss58.as_str(), h.role.as_str(), h.path_prefix.as_str(), h.other_folder_count))
            .collect();
        // 5Bo holds Clients and Clients/ACME: the nearer grant describes them.
        // 5Cy's "ACME Photos" is a sibling, and 5Di's grant is below the folder.
        assert_eq!(holders, [("5Bo", "writer", "Clients/ACME", 2)]);
        let pending: Vec<&str> = access.pending_invites.iter().map(|i| i.invite_id.as_str()).collect();
        assert_eq!(pending, ["folder-mail"]);
    }

    #[test]
    fn share_access_wire_keys_are_pinned() {
        let access = fold_share_access("5Owner", "5Owner", Some("Clients"), access_listing(), Vec::new());
        let json = serde_json::to_value(&access).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "ownerSs58": "5Owner",
                "ownerIsYou": true,
                "members": [],
                "folderHolders": [{
                    "memberSs58": "5Bo", "role": "reader", "pathPrefix": "Clients", "otherFolderCount": 2,
                }],
                "pendingInvites": [],
                "driveMemberCount": 2,
            })
        );
        let drive = fold_share_access("5Owner", "5Owner", None, access_listing(), Vec::new());
        assert_eq!(
            serde_json::to_value(&drive.members[0]).expect("serialize"),
            serde_json::json!({ "memberSs58": "5Me", "role": "writer", "isYou": false })
        );
    }

    /// The FE reads the replace result by these keys (`ReplacedFolderGrants`
    /// in `sharedDrives.ts`), and an unknown stored role reads as a Viewer.
    #[test]
    fn replaced_folder_grants_wire_keys_are_pinned() {
        let replaced: ReplacedFolderGrants = hcfs_shared::network::ReplaceFolderGrantsResponse {
            member_ss58: "5H".into(),
            path_prefixes: vec!["A".into(), "B".into()],
            roles: vec!["writer".into(), "manager".into()],
        }
        .into();
        assert_eq!(
            serde_json::to_value(&replaced).expect("serialize"),
            serde_json::json!({ "memberSs58": "5H", "pathPrefixes": ["A", "B"], "roles": ["writer", "reader"] })
        );
    }

    /// `canWrite` is the one field the FE gates grant write controls on.
    #[test]
    fn my_folder_grant_info_wire_keys_are_pinned() {
        let info = MyFolderGrantInfo {
            owner_ss58: "5O".into(),
            owner_name: None,
            folder_hash: "h".into(),
            display_label: "d".into(),
            path_prefix: "Work".into(),
            role: "writer".into(),
            created_at: "t".into(),
            can_write: true,
            frozen: false,
            frozen_until: None,
        };
        assert_eq!(
            serde_json::to_value(&info).expect("serialize"),
            serde_json::json!({
                "ownerSs58": "5O",
                "folderHash": "h",
                "displayLabel": "d",
                "pathPrefix": "Work",
                "role": "writer",
                "createdAt": "t",
                "canWrite": true,
            })
        );
    }

    #[test]
    fn a_folder_replace_is_planned_before_any_request() {
        let (folders, role) = plan_folder_grant_replace(&["/Work/".into(), "Clients/ACME".into(), "Work".into()], Some("writer".into())).unwrap();
        assert_eq!(folders, ["Work", "Clients/ACME"], "normalised and de-duplicated");
        assert_eq!(role.as_deref(), Some("writer"));
        let (_, role) = plan_folder_grant_replace(&["Work".into()], None).unwrap();
        assert_eq!(role, None, "no role: the server keeps its Viewer default");
        assert!(plan_folder_grant_replace(&[], None).is_err(), "removing everything is Remove access");
        assert!(plan_folder_grant_replace(&[String::new()], None).is_err(), "never the whole drive");
        assert!(plan_folder_grant_replace(&["a/../b".into()], None).is_err());
        assert!(
            plan_folder_grant_replace(&["Work".into()], Some("manager".into())).is_err(),
            "manager is not a folder role"
        );
    }

    #[test]
    fn rate_limited_message_rounds_up() {
        assert!(rate_limited_message(Some(61)).contains("2 minutes"));
        assert!(rate_limited_message(Some(60)).contains("1 minute."));
        assert!(rate_limited_message(Some(3601)).contains("2 hours"));
        assert!(rate_limited_message(Some(5)).contains("5 seconds"));
        assert!(rate_limited_message(None).contains("later"));
    }

    #[test]
    fn email_errors_map_on_status_and_slug() {
        use reqwest::StatusCode;
        assert!(matches!(
            classify_email_invite_error(StatusCode::SERVICE_UNAVAILABLE, None, ""),
            AppError::NotReady(NotReadyKind::EmailInvitesUnavailable)
        ));
        assert!(matches!(
            classify_email_invite_error(StatusCode::TOO_MANY_REQUESTS, Some(30), r#"{"error":"rate_limited","message":"x"}"#),
            AppError::NotReady(NotReadyKind::RateLimited { .. })
        ));
        assert!(matches!(
            classify_email_invite_error(StatusCode::BAD_GATEWAY, None, r#"{"error":"mail_send_failed","message":"x"}"#),
            AppError::Validation(_)
        ));
        // Everything else keeps the shared-drive mapping.
        assert!(matches!(
            classify_email_invite_error(StatusCode::NOT_FOUND, None, ""),
            AppError::NotReady(NotReadyKind::SharedDrivesUnavailable)
        ));
        assert!(matches!(
            classify_email_invite_error(StatusCode::FORBIDDEN, None, r#"{"error":"shared_drives_not_entitled","message":"x"}"#),
            AppError::NotReady(NotReadyKind::SharedDrivesNotEntitled)
        ));
    }

    #[test]
    fn the_probe_hides_email_only_when_the_server_says_no_mail() {
        assert!(!email_probe_says_available(&Err(AppError::NotReady(
            NotReadyKind::EmailInvitesUnavailable
        ))));
        assert!(!email_probe_says_available(&Err(AppError::NotReady(
            NotReadyKind::SharedDrivesUnavailable
        ))));
        assert!(email_probe_says_available(&Err(AppError::Hcfs("400 invalid email".into()))));
        assert!(email_probe_says_available(&Ok("unexpected".into())));
    }

    fn mailed(id: &str, status: Option<&str>, pubkey: Option<&str>) -> DriveInviteInfo {
        DriveInviteInfo {
            invite_id: id.into(),
            email_status: status.map(str::to_string),
            requester_pubkey: pubkey.map(str::to_string),
            ..invite(true, false)
        }
    }

    #[test]
    fn approve_is_decided_by_status_not_by_the_key_being_present() {
        let rows = [
            mailed("waiting", Some("awaiting_seal"), Some("PUB")),
            // The key stays on the row after sealing; offering it again 409s.
            mailed("done", Some("sealed"), Some("PUB")),
            mailed("unopened", Some("sent"), None),
            mailed("link", None, None),
        ];
        assert_eq!(
            approvable_invite(&rows, "waiting").expect("approvable"),
            ApprovableInvite {
                requester_pubkey: "PUB".into(),
                path_prefix: None
            }
        );
        assert!(matches!(approvable_invite(&rows, "done"), Err(AppError::Validation(_))));
        assert!(matches!(approvable_invite(&rows, "unopened"), Err(AppError::Validation(_))));
        assert!(matches!(approvable_invite(&rows, "link"), Err(AppError::Validation(_))));
        assert!(matches!(approvable_invite(&rows, "gone"), Err(AppError::NotFound(_))));
        assert!(approvable_invite(&[mailed("x", Some("awaiting_seal"), Some("  "))], "x").is_err());
    }

    #[test]
    fn a_placeholder_invite_address_never_reaches_the_ui() {
        let mut row = DriveInviteInfo {
            recipient_email: Some(" user_abc@Hippius.Local ".into()),
            ..invite(true, false)
        };
        normalize_invite_fields(&mut row);
        assert_eq!(row.recipient_email, None);
        let mut row = DriveInviteInfo {
            recipient_email: Some("ada@example.com".into()),
            ..invite(true, false)
        };
        normalize_invite_fields(&mut row);
        assert_eq!(
            row.recipient_email.as_deref(),
            Some("ada@example.com"),
            "an address the owner typed is kept"
        );
    }

    #[test]
    fn unknown_email_stages_and_blank_addresses_never_reach_the_ui() {
        let mut row = DriveInviteInfo {
            recipient_email: Some("  ".into()),
            email_status: Some("bounced".into()),
            requester_ss58: Some(" 5Ada ".into()),
            ..invite(true, false)
        };
        normalize_invite_fields(&mut row);
        assert_eq!(row.recipient_email, None);
        assert_eq!(row.email_status, None);
        assert_eq!(row.requester_ss58.as_deref(), Some("5Ada"));
        for known in EMAIL_STATUSES {
            let mut row = DriveInviteInfo {
                email_status: Some(known.into()),
                ..invite(true, false)
            };
            normalize_invite_fields(&mut row);
            assert_eq!(row.email_status.as_deref(), Some(known));
        }
    }

    /// An approval seals what a link would have carried: entropy for a whole
    /// drive, the derived file key for a folder.
    #[test]
    fn the_sealed_payload_matches_the_link_mint() {
        let phrase = Zeroizing::new(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        );
        use crate::sync::remote::DriveKeyMaterial;
        let drive = sealed_invite_payload(DriveKeyMaterial::Phrase(phrase.clone()), false).expect("drive");
        assert_eq!(*drive, *grant::entropy_from_phrase(&phrase).unwrap());
        let folder = sealed_invite_payload(DriveKeyMaterial::Phrase(phrase.clone()), true).expect("folder");
        assert_eq!(*folder, crate::sync::remote::encryption_key_from_phrase(&phrase).unwrap());
        assert_ne!(*drive, *folder, "the two keys must not be confused");

        // A folder grant holder carries only the derived key: enough for a
        // folder invite, refused by name for a whole-drive one.
        let key = Zeroizing::new(*folder);
        let again = sealed_invite_payload(DriveKeyMaterial::FileKey(key.clone()), true).expect("folder from key");
        assert_eq!(*again, *folder);
        assert!(matches!(
            sealed_invite_payload(DriveKeyMaterial::FileKey(key), false),
            Err(AppError::Validation(_))
        ));
    }

    fn grants_fixture() -> hcfs_shared::network::DriveMembershipsResponse {
        serde_json::from_value(serde_json::json!({
            "memberships": [{"owner_ss58":"5O","folder_hash":"whole","role":"writer","grant_blob":"DRIVE","display_label":"d","created_at":"t"}],
            "folder_grants": [
                {"owner_ss58":"5O","folder_hash":"whole","display_label":"d","path_prefix":"a","role":"writer","grant_blob":"FOLDER-ON-WHOLE","created_at":"t"},
                {"owner_ss58":"5O","folder_hash":"part","display_label":"d","path_prefix":"a","role":"writer","grant_blob":"","created_at":"t"},
                {"owner_ss58":"5O","folder_hash":"part","display_label":"d","path_prefix":"b","role":"writer","grant_blob":"FOLDER","created_at":"t"}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn a_granted_folder_reads_only_that_folder_and_below() {
        assert!(in_scope(None, None), "an owner sees whole-drive rows");
        assert!(in_scope(None, Some("a/b")));
        assert!(in_scope(Some("Clients"), Some("Clients")));
        assert!(in_scope(Some("Clients"), Some("Clients/ACME")));
        assert!(!in_scope(Some("Clients"), Some("Clientsx")));
        assert!(!in_scope(Some("Clients/ACME"), Some("Clients")), "never above");
        assert!(!in_scope(Some("Clients"), None), "never a whole-drive invite");
    }

    #[test]
    fn a_whole_drive_membership_wins_over_a_folder_grant() {
        assert_eq!(pick_member_grant(&grants_fixture(), "5O", "whole").unwrap(), ("DRIVE", false));
    }

    #[test]
    fn a_folder_grant_is_opened_as_a_folder_key_and_empty_blobs_are_skipped() {
        assert_eq!(pick_member_grant(&grants_fixture(), "5O", "part").unwrap(), ("FOLDER", true));
        assert!(matches!(pick_member_grant(&grants_fixture(), "5X", "part"), Err(AppError::Validation(_))));
    }
}
