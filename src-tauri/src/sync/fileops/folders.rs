//! Remote folder management: listing, restoring, and deleting remote folders.
//!
//! Contains commands and helpers for interacting with the remote folder
//! registry on the HCFS server, plus the combined local+remote folder
//! listing used by the sync manager UI.

use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::error::Result;
use crate::sync::config::{get_hcfs_config_internal, normalize_for_region_probe};
use crate::sync::lifecycle::start_sync_loop;
use crate::sync::lifecycle::{initialize_sync_inner, remove_drive_for_account};
use crate::sync::mnemonic::{config_dir_for_folder, folder_hash};
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A local sync folder with its status and remote stats pre-joined.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFolderInfo {
    pub id: String,
    pub folder_name: String,
    pub local_path: String,
    pub status: String,
    pub file_count: Option<u64>,
    pub total_bytes: Option<u64>,
    pub last_modified: Option<i64>,
    /// The drive OWNER's ss58 when this row is a MEMBER drive (shared with
    /// this account), `None` for the account's own drives. The FE keys the
    /// owner badge and the member-vs-own menu gating off this field — it is
    /// the listing's only member/own discriminant, threaded in Rust because
    /// the wire identity lives on the `sync_paths` row and must never be
    /// inferred in TypeScript.
    pub owner_ss58: Option<String>,
}

/// Why a server folder is absent from this device's `sync_paths`.
///
/// `remove_drive` deletes the local row but does NOT unregister the server
/// folder (that is Delete from Server). The folder therefore stays on the
/// server stamped with THIS device's `device_name`. Listing it under
/// "Sync from Other Devices" is a lie; the FE keys the section split on
/// this tagged field, never by comparing names itself.
///
/// Wire format matches `DriveStatus`: `{"kind": "locallyRemoved"}` /
/// `{"kind": "otherDevice"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteFolderOrigin {
    LocallyRemoved,
    OtherDevice,
}

/// Classify a remote-only folder as locally-removed vs. another device.
///
/// Empty `device_name` cannot prove this machine registered the folder
/// (the display fallback is "Unknown Device"), so it stays `OtherDevice`.
/// Two empty names also fail closed: `get_device_name_internal` never
/// returns empty, and matching empties would bucket unknown rows here.
pub(crate) fn classify_remote_origin(device_name: &str, local_device_name: &str) -> RemoteFolderOrigin {
    if !device_name.is_empty() && !local_device_name.is_empty() && device_name == local_device_name {
        RemoteFolderOrigin::LocallyRemoved
    } else {
        RemoteFolderOrigin::OtherDevice
    }
}

/// Display row for a remote-only folder.
///
/// Classify on the RAW server name, not the "Unknown Device" fallback.
/// A locally-removed folder still carries this machine's name on the
/// server; sending that through made Settings / Drive label it as this
/// computer under "Not synced on this computer" (H-112). Blank the
/// name so the FE subtitle (`deviceName && …`) stays off.
fn remote_folder_display(f: &RemoteFolderInfoResult, local_device_name: &str) -> RemoteFolderDisplay {
    let origin = classify_remote_origin(&f.device_name, local_device_name);
    let ts = if f.updated_at != 0 { f.updated_at } else { f.created_at };
    let device_name = match origin {
        RemoteFolderOrigin::LocallyRemoved => String::new(),
        RemoteFolderOrigin::OtherDevice if f.device_name.is_empty() => "Unknown Device".to_string(),
        RemoteFolderOrigin::OtherDevice => f.device_name.clone(),
    };
    RemoteFolderDisplay {
        folder_name: f.label.clone(),
        device_name,
        file_count: f.file_count,
        total_bytes: f.total_bytes,
        last_modified: ts * 1000,
        origin,
    }
}

/// A remote-only folder (not synced locally) for the browser UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolderDisplay {
    pub folder_name: String,
    pub device_name: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub last_modified: i64,
    /// Machine-readable bucket. The FE renders a distinct section for
    /// `LocallyRemoved` and must not re-derive this from `device_name`.
    pub origin: RemoteFolderOrigin,
}

/// Combined local + remote folder lists, ready for UI rendering.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFoldersResult {
    pub local: Vec<SyncFolderInfo>,
    pub remote: Vec<RemoteFolderDisplay>,
}

#[derive(serde::Serialize, Clone)]
pub struct RemoteFolderInfoResult {
    pub label: String,
    pub folder_hash: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub device_name: String,
}

#[derive(serde::Deserialize)]
pub struct RestoreFolderRequest {
    pub label: String,
}

#[derive(serde::Serialize, Clone)]
pub struct RestoreResult {
    pub label: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct DeleteRemoteFolderResult {
    pub files_deleted: u64,
    pub was_local: bool,
}

pub(crate) fn sanitize_label(label: &str) -> Result<String> {
    let sanitized: String = label
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ' || *c == '.')
        .collect();
    let trimmed = sanitized.trim_matches('.').trim();
    if trimmed.is_empty() {
        // Rejected user input (a label that sanitizes to empty) → Validation;
        // the FE renders these messages directly.
        return Err(crate::error::AppError::Validation(format!("Invalid folder label: '{label}'")));
    }
    Ok(trimmed.to_string())
}

/// On-disk destination for a remote-folder restore.
///
/// The picker is "choose a parent", so the dest is normally
/// `base_path / label`. If the user picked the folder itself — the last
/// component already equals the sanitized label — joining again nests
/// `label/label` and Drive opens an empty tree (H-115).
pub(crate) fn restore_dest_path(base_path: &Path, safe_label: &str) -> PathBuf {
    match base_path.file_name().and_then(|n| n.to_str()) {
        Some(name) if name == safe_label => base_path.to_path_buf(),
        _ => base_path.join(safe_label),
    }
}

/// Query all sync paths for an account directly from the DB (no Tauri state params).
pub(crate) async fn get_all_sync_paths_internal(pool: &SqlitePool, account_id: &str) -> Result<Vec<crate::sync::paths::SyncPathResult>> {
    use sqlx::Row;
    let owner = account_key(account_id);
    let rows = sqlx::query("SELECT path, type, label, is_paused FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .iter()
        .map(|row| {
            let path_type: String = row.get("type");
            let paused_int: i32 = row.try_get("is_paused").unwrap_or(0);
            crate::sync::paths::SyncPathResult {
                path: row.get("path"),
                is_public: path_type == "public",
                label: row.try_get("label").unwrap_or_else(|_| "default".to_string()),
                is_paused: paused_int != 0,
            }
        })
        .collect())
}

/// [`get_all_sync_paths_internal`] degrading to an empty list on a DB error,
/// with a `warn!` tagged by `context` so the failure is observable.
///
/// Read-only listing/search IPCs prefer "show nothing" over failing the whole
/// call when the sync-paths query errors; centralizing the degrade here keeps
/// the policy and log shape consistent across the (5) call sites instead of a
/// copy-pasted `unwrap_or_else` closure at each.
pub(crate) async fn get_all_sync_paths_or_warn(pool: &SqlitePool, account_id: &str, context: &str) -> Vec<crate::sync::paths::SyncPathResult> {
    get_all_sync_paths_internal(pool, account_id).await.unwrap_or_else(|e| {
        tracing::warn!(error = %e, context, "get_all_sync_paths_internal failed; treating as no configured drives");
        Vec::new()
    })
}

/// Internal helper to list remote folders without Tauri State params.
pub(crate) async fn list_remote_folders_internal(pool: &SqlitePool, account_id: &str) -> Result<Vec<RemoteFolderInfoResult>> {
    let config = get_hcfs_config_internal(pool, account_id).await?;
    // Empty string is hcfs-client's region-probe sentinel; legacy
    // single-region URL gets rewritten to empty so existing users
    // transparently opt in. See `normalize_for_region_probe`.
    let server_url = normalize_for_region_probe(&config.server_url);

    // A missing token stays the surfaced catch-all `Other`, deliberately NOT
    // `Auth`: the FE treats `Auth`/`NotReady` as expected no-session noise
    // (errorUtils `isExpectedNoSessionError`) and dispatches on them, so a
    // genuine token-missing on a user-driven folder op must surface as a plain
    // error rather than be swallowed. (See the migration-slice decision.)
    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found".into()))?;

    // Account-scoped listing under the caller's own identity (empty folder
    // hash — the endpoint keys off the bearer token alone), so the identity
    // is structurally own-drive and no resolver lookup applies.
    let client_config =
        crate::sync::config::build_hcfs_config(&server_url, &bearer_token, &crate::sync::identity::DriveIdentity::own(account_id, ""));

    let client = hcfs_client::client::HcfsClient::new(client_config).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    let folders = client
        .list_remote_folders(account_id)
        .await
        .map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    Ok(folders
        .into_iter()
        .map(|f| RemoteFolderInfoResult {
            label: f.label,
            folder_hash: f.folder_hash,
            file_count: f.file_count,
            total_bytes: f.total_bytes,
            created_at: f.created_at,
            updated_at: f.updated_at,
            device_name: f.device_name,
        })
        .collect())
}

/// List all folders registered for the current account on the remote server.
#[tauri::command]
pub async fn list_remote_folders(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<Vec<RemoteFolderInfoResult>> {
    // Enumerates another account's remote folders under its token; authorize
    // against the session (sibling delete_remote_folder is already guarded).
    let account_id = state.require_session_account(&account_id)?;
    info!("Listing remote folders for account '{}'", account_id);
    let pool = state.pool()?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    // See `normalize_for_region_probe` — empty signals hcfs-client to
    // race the regional endpoints; legacy single-region URL also empties.
    let server_url = normalize_for_region_probe(&config.server_url);

    // Surfaced catch-all Other (not FE-silenced Auth) — see list_remote_folders_internal.
    let bearer_token = get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;

    // Account-scoped listing under the caller's own identity — see
    // list_remote_folders_internal.
    let client_config =
        crate::sync::config::build_hcfs_config(&server_url, &bearer_token, &crate::sync::identity::DriveIdentity::own(&account_id, ""));

    let client = hcfs_client::client::HcfsClient::new(client_config).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    let folders = client.list_remote_folders(&account_id).await.map_err(|e| {
        error!("Failed to list remote folders for account '{}': {e}", account_id);
        crate::error::AppError::Hcfs(format!("Failed to list remote folders: {e}"))
    })?;

    info!("Found {} remote folders for account '{}'", folders.len(), account_id);

    Ok(folders
        .into_iter()
        .map(|f| RemoteFolderInfoResult {
            label: f.label,
            folder_hash: f.folder_hash,
            file_count: f.file_count,
            total_bytes: f.total_bytes,
            created_at: f.created_at,
            updated_at: f.updated_at,
            device_name: f.device_name,
        })
        .collect())
}

/// Restore a single remote folder: create directory, set DB path, wipe stale
/// state, and initialize sync (without starting the loop).
async fn restore_single_folder(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    account_id: &str,
    base_path: &str,
    label: &str,
    existing_mnemonic: Option<&str>,
) -> Result<()> {
    let safe_label = sanitize_label(label)?;
    let folder_path = restore_dest_path(Path::new(base_path), &safe_label);

    std::fs::create_dir_all(&folder_path)?;

    let path_str = folder_path.to_string_lossy().to_string();

    crate::sync::paths::set_sync_path_internal(pool, account_id, &path_str, false, crate::sync::paths::LabelMode::Exact(label)).await?;

    // Wipe stale sync state so the three-tree algorithm treats all remote
    // files as RemoteCreate (download), not LocalDelete.
    if let Ok(fd) = config_dir_for_folder(account_id, label) {
        for name in &["sync_state.json", "sync_state.json.bak"] {
            let p = fd.join(name);
            if p.exists() {
                info!("Removing stale {} for '{}' to prevent remote deletions", name, label);
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    initialize_sync_inner(
        app.clone(),
        account_id.to_string(),
        label.to_string(),
        existing_mnemonic.map(String::from),
        false,
        false,
        None,
    )
    .await?;

    info!("Successfully restored remote folder '{}'", label);
    Ok(())
}

/// Restore multiple remote folders by creating local sync paths and initializing sync.
///
/// Initializes each folder without restarting the sync loop, then starts the
/// loop once at the end so all restored drives are picked up in a single pass.
#[tauri::command]
pub async fn restore_remote_folders(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
    base_path: String,
    folders: Vec<RestoreFolderRequest>,
    existing_mnemonic: Option<String>,
) -> Result<Vec<RestoreResult>> {
    let account_id = state.require_session_account(&account_id)?;
    info!(
        "Restoring {} remote folder(s) to '{}' for account '{}'",
        folders.len(),
        base_path,
        account_id
    );
    let pool = state.pool()?;

    // Fan out per-folder restore concurrently — each `restore_single_folder`
    // does HCFS server probe + DB writes + drive bootstrap, none of which
    // share mutable state across folders. For N folders this turns
    // sum(N) latency into max(N) latency. We pass `start_loop=false` to
    // each and start the sync loop once at the end so all restored drives
    // are picked up in a single pass (preserving the prior behavior).
    let restore_futures = folders.iter().map(|folder| {
        let app = app.clone();
        let account_id = account_id.clone();
        let base_path = base_path.clone();
        let label = folder.label.clone();
        let existing_mnemonic = existing_mnemonic.clone();
        async move {
            let outcome = restore_single_folder(&app, pool, &account_id, &base_path, &label, existing_mnemonic.as_deref()).await;
            (label, outcome)
        }
    });
    let outcomes = futures_util::future::join_all(restore_futures).await;

    let mut results = Vec::with_capacity(outcomes.len());
    let mut any_success = false;
    for (label, outcome) in outcomes {
        match outcome {
            Ok(()) => {
                any_success = true;
                results.push(RestoreResult {
                    label,
                    success: true,
                    error: None,
                });
            }
            Err(e) => {
                error!("Failed to restore remote folder '{}': {e}", label);
                if let Err(rollback_err) = crate::sync::paths::remove_sync_path_internal(pool, &account_id, &label).await {
                    warn!("Failed to rollback sync path for '{}': {rollback_err}", label);
                }
                results.push(RestoreResult {
                    label,
                    success: false,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    if any_success {
        start_sync_loop(app.clone()).await;
    }

    Ok(results)
}

/// Delete all files for a folder from the remote server and unregister it.
///
/// If the folder is also synced locally, tears the drive down FIRST and only
/// then wipes the server side. The ordering matters: once `unregister_folder`
/// lands, the server reports zero files for this folder. If the local drive
/// is still active and the sync loop fires (either an in-flight cycle or the
/// next tick), it sees "remote is empty" and mirrors that back onto disk —
/// deleting every local file the user actually wants to keep. By calling
/// `remove_drive_for_account` first we cancel any in-flight sync, drop the drive from the
/// in-memory map (so no new sync cycle can pick it up), and delete the
/// `sync_paths` row so cold restarts don't resurrect it. Files on disk are
/// left untouched.
///
/// If `remove_drive_for_account` fails we bail before touching the server — that way the
/// user's local state is exactly as they found it and they can retry. If the
/// server call fails after a successful local teardown, the user's files are
/// still safe on disk; they can re-add the folder pointing at the same path
/// and the next sync will reconcile against whatever is left on the server,
/// and they can retry the remote deletion once it's reachable. Note that
/// `remove_drive_for_account` now also wipes the on-disk sync baseline, so the re-add
/// runs a full reconciliation pass instead of resuming from the prior
/// `synced` tree — see the `clear_persisted_sync_state` helper in
/// `lifecycle.rs` for the data-loss bug that motivated that change.
#[tauri::command]
pub async fn delete_remote_folder(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
) -> Result<DeleteRemoteFolderResult> {
    // Destructive server delete under the account's token; authorize against
    // the session, not the webview-supplied account_id.
    let account_id = state.require_session_account(&account_id)?;
    info!("Deleting remote folder '{}' for account '{}'", label, account_id);
    let pool = state.pool()?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    // See `normalize_for_region_probe` — empty signals hcfs-client to
    // race the regional endpoints; legacy single-region URL also empties.
    let server_url = normalize_for_region_probe(&config.server_url);

    // Surfaced catch-all Other (not FE-silenced Auth) — see list_remote_folders_internal.
    let bearer_token = get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;

    let fhash = folder_hash(&label);

    // Snapshot "was this folder locally synced" before we tear anything down,
    // so the result we hand back to the FE matches the pre-deletion state the
    // user was looking at.
    //
    // Sourced from `sync_paths`, NOT from `state.sync.drives`: that map holds
    // only drives whose sync loop is currently registered, so a PAUSED drive is
    // missing from it, as is one whose init hasn't finished on a slow login.
    // Keying the teardown off the map therefore skipped it for exactly those
    // drives, with two consequences: the row survived the server wipe, so the
    // folder kept rendering in "Local Sync Folders" with blank stats forever;
    // and the drive stayed configured, so resuming it ran the engine's
    // pre-cycle folder check, which for an OWN drive re-registers the missing
    // folder, discards the local baseline, and re-uploads the whole tree the
    // user had just paid to delete. Same "map presence is not user intent"
    // conflation `get_sync_folders_with_stats` below already had to fix for
    // the status column. A DB failure bails before the server is touched,
    // which is the same posture as a failed teardown.
    let was_local = crate::sync::paths::sync_path_exists(pool, &account_id, &label).await?;

    if was_local {
        // Pass the explicit account (parity with `remove_sync_path`) so the
        // baseline wipe stays account-correct even if the session flips mid-call.
        remove_drive_for_account(app, label.clone(), Some(account_id.clone())).await?;
    }

    // Deleting the caller's OWN remote folder — a member cannot unregister
    // the owner's drive through this path, so the identity is structurally
    // own-drive (label → hash derivation) rather than resolver-supplied.
    let client_config = crate::sync::config::build_hcfs_config(
        &server_url,
        &bearer_token,
        &crate::sync::identity::DriveIdentity::own(&account_id, &fhash),
    );

    let client = hcfs_client::client::HcfsClient::new(client_config).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    let files_deleted = match client.unregister_folder(&account_id, &fhash).await {
        Ok(result) => result.files_deleted,
        Err(e) => {
            // hcfs-server commits the folder-row delete before its long,
            // best-effort per-chunk storage cleanup, so on a large folder the
            // client's read can time out AFTER the delete is already durable.
            // Re-list the account's remote folders: if this one is gone, the
            // delete succeeded and propagating the error would be a FALSE
            // failure (the FE would show "failed" for a folder that is actually
            // deleted, then 0 folders on the next refresh).
            warn!("unregister_folder('{label}') errored; re-checking remote state: {e}");
            let listed = list_remote_folders_internal(pool, &account_id)
                .await
                .ok()
                .map(|folders| folders.into_iter().map(|f| f.folder_hash).collect::<Vec<_>>());
            if remote_folder_absent(&fhash, listed.as_deref()) {
                info!("Remote folder '{label}' already absent after the error — treating the delete as successful (idempotent)");
                0
            } else {
                // Still present (or the re-check itself failed) — a genuine failure.
                return Err(crate::error::AppError::Hcfs(e.to_string()));
            }
        }
    };

    info!("Remote folder '{label}' deleted: {files_deleted} files removed, was_local={was_local}");

    Ok(DeleteRemoteFolderResult { files_deleted, was_local })
}

/// After an `unregister_folder` error, decide whether the remote folder is
/// nonetheless gone — i.e. the delete was durable and the error was only a late
/// read timeout over the server's already-committed delete.
///
/// `listed` is the account's current remote folder hashes, or `None` when the
/// re-list itself failed; in the `None` case we cannot confirm the delete and
/// must treat the original error as real (returns `false`). Pure so the
/// decision is unit/proptest-testable without a live server.
fn remote_folder_absent(fhash: &str, listed: Option<&[String]>) -> bool {
    match listed {
        Some(hashes) => !hashes.iter().any(|h| h == fhash),
        None => false,
    }
}

/// Return all sync folders with their stats pre-joined from local DB + remote server.
///
/// Replaces the `loadFolders()` orchestration in `MultiFolderSyncManager.tsx`
/// that was doing parallel fetches, map creation, status checks, and sorting
/// in TypeScript.
#[tauri::command]
pub async fn get_sync_folders_with_stats(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<SyncFoldersResult> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;

    // Parallel fetch: local paths + remote folders + this machine's
    // registered device name (the discriminator for H-077).
    let (sync_paths, remote_folders, local_device_name) = tokio::join!(
        get_all_sync_paths_internal(pool, &account_id),
        async { list_remote_folders_internal(pool, &account_id).await.unwrap_or_default() },
        crate::sync::device::get_device_name_internal(pool),
    );
    let sync_paths = sync_paths.unwrap_or_default();
    // Fail CLOSED on a read failure. `"My Device"` is `get_device_name_internal`'s
    // DEFAULT for a machine that never set a name, not a sentinel — substituting it
    // here would match every unnamed device's folders and file them under
    // "removed from this computer". The empty string proves nothing, which is
    // exactly what `classify_remote_origin` maps to `OtherDevice`.
    let local_device_name = local_device_name.unwrap_or_default();

    // Build remote lookup by folder_hash (NOT label). Two local folders with the
    // same BASENAME (e.g. haloce_mcc/tags + halo2_mcc/tags → labels "tags" and
    // "tags-2") are registered on the server under the same DISPLAY label "tags"
    // but distinct folder_hashes. folder_hash is derived from the unique label
    // and is what the server stores each folder's files under, so it is the
    // correct per-drive join key. Keying by label collapsed the two into one map
    // entry, so the second drive matched nothing (blank size/file count) and the
    // first could even show the other folder's stats. (No data was conflated —
    // only this display join was; files are correctly separated by folder_hash.)
    let remote_by_hash: HashMap<String, &RemoteFolderInfoResult> = remote_folders.iter().map(|f| (f.folder_hash.clone(), f)).collect();

    // Member drives (shared with this account) annotate their rows with the
    // drive owner's ss58 — see `SyncFolderInfo::owner_ss58`. A failure here
    // FAILS the whole listing: a transient DB error must never disarm the
    // member-row protections. Degrading to an empty map renders a member row
    // as an OWN row, re-arming "Delete from Server"/plain Remove — the exact
    // controls the data-keyed menu gating exists to withhold. A failed
    // listing is strictly safer than a wrong one, and the FE's polled
    // listing self-heals on the next tick.
    let member_owners = crate::sync::identity::member_owner_by_label(pool, &account_id).await?;

    // Build local folders with status and remote stats
    let mut local = Vec::with_capacity(sync_paths.len());
    for sp in &sync_paths {
        let folder_name = std::path::Path::new(&sp.path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&sp.label)
            .to_string();

        // Derive status purely from `is_paused` — the same source of truth
        // `get_all_drive_statuses` uses. The old code also required the
        // drive to be present in `state.sync.drives` and fell back to
        // "paused" when it wasn't, but that map is a sync-loop implementation
        // detail: a drive only lands in it after `initialize_sync_inner`
        // runs (from `auto_init_sync` on login, or an explicit
        // `resume_drive`). On any slow-path login — especially OAuth with
        // the Unlock-dialog recovery round-trip — the settings page loads
        // before auto_init_sync has populated the map, so every drive
        // showed "Paused" even though nothing had actually been paused.
        // Users then had to click "Resume" on drives that were never
        // paused. is_paused = user intent; presence in the in-memory map
        // = "sync loop currently running" — conflating them surfaced
        // "not yet initialised" as "user paused" and is the bug behind
        // the post-login paused-drive reports.
        let status = if sp.is_paused { "paused" } else { "syncing" }.to_string();

        // KNOWN GAP (shared drives v1): this join derives the hash from the
        // LOCAL label, so a MEMBER drive (whose wire hash is the owner's)
        // matches no remote row and shows blank stats — cosmetic only, and
        // the remote listing is own-account-scoped at the pinned rev anyway,
        // so a member-aware join has no server data to hit yet.
        let remote = remote_by_hash.get(&folder_hash(&sp.label));

        local.push(SyncFolderInfo {
            id: sp.label.clone(),
            folder_name,
            local_path: sp.path.clone(),
            status,
            file_count: remote.map(|r| r.file_count),
            total_bytes: remote.map(|r| r.total_bytes),
            last_modified: remote.map(|r| {
                let ts = if r.updated_at != 0 { r.updated_at } else { r.created_at };
                ts * 1000 // seconds → milliseconds
            }),
            owner_ss58: member_owners.get(&sp.label).cloned(),
        });
    }

    // Remote folders not configured locally. Match on folder_hash, not
    // label, for the same basename-collision reason above: a local "tags-2"
    // drive registers on the server under display label "tags", so a label
    // filter would fail to suppress it here.
    //
    // `remove_drive` leaves the server folder in place (Delete from Server
    // is the unregister path), so a folder this machine used to sync
    // reappears here stamped with THIS device_name. Classify that as
    // LocallyRemoved — the FE renders a distinct section; putting it
    // under "Sync from Other Devices" is the H-077 lie.
    let local_hashes: std::collections::HashSet<String> = sync_paths.iter().map(|sp| folder_hash(&sp.label)).collect();
    let mut remote_display: Vec<RemoteFolderDisplay> = remote_folders
        .iter()
        .filter(|f| !local_hashes.contains(&f.folder_hash))
        .map(|f| remote_folder_display(f, &local_device_name))
        .collect();
    remote_display.sort_by_key(|b| std::cmp::Reverse(b.last_modified));

    Ok(SyncFoldersResult {
        local,
        remote: remote_display,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ── remote-stats join (folder_hash, not label) ──────────────────

    fn remote(label: &str, hash_of_label: &str, file_count: u64) -> RemoteFolderInfoResult {
        RemoteFolderInfoResult {
            // Same DISPLAY label on the server for both folders (the bug: they
            // were registered under the basename), but distinct folder_hash.
            label: label.to_string(),
            folder_hash: folder_hash(hash_of_label),
            file_count,
            total_bytes: file_count * 1000,
            created_at: 0,
            updated_at: 0,
            device_name: String::new(),
        }
    }

    /// The join in `get_sync_folders_with_stats` MUST key on folder_hash. Two
    /// same-basename local folders (labels "tags" and "tags-2") register on the
    /// server under the SAME display label "tags" but distinct folder_hashes.
    /// Keying by label collapses them — the second drive shows blank stats and
    /// the first can show the wrong folder's. Keying by folder_hash joins each
    /// drive to its own remote stats. This pins that invariant.
    #[test]
    fn remote_stats_join_keys_on_folder_hash_not_label() {
        // Sanity: distinct unique labels hash distinctly even with same basename.
        assert_ne!(folder_hash("tags"), folder_hash("tags-2"));

        let remotes = [
            remote("tags", "tags", 988),   // haloce_mcc/tags  (label "tags")
            remote("tags", "tags-2", 512), // halo2_mcc/tags   (label "tags-2")
        ];
        let by_hash: HashMap<String, &RemoteFolderInfoResult> = remotes.iter().map(|f| (f.folder_hash.clone(), f)).collect();

        // Both same-basename local drives resolve to their OWN stats.
        assert_eq!(by_hash.get(&folder_hash("tags")).map(|r| r.file_count), Some(988));
        assert_eq!(by_hash.get(&folder_hash("tags-2")).map(|r| r.file_count), Some(512));

        // The old label-keyed map would collapse both into one entry, so the
        // second drive ("tags-2") would have matched nothing.
        let by_label: HashMap<String, &RemoteFolderInfoResult> = remotes.iter().map(|f| (f.label.clone(), f)).collect();
        assert_eq!(by_label.len(), 1, "label keying collapses same-basename folders (the bug)");
    }

    // ── remote origin (H-077: remove_drive is not another device) ───

    #[test]
    fn remote_folder_matching_local_device_name_is_locally_removed() {
        assert_eq!(
            classify_remote_origin("Georges-MacBook", "Georges-MacBook"),
            RemoteFolderOrigin::LocallyRemoved,
        );
    }

    fn sample_remote(device_name: &str) -> RemoteFolderInfoResult {
        RemoteFolderInfoResult {
            label: "docs".into(),
            folder_hash: "abc".into(),
            file_count: 1,
            total_bytes: 10,
            created_at: 0,
            updated_at: 1_700_000_000,
            device_name: device_name.into(),
        }
    }

    #[test]
    fn a_locally_removed_folder_has_no_device_name() {
        let row = remote_folder_display(&sample_remote("cursor"), "cursor");
        assert_eq!(row.origin, RemoteFolderOrigin::LocallyRemoved);
        assert_eq!(row.device_name, "");
    }

    #[test]
    fn an_other_device_folder_keeps_its_device_name() {
        let row = remote_folder_display(&sample_remote("Office PC"), "cursor");
        assert_eq!(row.origin, RemoteFolderOrigin::OtherDevice);
        assert_eq!(row.device_name, "Office PC");
    }

    #[test]
    fn an_unstamped_other_device_folder_falls_back_to_unknown() {
        let row = remote_folder_display(&sample_remote(""), "cursor");
        assert_eq!(row.origin, RemoteFolderOrigin::OtherDevice);
        assert_eq!(row.device_name, "Unknown Device");
    }

    #[test]
    fn remote_folder_from_a_different_device_is_other_device() {
        assert_eq!(classify_remote_origin("Office PC", "Georges-MacBook"), RemoteFolderOrigin::OtherDevice,);
    }

    #[test]
    fn empty_remote_device_name_is_other_device() {
        // Display falls back to "Unknown Device"; classification uses the
        // raw server value so we cannot claim this machine registered it.
        assert_eq!(classify_remote_origin("", "Georges-MacBook"), RemoteFolderOrigin::OtherDevice,);
    }

    #[test]
    fn empty_local_device_name_never_matches() {
        // `get_device_name_internal` never returns empty, but matching two
        // empties would bucket unknown/Console-unstamped rows as removed.
        assert_eq!(classify_remote_origin("", ""), RemoteFolderOrigin::OtherDevice);
        assert_eq!(classify_remote_origin("Georges-MacBook", ""), RemoteFolderOrigin::OtherDevice,);
    }

    /// The device-name read can fail (pool error). Its fallback must be
    /// unprovable, not a plausible name: `"My Device"` is
    /// `get_device_name_internal`'s DEFAULT for a machine that never set one,
    /// so substituting it would match every unnamed device's folders and file
    /// them under "removed from this computer".
    #[test]
    fn the_device_name_read_failure_fallback_is_unprovable() {
        assert_eq!(
            classify_remote_origin("My Device", &String::default()),
            RemoteFolderOrigin::OtherDevice,
            "an unread local name cannot prove this machine registered the folder",
        );

        // And the call site must actually reach that arm. A `String` literal in
        // the fallback is the regression: any name it invents is a name some
        // real device registered under, `"My Device"` most of all.
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/folders.rs")).expect("read folders.rs");
        let call = src
            .lines()
            .find(|l| l.contains("let local_device_name = local_device_name."))
            .expect("get_sync_folders_with_stats resolves local_device_name");
        assert!(
            call.contains("unwrap_or_default()"),
            "the device-name fallback must be the empty string, not an invented name: {call}",
        );
    }

    /// The discriminator is a display name, and `"My Device"` is the default
    /// every unnamed machine registers under — so two unnamed devices are
    /// indistinguishable and each files the other's folders as its own
    /// removals. Documented here rather than silently accepted; closing it
    /// needs a stable per-device id on the server row.
    #[test]
    fn two_default_named_devices_are_indistinguishable() {
        assert_eq!(
            classify_remote_origin("My Device", "My Device"),
            RemoteFolderOrigin::LocallyRemoved,
            "known limitation: the default name collides across devices",
        );
    }

    #[test]
    fn remote_folder_origin_wire_is_tagged_camel_case() {
        let removed = serde_json::to_value(RemoteFolderOrigin::LocallyRemoved).expect("serialize");
        let other = serde_json::to_value(RemoteFolderOrigin::OtherDevice).expect("serialize");
        assert_eq!(removed, serde_json::json!({"kind": "locallyRemoved"}));
        assert_eq!(other, serde_json::json!({"kind": "otherDevice"}));
    }

    /// FE wire pin: `RemoteFolderDisplay` camelCase keys, including the
    /// tagged `origin` the section split keys on. Dropping that field
    /// ships as a silently-undefined FE value and every removed folder
    /// falls back to "Sync from Other Devices".
    #[test]
    fn remote_folder_display_wire_keys_include_origin() {
        let info = RemoteFolderDisplay {
            folder_name: "docs".to_string(),
            device_name: "Georges-MacBook".to_string(),
            file_count: 3,
            total_bytes: 1200,
            last_modified: 1_700_000_000_000,
            origin: RemoteFolderOrigin::LocallyRemoved,
        };
        let json = serde_json::to_value(&info).expect("serialize");
        let keys: std::collections::BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["folderName", "deviceName", "fileCount", "totalBytes", "lastModified", "origin"]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>(),
            "RemoteFolderDisplay wire keys must stay exactly these camelCase names"
        );
        assert_eq!(json["origin"], serde_json::json!({"kind": "locallyRemoved"}));
    }

    // Static guard: `get_sync_folders_with_stats` must classify remote-only
    // rows through `classify_remote_origin` using this machine's
    // `get_device_name_internal` — a future refactor that drops either
    // call reintroduces H-077 (removed folders listed as other devices).
    #[test]
    fn get_sync_folders_with_stats_classifies_remote_origin() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/folders.rs")).expect("read folders.rs");
        let sig_idx = src
            .find("pub async fn get_sync_folders_with_stats(")
            .expect("get_sync_folders_with_stats declaration present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        assert!(
            body.contains("get_device_name_internal("),
            "get_sync_folders_with_stats must read this machine's device name to classify remote rows",
        );
        assert!(
            body.contains("remote_folder_display("),
            "get_sync_folders_with_stats must build remote rows via remote_folder_display",
        );
    }

    /// FE wire pin: `SyncFolderInfo`'s camelCase keys, including `ownerSs58`
    /// (the listing's only member/own discriminant — the owner badge and the
    /// member-row menu gating in Task 6 key off it). A dropped or renamed key
    /// ships as a silently-undefined FE field, so the key set is asserted
    /// exactly; an own drive keeps `ownerSs58` present-but-null (a stable
    /// shape, not a conditional key).
    #[test]
    fn sync_folder_info_wire_keys_are_pinned() {
        let info = SyncFolderInfo {
            id: "team-docs".to_string(),
            folder_name: "team-docs".to_string(),
            local_path: "/Users/me/team-docs".to_string(),
            status: "syncing".to_string(),
            file_count: None,
            total_bytes: None,
            last_modified: None,
            owner_ss58: None,
        };
        let json = serde_json::to_value(&info).expect("serialize");
        let keys: std::collections::BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "id",
                "folderName",
                "localPath",
                "status",
                "fileCount",
                "totalBytes",
                "lastModified",
                "ownerSs58"
            ]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
            "SyncFolderInfo wire keys must stay exactly these camelCase names"
        );
        assert_eq!(json["ownerSs58"], serde_json::Value::Null, "an own drive serializes ownerSs58 as null");
    }

    // ── sanitize_label ──────────────────────────────────────────────

    #[test]
    fn sanitize_label_passes_through_clean_input() {
        assert_eq!(sanitize_label("my-folder").unwrap(), "my-folder");
    }

    #[test]
    fn sanitize_label_strips_disallowed_chars() {
        assert_eq!(sanitize_label("hello/world\\bad").unwrap(), "helloworldbad");
    }

    #[test]
    fn sanitize_label_trims_leading_trailing_dots() {
        assert_eq!(sanitize_label("..hidden..").unwrap(), "hidden");
    }

    #[test]
    fn sanitize_label_rejects_empty_after_sanitization() {
        let result = sanitize_label("///");
        // Pin the taxonomy: a rejected label is `Validation`, not the old `Other`.
        assert!(
            matches!(result, Err(crate::error::AppError::Validation(_))),
            "an empty-after-sanitize label must surface as Validation, got {result:?}"
        );
    }

    #[test]
    fn sanitize_label_preserves_spaces_and_underscores() {
        assert_eq!(sanitize_label("My Folder_v2").unwrap(), "My Folder_v2");
    }

    #[test]
    fn sanitize_label_preserves_dots_in_middle() {
        assert_eq!(sanitize_label("file.backup.2024").unwrap(), "file.backup.2024");
    }

    // ── restore dest (H-115) ────────────────────────────────────────

    #[test]
    fn restore_dest_nests_under_a_parent_that_is_not_the_folder() {
        assert_eq!(
            restore_dest_path(Path::new("/workspace"), "hippius-qa-beta4-be"),
            PathBuf::from("/workspace/hippius-qa-beta4-be"),
        );
    }

    #[test]
    fn restore_dest_does_not_nest_when_the_pick_is_the_folder_itself() {
        // The reported bug: Choose Destination selected the existing
        // folder row, then join(label) produced
        // `/workspace/hippius-qa-beta4-be/hippius-qa-beta4-be`.
        let picked = Path::new("/workspace/hippius-qa-beta4-be");
        assert_eq!(
            restore_dest_path(picked, "hippius-qa-beta4-be"),
            PathBuf::from("/workspace/hippius-qa-beta4-be"),
        );
    }

    #[test]
    fn restore_dest_still_nests_when_the_parent_just_shares_a_prefix() {
        // `/workspace/hippius-qa-beta4` is not the folder
        // `hippius-qa-beta4-be`; joining is still correct.
        assert_eq!(
            restore_dest_path(Path::new("/workspace/hippius-qa-beta4"), "hippius-qa-beta4-be"),
            PathBuf::from("/workspace/hippius-qa-beta4/hippius-qa-beta4-be"),
        );
    }

    #[test]
    fn restore_dest_treats_a_trailing_separator_as_the_same_folder() {
        // GTK/Qt pickers sometimes hand back `foo/`. `file_name()` still
        // yields `foo`, so the identity rule must fire.
        assert_eq!(
            restore_dest_path(Path::new("/workspace/hippius-qa-beta4-be/"), "hippius-qa-beta4-be"),
            PathBuf::from("/workspace/hippius-qa-beta4-be/"),
        );
    }

    #[test]
    fn restore_single_folder_routes_through_restore_dest_path() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/folders.rs")).expect("read folders.rs");
        let start = src.find("async fn restore_single_folder(").expect("restore_single_folder present");
        let rest = &src[start..];
        let end = rest
            .find("pub async fn restore_remote_folders(")
            .expect("restore_remote_folders follows restore_single_folder");
        let body = &rest[..end];
        assert!(
            body.contains("restore_dest_path("),
            "restore_single_folder must use restore_dest_path so picking the folder itself does not nest label/label"
        );
    }

    // ── delete_remote_folder ordering invariant ─────────────────────
    //
    // If this test fails, a future refactor has reintroduced the race
    // that caused users' locally-synced files to be wiped when they
    // deleted the remote copy from Settings: the server-side
    // `unregister_folder` lands, the sync loop fires for the still-alive
    // local drive, sees "remote has zero files", and mirrors that empty
    // state back onto disk. The fix is to stop the local drive FIRST so
    // no sync cycle can ever observe the emptied remote.
    #[test]
    fn delete_remote_folder_stops_local_drive_before_remote_unregister() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/folders.rs")).expect("read folders.rs");

        let sig_idx = src
            .find("pub async fn delete_remote_folder(")
            .expect("delete_remote_folder declaration present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];

        let remove_idx = body.find("remove_drive_for_account(").expect(
            "delete_remote_folder must call remove_drive_for_account — it's the only thing that cancels an in-flight sync and takes the drive off the map before the server wipe, threading the explicit account so the baseline wipe stays account-correct",
        );
        let unregister_idx = body
            .find(".unregister_folder(")
            .expect("delete_remote_folder must call unregister_folder on the hcfs client");

        assert!(
            remove_idx < unregister_idx,
            "remove_drive_for_account MUST be called before .unregister_folder so the local drive is dead before the server reports zero files",
        );
    }

    // Static guard: `delete_remote_folder` must decide whether local teardown is
    // owed from the `sync_paths` DB row, NEVER from the in-memory `sync.drives`
    // map. The map holds only drives whose sync loop is registered, so a paused
    // drive (and one still mid-init on a slow login) is missing from it — reading
    // it there skipped `remove_drive_for_account`, leaving the row behind after
    // the server wipe (the folder stayed listed with blank stats) plus an on-disk
    // baseline still claiming the deleted files were synced. The command takes
    // `tauri::State`, so the choice of source cannot be driven hermetically; the
    // behaviour of the DB side is covered by `sync::paths`' own tests.
    #[test]
    fn delete_remote_folder_decides_teardown_from_the_db_not_the_drive_map() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/folders.rs")).expect("read folders.rs");
        let sig_idx = src.find("pub async fn delete_remote_folder(").expect("declaration present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        // Strip `//` comments: the body deliberately NAMES the map it must not
        // read, in the comment explaining why. Only executable code counts.
        let code: String = body
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            code.contains("sync_path_exists("),
            "delete_remote_folder must read local configuration from sync_paths via sync_path_exists",
        );
        assert!(
            !code.contains("sync.drives"),
            "delete_remote_folder must NOT consult the in-memory drives map — a paused or still-initializing drive is absent from it, so its sync_paths row and on-disk baseline would survive the server wipe",
        );
    }

    // ── remote_folder_absent (F-2 idempotent delete) ────────────────

    #[test]
    fn absent_when_hash_not_in_list() {
        // The deleted folder's hash is gone from the remote list → the delete
        // landed despite the client-side error; report success.
        assert!(remote_folder_absent("abc", Some(&["def".to_string(), "ghi".to_string()])));
    }

    #[test]
    fn present_when_hash_still_in_list() {
        // The folder is still on the server → the error was a genuine failure.
        assert!(!remote_folder_absent("abc", Some(&["abc".to_string(), "def".to_string()])));
    }

    #[test]
    fn absent_when_remote_list_empty() {
        assert!(remote_folder_absent("abc", Some(&[])));
    }

    #[test]
    fn not_confirmed_when_recheck_failed() {
        // None = the re-list itself failed; we cannot confirm the delete, so the
        // original error must stand (NOT a false success).
        assert!(!remote_folder_absent("abc", None));
    }

    proptest::proptest! {
        // The decision is exactly "absent iff we have a list AND the hash is not
        // in it" — a `None` re-check can never report success.
        #[test]
        fn absent_iff_listed_and_not_contained(fhash in "[a-f0-9]{0,8}", others in proptest::collection::vec("[a-f0-9]{0,8}", 0..6)) {
            let contains = others.iter().any(|h| h == &fhash);
            proptest::prop_assert_eq!(remote_folder_absent(&fhash, Some(&others)), !contains);
            proptest::prop_assert!(!remote_folder_absent(&fhash, None));
        }
    }

    // Static guard: delete_remote_folder must RE-LIST remote folders after the
    // unregister call so a future refactor can't silently drop the idempotency
    // re-check and reintroduce the false "delete failed" report (F-2).
    #[test]
    fn delete_remote_folder_rechecks_remote_state_after_unregister() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/folders.rs")).expect("read folders.rs");
        let sig_idx = src.find("pub async fn delete_remote_folder(").expect("declaration present");
        // Scope the search to the function BODY (brace-matched), so a helper
        // inserted between the signature and the body can't fool the ordering
        // check — mirrors the sibling guard above.
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        let unregister_idx = body.find(".unregister_folder(").expect("calls unregister_folder");
        let recheck_idx = body.find("remote_folder_absent(").expect(
            "delete_remote_folder must call remote_folder_absent after an unregister error so a durable-but-timed-out delete is reported as success, not a false failure",
        );
        assert!(unregister_idx < recheck_idx, "the idempotency re-check must follow the unregister call");
    }

    // ── member-owner join failure fails the listing ─────────────────
    //
    // `get_sync_folders_with_stats` takes `tauri::State`, so the DB failure
    // cannot be driven hermetically from a test (no way to construct the
    // command's state without a Tauri app). The propagation itself is
    // enforced at the type level by `?`; this pin exists to keep a refactor
    // from quietly reinstating the old `unwrap_or_else(|_| HashMap::default())`
    // degrade, which rendered member rows as OWN rows on a transient DB
    // error — re-arming "Delete from Server"/plain Remove, the exact
    // controls the FE's data-keyed member gating withholds.
    #[test]
    fn member_owner_join_failure_propagates_instead_of_degrading() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/folders.rs")).expect("read folders.rs");
        let sig_idx = src
            .find("pub async fn get_sync_folders_with_stats(")
            .expect("get_sync_folders_with_stats declaration present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];

        let call_idx = body
            .find("member_owner_by_label(")
            .expect("get_sync_folders_with_stats must join member owners via member_owner_by_label");
        let stmt_end = body[call_idx..].find(';').expect("the join call is a statement") + call_idx;
        let stmt = &body[call_idx..stmt_end];

        assert!(
            stmt.trim_end().ends_with(".await?"),
            "the member-owner join must propagate its error with `?` — a failed listing is strictly safer than one that shows member rows as own rows; got statement: {stmt}"
        );
        assert!(
            !stmt.contains("unwrap_or") && !stmt.contains("ok()"),
            "the member-owner join must not degrade a DB error to an empty map: {stmt}"
        );
    }
}
