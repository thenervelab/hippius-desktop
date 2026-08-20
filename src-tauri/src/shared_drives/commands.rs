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
//! **Invite revocation is deliberately NOT surfaced in v1**: the server's
//! `DELETE /v1/drive-invites/{token}` takes the PLAINTEXT token, which exists
//! only in the mint response (the server stores its blake3 hash and exposes
//! no list-invites endpoint). The desktop deliberately never persists minted
//! tokens — a stored token is a stored drive-access capability — so after the
//! mint dialog closes there is nothing an owner could select to revoke.
//! Owners revoke ACCESS by removing members; unclaimed links die by expiry /
//! max-uses. A revoke IPC would need a server-side invite listing first.
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
use serde::Serialize;
use tauri::Manager;
use tracing::{info, warn};
use zeroize::Zeroizing;

/// Bound on every shared-drive HTTP call (the `recent_uploads` precedent —
/// these back interactive dialogs, not bulk transfers).
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
}

/// One drive shared WITH this account ("Shared with me" row). The sealed
/// `grant_blob` is deliberately NOT here: it opens only inside
/// [`add_shared_drive`], never in the renderer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveMembershipInfo {
    pub owner_ss58: String,
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
/// "no such invite/member/drive" and maps to `NotFound`. 401/403 map to
/// `Auth`; anything else is a surfaced `Hcfs` transport/server error.
fn classify_error_status(status: reqwest::StatusCode, body: &str) -> AppError {
    #[derive(serde::Deserialize)]
    struct ErrorEnvelope {
        #[expect(dead_code, reason = "presence of the field is the discriminator; the message carries the info")]
        error: String,
        message: String,
    }

    let envelope: Option<ErrorEnvelope> = serde_json::from_str(body).ok();
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
pub async fn http_create_invite(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    expires_in_secs: Option<u64>,
    max_uses: Option<u32>,
) -> Result<String> {
    let req = CreateDriveInviteRequest {
        folder_hash: folder_hash.to_string(),
        expires_in_secs,
        max_uses,
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
pub async fn http_list_members(http: &reqwest::Client, base_url: &str, bearer: &str, folder_hash: &str) -> Result<DriveMembersResponse> {
    let resp = http
        .get(format!("{}/v1/drives/{}/members", base_url.trim_end_matches('/'), folder_hash))
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
struct ApiCtx {
    account_id: String,
    base_url: String,
    bearer: String,
}

/// Resolve the session account, the concrete regional base URL, and the
/// bearer token — the `recent_uploads::fetch_search_files` plumbing.
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
    let identity = crate::sync::identity::resolve_drive_identity(pool, account_id, label).await?;
    if identity.is_member {
        return Err(AppError::Validation(format!(
            "'{label}' is a drive shared with you — only its owner can manage invites and members"
        )));
    }
    Ok(identity)
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
) -> Result<DriveInviteLink> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_own_drive(state.pool()?, &ctx.account_id, &label).await?;

    // The folder-key entropy the link's fragment carries. The master read is
    // serialized against password rotation (`recovery_lock`), the sanctioned
    // accessor discipline for every master-mnemonic consumer. `Zeroizing`
    // means every return path — including the HTTP error below — scrubs the
    // entropy by drop, with no manual zeroize choreography to miss.
    let entropy: Zeroizing<[u8; 32]> = {
        let _recovery_guard = state.recovery_lock.lock().await;
        let master = crate::sync::mnemonic::get_mnemonic_for_account(&state, &ctx.account_id).await?;
        let phrase = Zeroizing::new(crate::sync::mnemonic::derive_folder_mnemonic(&master, &label)?);
        grant::entropy_from_phrase(&phrase)?
    };

    let http = state.api_client.clone();
    let token = http_create_invite(&http, &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash, expires_in_secs, max_uses).await?;

    let invite_url = build_invite_url(&crate::shares::commands::console_base_url(), &token, &entropy);

    info!(label = %label, folder_hash = %identity.wire_folder_hash, "Drive invite minted");
    Ok(DriveInviteLink { invite_url })
}

/// List the members of an OWN drive.
#[tauri::command]
pub async fn list_drive_members(app: tauri::AppHandle, label: String) -> Result<Vec<DriveMemberInfo>> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_own_drive(state.pool()?, &ctx.account_id, &label).await?;

    let resp = http_list_members(&state.api_client.clone(), &ctx.base_url, &ctx.bearer, &identity.wire_folder_hash).await?;
    Ok(resp
        .members
        .into_iter()
        .map(|m| DriveMemberInfo {
            member_ss58: m.member_ss58,
            role: m.role,
            created_at: m.created_at,
        })
        .collect())
}

/// Remove a member from an OWN drive (the owner path — revocation of access).
/// The member's next request is denied server-side; their drive surfaces the
/// revoked state on its next sync cycle (Task 5).
#[tauri::command]
pub async fn remove_drive_member(app: tauri::AppHandle, label: String, member_ss58: String) -> Result<()> {
    let state = app.state::<AppState>();
    let ctx = api_ctx(&state).await?;
    let identity = resolve_own_drive(state.pool()?, &ctx.account_id, &label).await?;

    // Owner path: the server keys the delete by the caller's own identity;
    // no `?owner=` (that param exists for the self-leave branch).
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
            folder_hash: m.folder_hash,
            display_label: m.display_label,
            role: m.role,
            created_at: m.created_at,
            synced_locally: local.is_some(),
            local_label: local.map(|row| row.label),
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

    // FE wire pin: the "Shared with me" row's camelCase keys, including the
    // local-sync join (`syncedLocally`/`localLabel`) Task 6 routes on. A
    // dropped or renamed key ships as a silently-undefined FE field, so the
    // key set is asserted exactly. `localLabel` stays present (null) when the
    // drive is not synced here — a stable shape, not a conditional key.
    #[test]
    fn drive_membership_info_wire_keys_are_pinned() {
        let info = DriveMembershipInfo {
            owner_ss58: "5Owner".to_string(),
            folder_hash: "0123456789abcdef".to_string(),
            display_label: "team-docs".to_string(),
            role: "writer".to_string(),
            created_at: "2026-08-20T00:00:00Z".to_string(),
            synced_locally: false,
            local_label: None,
        };
        let json = serde_json::to_value(&info).expect("serialize");
        let keys: std::collections::BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "createdAt",
                "displayLabel",
                "folderHash",
                "localLabel",
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
    }
}
