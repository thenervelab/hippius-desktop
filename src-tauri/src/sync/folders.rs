//! Remote folder management: listing, restoring, and deleting remote folders.
//!
//! Contains commands and helpers for interacting with the remote folder
//! registry on the HCFS server, plus the combined local+remote folder
//! listing used by the sync manager UI.

use serde::Serialize;
use tracing::{error, info, warn};

use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::error::Result;
use crate::sync::config::{ACCEPT_INVALID_CERTS, get_hcfs_config_internal};
use crate::sync::lifecycle::start_sync_loop;
use crate::sync::lifecycle::{initialize_sync_inner, remove_drive};
use crate::sync::mnemonic::{config_dir_for_folder, folder_hash};
use hcfs_client::client::HcfsClientConfig;
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;

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
        return Err(crate::error::AppError::Other(format!("Invalid folder label: '{label}'")));
    }
    Ok(trimmed.to_string())
}

/// Query all sync paths for an account directly from the DB (no Tauri state params).
pub(crate) async fn get_all_sync_paths_internal(pool: &SqlitePool, account_id: &str) -> Result<Vec<crate::sync::paths::SyncPathResult>> {
    use sqlx::Row;
    let owner = account_key(account_id);
    let rows = sqlx::query("SELECT path, type, label, is_paused FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("DB error: {e}")))?;

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

/// Internal helper to list remote folders without Tauri State params.
pub(crate) async fn list_remote_folders_internal(pool: &SqlitePool, account_id: &str) -> Result<Vec<RemoteFolderInfoResult>> {
    let config = get_hcfs_config_internal(pool, account_id).await?;
    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };

    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found".into()))?;

    let client_config = HcfsClientConfig {
        base_url: server_url,
        bearer_token,
        accept_invalid_certs: ACCEPT_INVALID_CERTS,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: String::new(),
    };

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
    info!("Listing remote folders for account '{}'", account_id);
    let pool = state.pool()?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };

    let bearer_token = get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;

    let client_config = HcfsClientConfig {
        base_url: server_url,
        bearer_token,
        accept_invalid_certs: ACCEPT_INVALID_CERTS,
        billing_bypass_token: None,
        ss58_address: account_id.clone(),
        folder_hash: String::new(),
    };

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
    let folder_path = PathBuf::from(base_path).join(&safe_label);

    std::fs::create_dir_all(&folder_path)?;

    let path_str = folder_path.to_string_lossy().to_string();

    crate::sync::paths::set_sync_path_internal(pool, account_id, &path_str, false, Some(label)).await?;

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
/// `remove_drive` first we cancel any in-flight sync, drop the drive from the
/// in-memory map (so no new sync cycle can pick it up), and delete the
/// `sync_paths` row so cold restarts don't resurrect it. Files on disk are
/// left untouched.
///
/// If `remove_drive` fails we bail before touching the server — that way the
/// user's local state is exactly as they found it and they can retry. If the
/// server call fails after a successful local teardown, the user's files are
/// still safe on disk; they can re-add the folder pointing at the same path
/// to resume syncing, and retry the remote deletion when the server is
/// reachable.
#[tauri::command]
pub async fn delete_remote_folder(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
) -> Result<DeleteRemoteFolderResult> {
    info!("Deleting remote folder '{}' for account '{}'", label, account_id);
    let pool = state.pool()?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };

    let bearer_token = get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;

    let fhash = folder_hash(&label);

    // Snapshot "was this folder locally synced" before we tear anything down,
    // so the result we hand back to the FE matches the pre-deletion state the
    // user was looking at.
    let was_local = {
        let guard = state.sync.drives.lock().await;
        guard.contains_key(&label)
    };

    if was_local {
        remove_drive(app, label.clone()).await?;
    }

    let client_config = HcfsClientConfig {
        base_url: server_url,
        bearer_token,
        accept_invalid_certs: ACCEPT_INVALID_CERTS,
        billing_bypass_token: None,
        ss58_address: account_id.clone(),
        folder_hash: fhash.clone(),
    };

    let client = hcfs_client::client::HcfsClient::new(client_config).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    let result = client
        .unregister_folder(&account_id, &fhash)
        .await
        .map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    info!(
        "Remote folder '{}' deleted: {} files removed, was_local={}",
        label, result.files_deleted, was_local
    );

    Ok(DeleteRemoteFolderResult {
        files_deleted: result.files_deleted,
        was_local,
    })
}

/// Return all sync folders with their stats pre-joined from local DB + remote server.
///
/// Replaces the `loadFolders()` orchestration in `MultiFolderSyncManager.tsx`
/// that was doing parallel fetches, map creation, status checks, and sorting
/// in TypeScript.
#[tauri::command]
pub async fn get_sync_folders_with_stats(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<SyncFoldersResult> {
    let pool = state.pool()?;

    // Parallel fetch: local paths + remote folders
    let (sync_paths, remote_folders) = tokio::join!(get_all_sync_paths_internal(pool, &account_id), async {
        list_remote_folders_internal(pool, &account_id).await.unwrap_or_default()
    });
    let sync_paths = sync_paths.unwrap_or_default();

    // Build remote lookup by label
    let remote_by_label: HashMap<String, &RemoteFolderInfoResult> = remote_folders.iter().map(|f| (f.label.clone(), f)).collect();

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

        let remote = remote_by_label.get(&sp.label);

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
        });
    }

    // Remote folders not in local list
    let local_labels: std::collections::HashSet<&str> = sync_paths.iter().map(|sp| sp.label.as_str()).collect();
    let mut remote_display: Vec<RemoteFolderDisplay> = remote_folders
        .iter()
        .filter(|f| !local_labels.contains(f.label.as_str()))
        .map(|f| {
            let ts = if f.updated_at != 0 { f.updated_at } else { f.created_at };
            RemoteFolderDisplay {
                folder_name: f.label.clone(),
                device_name: if f.device_name.is_empty() {
                    "Unknown Device".to_string()
                } else {
                    f.device_name.clone()
                },
                file_count: f.file_count,
                total_bytes: f.total_bytes,
                last_modified: ts * 1000,
            }
        })
        .collect();
    remote_display.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    Ok(SyncFoldersResult {
        local,
        remote: remote_display,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_label_preserves_spaces_and_underscores() {
        assert_eq!(sanitize_label("My Folder_v2").unwrap(), "My Folder_v2");
    }

    #[test]
    fn sanitize_label_preserves_dots_in_middle() {
        assert_eq!(sanitize_label("file.backup.2024").unwrap(), "file.backup.2024");
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
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/folders.rs")).expect("read folders.rs");

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

        let remove_idx = body.find("remove_drive(").expect(
            "delete_remote_folder must call remove_drive — it's the only thing that cancels an in-flight sync and takes the drive off the map before the server wipe",
        );
        let unregister_idx = body
            .find(".unregister_folder(")
            .expect("delete_remote_folder must call unregister_folder on the hcfs client");

        assert!(
            remove_idx < unregister_idx,
            "remove_drive MUST be called before .unregister_folder so the local drive is dead before the server reports zero files",
        );
    }
}
