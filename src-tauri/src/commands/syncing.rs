//! HCFS sync control commands and configuration.
//!
//! This module contains the Tauri commands for managing the sync lifecycle:
//! - `initialize_sync` — reads config from DB, creates Drive, starts sync loop
//! - `stop_sync` — cancels the sync loop, drops all drives
//! - `stop_drive` — stops a single drive by label
//! - `trigger_sync_now` — runs one immediate sync cycle
//! - `save_hcfs_config` / `get_hcfs_config` / `update_hcfs_server_url` — config CRUD
//!
//! It also contains `setup_progress_handlers()` which registers callbacks on the
//! Drive that emit Tauri events for upload/download/encrypt/decrypt progress.

use notify::Watcher;
use tracing::{debug, error, info, warn};

use crate::hcfs_drive::{HcfsDriveManager, StagedChanges, start_sync_loop};
use crate::sync_engine::{DriveSlot, ReviewModeGuard};
use crate::sync_events;
use crate::sync_shared::SyncActivityItem;
use crate::utils::account_key::account_key;
use crate::utils::auth_tokens::get_api_token;
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::sync::SyncProgress;
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::error::Error as _;
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
pub struct HcfsConfigResult {
    pub server_url: String,
    pub has_password: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct InitSyncResult {
    pub user_id: String,
    pub mnemonic: Option<String>,
    pub is_new_setup: bool,
}

#[tauri::command]
pub async fn save_hcfs_config(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    server_url: String,
    drive_password: String,
) -> Result<(), String> {
    let db = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r#"
        INSERT INTO hcfs_config (owner, server_url, drive_password, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(&owner)
    .bind(&server_url)
    .bind(&drive_password)
    .execute(db)
    .await
    .map_err(|e| format!("Failed to save HCFS config: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn update_hcfs_server_url(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    server_url: String,
) -> Result<(), String> {
    let db = state.pool()?;
    let owner = account_key(&account_id);

    let result = sqlx::query(
        r#"
        UPDATE hcfs_config SET server_url = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ?
        "#,
    )
    .bind(&server_url)
    .bind(&owner)
    .execute(db)
    .await
    .map_err(|e| format!("Failed to update HCFS server URL: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("HCFS config not found. Please set up sync first.".to_string());
    }

    Ok(())
}

/// Internal implementation for updating bearer token.
///
/// Takes `&crate::app_state::AppState` to access both the DB pool and the
/// live drive registry without relying on global state.
pub(crate) async fn update_sync_bearer_token_internal(
    app_state: &crate::app_state::AppState,
    account_id: &str,
    bearer_token: &str,
) -> Result<(), String> {
    let pool = app_state.pool()?;

    // 1. Persist to DB so future initialize_sync calls use the fresh token
    crate::utils::auth_tokens::save_api_token(pool, account_id, bearer_token)
        .await
        .map_err(|e| format!("Failed to persist auth token: {e}"))?;

    // 2. Update all live drives in-memory
    let drive_arcs: Vec<(String, std::sync::Arc<TokioMutex<HcfsDriveManager>>)> = {
        let guard = app_state.sync.drives.lock().await;
        guard
            .iter()
            .map(|(k, slot)| (k.clone(), slot.manager.clone()))
            .collect()
    };
    for (label, drive_arc) in drive_arcs {
        let mut manager = drive_arc.lock().await;
        if let Err(e) = manager.update_bearer_token(bearer_token.to_string()) {
            error!("Failed to update bearer token for drive '{}': {}", label, e);
        } else {
            debug!("Updated bearer token for drive '{}'", label);
        }
    }

    Ok(())
}

/// Update the bearer token on all live drives and persist it in the DB.
///
/// Called by the frontend after re-authenticating when the server returns
/// 401 Unauthorized (expired token).
#[tauri::command]
pub async fn update_sync_bearer_token(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    bearer_token: String,
) -> Result<(), String> {
    update_sync_bearer_token_internal(&state, &account_id, &bearer_token).await
}

/// Internal helper that accepts a pool reference directly.
/// Used by both the Tauri command and other internal callers.
pub(crate) async fn get_hcfs_config_internal(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<HcfsConfigResult, String> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String, String)> = sqlx::query_as(
        r#"
        SELECT server_url, drive_password FROM hcfs_config WHERE owner = ?
        "#,
    )
    .bind(&owner)
    .fetch_optional(db)
    .await
    .map_err(|e| format!("Failed to get HCFS config: {}", e))?;

    match result {
        Some((server_url, password)) => Ok(HcfsConfigResult {
            server_url,
            has_password: !password.is_empty(),
        }),
        None => Ok(HcfsConfigResult {
            server_url: String::new(),
            has_password: false,
        }),
    }
}

#[tauri::command]
pub async fn get_hcfs_config(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<HcfsConfigResult, String> {
    get_hcfs_config_internal(state.pool()?, &account_id).await
}

pub(crate) async fn get_drive_password(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<String, String> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT drive_password FROM hcfs_config WHERE owner = ?
        "#,
    )
    .bind(&owner)
    .fetch_optional(db)
    .await
    .map_err(|e| format!("Failed to get drive password: {}", e))?;

    result
        .map(|(password,)| password)
        .ok_or_else(|| "HCFS config not found".to_string())
}

/// Read the sync path for a specific label from the database.
async fn get_sync_path_for_label(
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
) -> Result<String, String> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String,)> =
        sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
            .bind(&owner)
            .bind(label)
            .fetch_optional(db)
            .await
            .map_err(|e| format!("Failed to get sync path: {}", e))?;

    result
        .map(|(path,)| path)
        .ok_or_else(|| format!("Sync path not configured for label '{}'", label))
}

/// Compute the account-level directory: `~/.hippius/drives/<account_key>/`
fn account_dir(account_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let key = account_key(account_id);
    Ok(home.join(".hippius").join("drives").join(key))
}

/// Deterministic 16-char hex hash of a folder label, used as subdirectory name
/// and server namespace suffix.
fn folder_hash(label: &str) -> String {
    let digest = Sha256::digest(label.as_bytes());
    hex::encode(&digest)[..16].to_string()
}

/// Compute the per-folder config directory:
/// `~/.hippius/drives/<account_key>/<folder_hash>/`
fn config_dir_for_folder(account_id: &str, label: &str) -> Result<PathBuf, String> {
    Ok(account_dir(account_id)?.join(folder_hash(label)))
}

/// Path to the master encrypted mnemonic at the account level:
/// `~/.hippius/drives/<account_key>/master_enc_mnemonic.json`
fn master_mnemonic_path(account_id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(account_id)?.join("master_enc_mnemonic.json"))
}

/// Derive a folder-specific mnemonic from the master mnemonic + folder label.
///
/// `folder_entropy = SHA256(master_seed[..32] || label_bytes)`
/// `folder_mnemonic = Mnemonic::from_entropy(folder_entropy)` → 24 words
///
/// Same master + same label always produces the same derived mnemonic,
/// giving a deterministic but unique `user_id` per folder on the server,
/// regardless of the local filesystem path.
fn derive_folder_mnemonic(master_mnemonic: &str, label: &str) -> Result<String, String> {
    use bip39::Mnemonic;
    use std::str::FromStr;
    use zeroize::Zeroize;

    let master =
        Mnemonic::from_str(master_mnemonic).map_err(|e| format!("Invalid master mnemonic: {e}"))?;
    let mut seed = master.to_seed("");

    let mut hasher = Sha256::new();
    hasher.update(&seed[..32]);
    hasher.update(label.as_bytes());
    seed.zeroize();
    let mut folder_entropy: [u8; 32] = hasher.finalize().into();

    let folder_mnemonic = Mnemonic::from_entropy(&folder_entropy).map_err(|e| {
        folder_entropy.zeroize();
        format!("Failed to derive folder mnemonic: {e}")
    })?;
    folder_entropy.zeroize();
    Ok(folder_mnemonic.to_string())
}

/// Ensure the folder uses the correct derived mnemonic for the current master.
///
/// Detects two legacy states:
///   1. Folder mnemonic == master verbatim (copied during migration without derivation)
///   2. Folder mnemonic != derive(master, label) (derived from a different/old master)
///
/// In either case it re-derives from the current master, writes a `.needs_rekey`
/// marker (so `initialize_sync_inner` purges stale remote files), and wipes local
/// sync state to force re-upload with the correct key.
fn ensure_derived_mnemonic(
    folder_dir: &Path,
    master_path: &Path,
    password: &str,
    label: &str,
) -> Result<(), String> {
    use zeroize::Zeroize;

    let folder_enc = folder_dir.join("enc_mnemonic.json");
    if !folder_enc.exists() || !master_path.exists() {
        return Ok(());
    }

    let master = hcfs_client::auth::recover_mnemonic(master_path, password)
        .map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
    let mut master_str = master.to_string();

    let folder = hcfs_client::auth::recover_mnemonic(&folder_enc, password)
        .map_err(|e| format!("Failed to recover folder mnemonic: {e}"))?;
    let mut folder_str = folder.to_string();

    let mut expected = derive_folder_mnemonic(&master_str, label)?;

    if folder_str == expected {
        // Already correct — nothing to do.
        master_str.zeroize();
        folder_str.zeroize();
        expected.zeroize();
        return Ok(());
    }

    // Folder mnemonic is wrong — either raw master or derived from an old master.
    if folder_str == master_str {
        info!("Folder '{}' uses raw master mnemonic — re-deriving", label);
    } else {
        info!(
            "Folder '{}' uses wrong derived mnemonic (old master?) — re-deriving",
            label
        );
    }
    folder_str.zeroize();
    master_str.zeroize();

    // Create the rekey marker BEFORE saving the new mnemonic. If the
    // process crashes after the mnemonic is saved but before the marker
    // is written, the next startup would see folder == expected and
    // skip — leaving stale remote files encrypted with the old key.
    let marker = folder_dir.join(".needs_rekey");
    std::fs::File::create(&marker).map_err(|e| format!("Failed to create rekey marker: {e}"))?;

    hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, &expected, password)
        .map_err(|e| format!("Failed to save derived mnemonic: {e}"))?;
    expected.zeroize();

    // Wipe sync state so files get re-uploaded with the new key
    let state_path = folder_dir.join("sync_state.json");
    let state_bak = folder_dir.join("sync_state.json.bak");
    let _ = std::fs::remove_file(&state_path);
    let _ = std::fs::remove_file(&state_bak);

    info!(
        "Re-derived mnemonic for '{}', wiped sync state (remote files preserved)",
        label
    );

    Ok(())
}

/// Run migration from legacy config layouts into the per-folder layout.
///
/// Handles three legacy configurations:
///
/// **Legacy A** — `<sync_folder>/.hippius/` (original pre-config-dir layout):
///   Copy all files into `folder_dir/`, save the mnemonic as master too.
///
/// **Legacy B** — `account_dir/enc_mnemonic.json` (per-account layout from recent changes):
///   Copy `enc_mnemonic.json` → `master_enc_mnemonic.json`, then move files into `folder_dir/`.
///
/// Both preserve the existing mnemonic as-is (no re-derivation) to maintain access
/// to existing server files for the migrated folder.
fn run_migration(
    sync_path: &str,
    account_dir: &Path,
    folder_dir: &Path,
    master_path: &Path,
) -> Result<(), String> {
    // If folder_dir already has an enc_mnemonic.json, migration is complete
    if folder_dir.join("enc_mnemonic.json").exists() {
        return Ok(());
    }

    let legacy_a_dir = PathBuf::from(sync_path).join(".hippius");
    let legacy_b_enc = account_dir.join("enc_mnemonic.json");

    // --- Legacy A: <sync_folder>/.hippius/ ---
    if legacy_a_dir.exists() && legacy_a_dir.join("enc_mnemonic.json").exists() {
        info!("Legacy A detected: {:?} → {:?}", legacy_a_dir, folder_dir);

        std::fs::create_dir_all(folder_dir)
            .map_err(|e| format!("Failed to create folder config dir: {e}"))?;

        // Copy all files into folder_dir
        copy_dir_contents(&legacy_a_dir, folder_dir)?;

        // Verify critical file
        if !folder_dir.join("enc_mnemonic.json").exists() {
            return Err(
                "Migration A verification failed: enc_mnemonic.json not in folder dir".to_string(),
            );
        }

        // This mnemonic is the master — save it at account level if not already there
        if !master_path.exists() {
            std::fs::create_dir_all(account_dir)
                .map_err(|e| format!("Failed to create account dir: {e}"))?;
            std::fs::copy(folder_dir.join("enc_mnemonic.json"), master_path)
                .map_err(|e| format!("Failed to copy master mnemonic: {e}"))?;
            info!("Saved master mnemonic from Legacy A");
        }

        // Remove legacy dir (non-fatal on failure)
        if let Err(e) = std::fs::remove_dir_all(&legacy_a_dir) {
            warn!("Could not remove legacy A dir: {e}");
        } else {
            info!("Removed legacy A directory");
        }

        return Ok(());
    }

    // --- Legacy B: account_dir/enc_mnemonic.json (per-account, not per-folder) ---
    if legacy_b_enc.exists() {
        info!("Legacy B detected: {:?} → {:?}", legacy_b_enc, folder_dir);

        // Save as master if not already present
        if !master_path.exists() {
            std::fs::copy(&legacy_b_enc, master_path)
                .map_err(|e| format!("Failed to copy to master mnemonic: {e}"))?;
            info!("Saved master mnemonic from Legacy B");
        }

        std::fs::create_dir_all(folder_dir)
            .map_err(|e| format!("Failed to create folder config dir: {e}"))?;

        // Move enc_mnemonic.json, sync_state.json*, temp/ into folder_dir
        for name in &[
            "enc_mnemonic.json",
            "sync_state.json",
            "sync_state.json.bak",
        ] {
            let src = account_dir.join(name);
            if src.exists() {
                let dst = folder_dir.join(name);
                std::fs::copy(&src, &dst).map_err(|e| format!("Failed to copy {name}: {e}"))?;
                debug!("Copied {} to folder dir", name);
            }
        }

        let temp_src = account_dir.join("temp");
        if temp_src.is_dir() {
            let temp_dst = folder_dir.join("temp");
            copy_dir_recursive(&temp_src, &temp_dst)
                .map_err(|e| format!("Failed to copy temp dir: {e}"))?;
            debug!("Copied temp/ to folder dir");
        }

        // Verify critical file
        if !folder_dir.join("enc_mnemonic.json").exists() {
            return Err(
                "Migration B verification failed: enc_mnemonic.json not in folder dir".to_string(),
            );
        }

        // Clean up originals from account_dir (not master_enc_mnemonic.json)
        for name in &[
            "enc_mnemonic.json",
            "sync_state.json",
            "sync_state.json.bak",
        ] {
            let src = account_dir.join(name);
            if src.exists() {
                let _ = std::fs::remove_file(&src);
            }
        }
        let temp_src = account_dir.join("temp");
        if temp_src.is_dir() {
            let _ = std::fs::remove_dir_all(&temp_src);
        }

        info!("Legacy B migration complete");
        return Ok(());
    }

    // No legacy layout found — fresh setup
    Ok(())
}

/// Copy all entries from `src` into `dst`, recursing into subdirectories.
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("Failed to read dir {:?}: {e}", src))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };

        if path.is_file() {
            std::fs::copy(&path, dst.join(&name))
                .map_err(|e| format!("Failed to copy {name}: {e}"))?;
        } else if path.is_dir() {
            copy_dir_recursive(&path, &dst.join(&name))
                .map_err(|e| format!("Failed to copy directory {name}: {e}"))?;
        }
    }
    Ok(())
}

/// Recursively copy a directory and its contents.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Initialize sync for a specific drive label by reading config from database,
/// creating the HCFS Drive, and starting/updating the background sync loop.
///
/// Each sync folder gets its own derived mnemonic from the master, producing
/// a unique `user_id` on the server. This keeps folder namespaces isolated:
/// switching folders won't download files from the previous folder.
#[tauri::command]
pub async fn initialize_sync(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    existing_mnemonic: Option<String>,
) -> Result<InitSyncResult, String> {
    initialize_sync_inner(app, account_id, label, existing_mnemonic, true).await
}

/// Core init logic. When `start_loop` is false the caller is responsible for
/// starting the sync loop after all drives have been registered (batch restore).
async fn initialize_sync_inner(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    existing_mnemonic: Option<String>,
    start_loop: bool,
) -> Result<InitSyncResult, String> {
    use tauri::Manager;
    // Sanitize label early — before it's used for filesystem paths or DB lookups.
    let label = sanitize_label(&label)?;

    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;
    let pool_owned = app_state.pool()?.clone();
    let pool = &pool_owned;

    info!(
        "initialize_sync called for account: {}, label: '{}'",
        account_id, label
    );

    // 0. Stop only the drive with the matching label if it exists
    {
        let mut drives_guard = sync.drives.lock().await;
        if let Some(old_slot) = drives_guard.remove(&label) {
            // Cancel any in-progress sync for this drive
            old_slot.cancel_token.cancel();
            debug!("Dropped previous drive instance for label '{}'", label);
        }
        sync.discard_pending_activity_for_label(&label);
        sync.remove_state(&label);
    }
    sync.reset_sync_counter();
    sync.review_mode.store(false, Ordering::Release);
    sync.clear_review_entered();

    // 1. Read sync path for the given label from database
    let sync_path = get_sync_path_for_label(pool, &account_id, &label).await?;
    debug!("Sync path: {}, label: {}", sync_path, label);

    // Expand asset protocol scope so the frontend can preview files from this folder
    crate::commands::file_commands::allow_asset_directory(&app, &sync_path);

    // 2. Read HCFS config from database
    let drive_password = get_drive_password(pool, &account_id).await?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;

    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };
    debug!("Server URL: {}", server_url);

    // 3. Check if the sync directory was deleted by the user.
    //    If the config dir has sync state (was previously syncing) but the sync
    //    folder is completely gone, the user intentionally removed it. Do NOT
    //    recreate it — that would create an empty folder + stale synced tree,
    //    causing the three-tree algorithm to delete all remote files.
    let sync_dir_existed = Path::new(&sync_path).exists();
    {
        let folder_dir_check = config_dir_for_folder(&account_id, &label)?;
        let had_sync_state = folder_dir_check.join("sync_state.json").exists();
        if !sync_dir_existed && had_sync_state {
            warn!(
                "Sync folder '{}' was deleted but config still exists for '{}'. \
                 Removing stale sync path from DB to prevent remote file deletion.",
                sync_path, label
            );
            // Remove the sync path so it doesn't auto-init on next startup
            if let Err(e) =
                crate::commands::substrate_tx::remove_sync_path_internal(pool, &account_id, &label)
                    .await
            {
                warn!("Failed to remove stale sync path for '{}': {}", label, e);
            }
            // Also wipe the stale sync state
            let _ = std::fs::remove_file(folder_dir_check.join("sync_state.json"));
            let _ = std::fs::remove_file(folder_dir_check.join("sync_state.json.bak"));
            return Err(format!(
                "Sync folder '{}' for '{}' was removed. It has been unregistered from sync. \
                 Re-add it from Settings if this was unintentional.",
                sync_path, label
            ));
        }
    }

    std::fs::create_dir_all(&sync_path)
        .map_err(|e| format!("Failed to create sync directory: {}", e))?;

    // 4. Compute per-folder config directory and run migration
    let acct_dir = account_dir(&account_id)?;
    let folder_dir = config_dir_for_folder(&account_id, &label)?;
    let master_path = master_mnemonic_path(&account_id)?;
    run_migration(&sync_path, &acct_dir, &folder_dir, &master_path)?;

    // 4b. If the login mnemonic is available, ensure the stored master matches.
    //     A mismatch means the master was generated randomly (e.g. after an
    //     app restart where the mnemonic was lost). Updating the master BEFORE
    //     ensure_derived_mnemonic lets the derivation check detect the folder
    //     key mismatch and trigger a rekey.
    if let Some(ref imported) = existing_mnemonic {
        if master_path.exists() {
            use zeroize::Zeroize;
            let stored = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
                .map_err(|e| format!("Failed to recover master: {e}"))?;
            let mut stored_str = stored.to_string();
            if stored_str != *imported {
                info!(
                    "Stored master differs from login mnemonic — \
                     updating master before derivation check"
                );
                hcfs_client::auth::save_encrypted_mnemonic(&master_path, imported, &drive_password)
                    .map_err(|e| format!("Failed to update master: {e}"))?;
            }
            stored_str.zeroize();
        }
    }

    // 4c. Detect legacy mnemonic: if the folder's mnemonic matches the master,
    //     it was migrated without derivation. Re-derive so all devices share
    //     the same folder-specific key.
    ensure_derived_mnemonic(&folder_dir, &master_path, &drive_password, &label)?;

    // 5. Create HcfsDriveManager with per-folder config directory
    let mut manager = HcfsDriveManager::new(PathBuf::from(&sync_path), folder_dir.clone());

    // 6. Retrieve the auth token BEFORE unlock so we can set ss58_address first
    let bearer_token = get_api_token(pool, &account_id)
        .await
        .map_err(|e| format!("Failed to get auth token: {e}"))?
        .ok_or_else(|| "No authentication token found. Please log in again.".to_string())?;

    debug!("Retrieved auth token for account_id (SS58): {}", account_id);
    debug!("This account_id will be used as user_id for sync requests.");

    // Set HCFS client config BEFORE unlock so ss58_address is available
    let fhash = folder_hash(&label);
    manager.set_config(HcfsClientConfig {
        base_url: server_url.clone(),
        api_key: "Arion".to_string(),
        bearer_token: bearer_token.clone(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: fhash.clone(),
    })?;
    debug!(
        "HCFS config set with ss58_address: {}, folder_hash: {} (before unlock)",
        account_id, fhash
    );

    // 7. Init or unlock the drive (now ss58_address is set, so identity will be correct)
    let (user_id, mnemonic, is_new_setup) = if manager.is_initialized() {
        // Existing folder — just unlock
        debug!("Drive already initialized for '{}', unlocking...", label);
        debug!("Config dir: {:?}", folder_dir);

        match manager.unlock(&drive_password) {
            Ok(uid) => {
                info!("Drive unlocked, user_id: {}", uid);
                (uid, None, false)
            }
            Err(e) => {
                error!("Unlock failed for '{}': {}", label, e);
                info!("Attempting recovery: cleaning up encrypted files...");

                // Remove the corrupted/mismatched enc_mnemonic.json
                let enc_path = folder_dir.join("enc_mnemonic.json");
                if enc_path.exists() {
                    if let Err(rm_err) = std::fs::remove_file(&enc_path) {
                        warn!("Failed to remove enc_mnemonic.json: {}", rm_err);
                    } else {
                        debug!("Removed enc_mnemonic.json");
                    }
                }

                // Keep the master mnemonic — deleting it causes derivation
                // mismatches on other folders and cascading rekey markers.
                // Only the folder mnemonic is removed above.

                // Also remove sync_state.json to start fresh
                let state_path = folder_dir.join("sync_state.json");
                let state_bak_path = folder_dir.join("sync_state.json.bak");
                let _ = std::fs::remove_file(&state_path);
                let _ = std::fs::remove_file(&state_bak_path);

                // Clear any rekey marker — recovery generates a new key,
                // so purging old remote files is pointless and would block init.
                let _ = std::fs::remove_file(folder_dir.join(".needs_rekey"));

                info!("Recovery cleanup complete. Retrying initialization...");

                drop(manager);
                manager = HcfsDriveManager::new(PathBuf::from(&sync_path), folder_dir.clone());
                manager.set_config(HcfsClientConfig {
                    base_url: server_url.clone(),
                    api_key: "Arion".to_string(),
                    bearer_token: bearer_token.clone(),
                    accept_invalid_certs: true,
                    billing_bypass_token: None,
                    ss58_address: account_id.to_string(),
                    folder_hash: fhash.clone(),
                })?;

                debug!("Creating fresh drive after recovery...");

                // Use the login mnemonic if available so recovery stays
                // compatible with other devices. Only generate a random
                // master as a last resort.
                let master_str = if let Some(ref imported) = existing_mnemonic {
                    debug!("Using login mnemonic as master for recovery");
                    imported.clone()
                } else {
                    let master = bip39::Mnemonic::generate(24)
                        .map_err(|e| format!("Failed to generate mnemonic: {e}"))?;
                    warn!("Generated new random master for recovery (no login mnemonic available)");
                    master.to_string()
                };
                hcfs_client::auth::save_encrypted_mnemonic(
                    &master_path,
                    &master_str,
                    &drive_password,
                )
                .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;
                let derived = derive_folder_mnemonic(&master_str, &label)?;

                let mut init_mnemonic = manager.init(&drive_password, Some(&derived))?;
                zeroize::Zeroize::zeroize(&mut init_mnemonic);

                let uid = manager.unlock(&drive_password)?;
                info!(
                    "Drive re-initialized and unlocked, derived user_id: {}",
                    uid
                );

                (uid, Some(master_str), true)
            }
        }
    } else {
        // New folder — need to derive or generate mnemonic
        info!(
            "Drive not initialized for '{}', creating... (existing_mnemonic={}, master_exists={})",
            label,
            existing_mnemonic.is_some(),
            master_path.exists(),
        );

        let (folder_mnemonic, master_for_backup, generated_new_master) = if let Some(ref imported) =
            existing_mnemonic
        {
            // Always derive from the imported (login) mnemonic — this is the
            // cross-device portable secret. If the stored master differs
            // (e.g. legacy hcfs-client-generated mnemonic), replace it so
            // all devices agree on the derivation root.
            {
                use zeroize::Zeroize;

                if !master_path.exists() {
                    hcfs_client::auth::save_encrypted_mnemonic(
                        &master_path,
                        imported,
                        &drive_password,
                    )
                    .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;
                    info!("Saved login mnemonic as master (new device)");
                } else {
                    let stored = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
                        .map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
                    let mut stored_str = stored.to_string();
                    if stored_str != *imported {
                        info!("Stored master differs from login mnemonic — updating master");
                        hcfs_client::auth::save_encrypted_mnemonic(
                            &master_path,
                            imported,
                            &drive_password,
                        )
                        .map_err(|e| format!("Failed to update master mnemonic: {e}"))?;
                    } else {
                        debug!("Stored master matches login mnemonic");
                    }
                    stored_str.zeroize();
                }
                let derived = derive_folder_mnemonic(imported, &label)?;
                (derived, None, false)
            }
        } else if master_path.exists() {
            // Folder switch — read master, derive new folder mnemonic
            let master = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
                .map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
            let mut master_str = master.to_string();
            let derived = derive_folder_mnemonic(&master_str, &label)?;
            zeroize::Zeroize::zeroize(&mut master_str);
            debug!("Derived folder mnemonic from existing master");
            (derived, None, false)
        } else {
            // No login mnemonic AND no master on disk. Generating a random
            // master would silently encrypt files with a key that no other
            // device can derive, causing "Chunk 0 decryption failed" on
            // cross-device sync. Fail loudly so the user can re-login.
            return Err("No encryption key available. Please log out and log in \
                 again with your mnemonic to enable sync."
                .to_string());
        };

        // Initialize drive with the folder-specific derived mnemonic
        let mut init_mnemonic = manager.init(&drive_password, Some(&folder_mnemonic))?;
        zeroize::Zeroize::zeroize(&mut init_mnemonic);
        drop(init_mnemonic);
        let mut folder_mnemonic = folder_mnemonic;
        zeroize::Zeroize::zeroize(&mut folder_mnemonic);

        let uid = manager.unlock(&drive_password)?;
        info!(
            "Drive initialized and unlocked for '{}', derived user_id: {}",
            label, uid
        );

        (uid, master_for_backup, generated_new_master)
    };

    let expected_user_id = format!("{}_{}", account_id, fhash);
    debug!(
        "Drive user_id after unlock: {} (expected: {})",
        user_id, expected_user_id
    );
    if user_id != expected_user_id {
        return Err(format!(
            "Drive user_id mismatch: got '{}', expected '{}'. \
             This indicates a corrupted config directory. \
             Please remove the folder and re-add it.",
            user_id, expected_user_id
        ));
    }

    // 8. Test server connectivity
    {
        let test_url = format!("{}/health", &server_url);
        debug!("Testing connectivity to: {}", test_url);
        let test_result = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| format!("Failed to build test client: {e}"))?
            .get(&test_url)
            .header("X-API-Key", "Arion")
            .send()
            .await;
        match test_result {
            Ok(resp) => debug!("Health check OK: status={}", resp.status()),
            Err(e) => {
                let mut msg = format!("{e}");
                let mut source: Option<&dyn std::error::Error> = e.source();
                while let Some(cause) = source {
                    msg.push_str(&format!("\n  caused by: {cause}"));
                    source = cause.source();
                }
                warn!("Health check failed: {}", msg);
            }
        }
    }

    // 9. Setup progress event handlers with label
    setup_progress_handlers(&app, &mut manager, &label, sync);

    // 10. Clear any previous cancellation flag
    sync.clear_cancel();

    // 11. If ensure_derived_mnemonic left a rekey marker, just consume it.
    //     We intentionally do NOT delete remote files — doing so destroys
    //     data on other devices. Stale remote files encrypted with the old
    //     key will fail to decrypt and be skipped; local files will be
    //     re-uploaded with the new key on the next sync cycle.
    {
        let marker = folder_dir.join(".needs_rekey");
        if marker.exists() {
            info!(
                "Rekey marker found for '{}' — consuming without remote purge",
                label
            );
            let _ = std::fs::remove_file(&marker);
        }
    }

    // 12. Pre-populate the synced-paths cache BEFORE storing the drive in the
    //     registry.  This ensures the file browser shows correct sync status
    //     even if the first sync cycle locks the drive before the frontend
    //     queries `list_sync_folder`.  Without this, the cache would be empty
    //     and `synced_paths_for_label` would fall back to `None` (= "unknown")
    //     or, after a recovery re-init, `Some(empty_map)` (= "pending").
    if let Ok(state) = manager.load_sync_state() {
        let paths = crate::commands::file_commands::build_synced_paths_from_state(&state);
        if !paths.is_empty() {
            info!(
                label = %label,
                synced_count = paths.len(),
                "Pre-populated synced-paths cache at drive registration",
            );
        }
        sync.update_synced_paths_cache(&label, paths);
    }

    // 13. Store the manager in the drives registry
    {
        let sync_root = PathBuf::from(&sync_path);
        sync.register_label_root(label.clone(), sync_root);
        let mut guard = sync.drives.lock().await;
        guard.insert(
            label.clone(),
            DriveSlot {
                manager: std::sync::Arc::new(TokioMutex::new(manager)),
                cancel_token: CancellationToken::new(),
            },
        );
    }

    // 14. Start (or restart) the background sync loop to pick up the new drive
    if start_loop {
        start_sync_loop(app.clone()).await;
    }

    info!(
        "Sync initialized successfully for '{}'. User ID: {}, New setup: {}",
        label, user_id, is_new_setup
    );

    // Register folder with server for cross-device discovery (best-effort)
    {
        let reg_server = server_url.clone();
        let reg_token = bearer_token.clone();
        let reg_label = label.clone();
        let reg_ss58 = account_id.to_string();
        let reg_fhash = fhash.clone();
        let reg_pool = pool.clone();
        tokio::spawn(async move {
            let config = HcfsClientConfig {
                base_url: reg_server,
                api_key: "Arion".to_string(),
                bearer_token: reg_token,
                accept_invalid_certs: true,
                billing_bypass_token: None,
                ss58_address: reg_ss58.clone(),
                folder_hash: reg_fhash.clone(),
            };
            match hcfs_client::client::HcfsClient::new(config) {
                Ok(client) => {
                    let dev_name = get_device_name_internal(&reg_pool).await.ok();
                    if let Err(e) = client
                        .register_folder(&reg_ss58, &reg_fhash, &reg_label, dev_name.as_deref())
                        .await
                    {
                        warn!("Folder registration failed: {}", e);
                    } else {
                        info!("Folder '{}' registered with server", reg_label);
                    }
                }
                Err(e) => {
                    warn!("Could not create client for folder registration: {}", e);
                }
            }
        });
    }

    Ok(InitSyncResult {
        user_id,
        mnemonic,
        is_new_setup,
    })
}

/// Stop ALL drives (used on logout).
#[tauri::command]
pub async fn stop_sync(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    sync.request_cancel();

    // Abort the background sync loop task to prevent spurious error events
    {
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
    }

    // Clear the file watcher
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered in stop_sync");
            p.into_inner()
        });
        *watcher_guard = None;
    }

    {
        let mut guard = sync.drives.lock().await;
        // Cancel all in-progress syncs before clearing
        for slot in guard.values() {
            slot.cancel_token.cancel();
        }
        guard.clear();
    }
    sync.reset_sync_counter();
    sync.review_mode.store(false, Ordering::Release);
    sync.clear_review_entered();
    sync.reset_all_states();
    sync.reset_health();
    sync.reset_sync_failures();
    sync.discard_all_pending_activity();
    sync.clear_label_roots();

    // Emit sync stopped event so frontend can reset UI state (tray icon, sync widget)
    let _ = app.emit(sync_events::SYNC_STOPPED, ());

    Ok(())
}

/// Stop a single drive by label. If no drives remain, also stops the sync loop.
/// Also removes the corresponding sync_paths DB row so the drive is not
/// resurrected on restart (prevents ghost sync paths).
#[tauri::command]
pub async fn stop_drive(app: AppHandle, label: String) -> Result<(), String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let (remaining, removed_path) = {
        let mut guard = sync.drives.lock().await;
        let path = guard.get(&label).and_then(|slot| {
            slot.manager.try_lock().ok().map(|m| m.sync_path().to_path_buf())
        });
        if let Some(slot) = guard.remove(&label) {
            slot.cancel_token.cancel();
        }
        (guard.len(), path)
    };
    sync.unregister_label_root(&label);

    // Unwatch the removed drive's path to avoid spurious watcher events
    // that would wake the sync loop for a drive that no longer exists.
    if let Some(path) = &removed_path {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered in stop_drive unwatch");
            p.into_inner()
        });
        if let Some(w) = watcher_guard.as_mut() {
            let _ = w.unwatch(path);
        }
    }

    sync.remove_state(&label);
    sync.discard_pending_activity_for_label(&label);
    // Clean up sync progress files for this drive
    let _ = crate::sync_progress::remove_files_for_label(sync, label.clone());

    // Remove the DB row so the drive isn't resurrected on app restart.
    // Best-effort: if the account or pool isn't available, the in-memory
    // cleanup above still takes effect for this session.
    {
        if let (Ok(pool), Ok(acct)) = (
            app_state.pool(),
            crate::utils::sync::current_account_id(&app_state),
        ) {
            if let Err(e) =
                crate::commands::substrate_tx::remove_sync_path_internal(pool, &acct, &label).await
            {
                warn!("Failed to remove sync path for '{}' from DB: {e}", label);
            }
        }
    }

    if remaining == 0 {
        // No more drives — stop the sync loop entirely
        sync.request_cancel();
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
        // Clear the watcher since the loop is done
        {
            let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
                warn!("Poisoned watcher mutex recovered in stop_drive");
                p.into_inner()
            });
            *watcher_guard = None;
        }
        sync.review_mode.store(false, Ordering::Release);
        sync.clear_review_entered();
        let _ = app.emit(sync_events::SYNC_STOPPED, ());
    }

    info!("Stopped drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Reset sync data for an account, clearing all local sync state.
/// This allows starting fresh without corrupted or stale sync data.
///
/// IMPORTANT: This does NOT delete files in the sync folder - only HCFS metadata.
/// Files on the server remain intact.
#[tauri::command]
pub async fn reset_sync_data(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: AppHandle,
    account_id: String,
) -> Result<(), String> {
    info!("Resetting sync data for account: {}", account_id);

    // First stop all active syncs
    stop_sync(app.clone()).await?;

    // Get the account directory
    let acct_dir = account_dir(&account_id)?;

    debug!("Reset: Deleting account directory: {:?}", acct_dir);

    // Delete the entire account directory (contains sync state, encrypted mnemonic, etc.)
    if acct_dir.exists() {
        std::fs::remove_dir_all(&acct_dir)
            .map_err(|e| format!("Failed to delete account directory: {}", e))?;
        debug!("Reset: Deleted account directory");
    }

    // Also clear the hcfs_config from database so user goes through setup again
    let db = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .execute(db)
        .await
        .map_err(|e| format!("Failed to clear config: {}", e))?;

    debug!("Reset: Cleared database config");

    // Emit event so frontend knows to show setup UI
    let _ = app.emit(
        sync_events::SYNC_RESET,
        sync_events::SyncResetPayload {
            account_id: account_id.to_string(),
            message: "Sync data has been reset. Please set up sync again.".to_string(),
        },
    );

    info!("Reset complete for account: {}", account_id);

    Ok(())
}

/// Check whether the HCFS sync engine is active.
/// With optional label: checks if that specific drive is active.
/// Without label: checks if any drive is active.
#[tauri::command]
pub fn is_drive_active(
    state: tauri::State<'_, crate::app_state::AppState>,
    label: Option<String>,
) -> bool {
    match state.sync.drives.try_lock() {
        Ok(guard) => {
            if let Some(lbl) = label {
                guard.contains_key(&lbl)
            } else {
                !guard.is_empty()
            }
        }
        // If the lock is held, the drive is in use (sync in progress) → active
        Err(_) => true,
    }
}

#[tauri::command]
pub async fn trigger_sync_now(app: AppHandle) -> Result<(), String> {
    crate::hcfs_drive::trigger_sync(&app).await;
    Ok(())
}

fn setup_progress_handlers(
    app: &AppHandle,
    manager: &mut HcfsDriveManager,
    label: &str,
    sync: &Arc<crate::sync_engine::SyncEngine>,
) {
    let a0 = app.clone();
    let a1 = app.clone();
    let a2 = app.clone();
    let a5 = app.clone();
    let a6 = app.clone();

    let l0 = label.to_string();
    let l1 = label.to_string();
    let l2 = label.to_string();
    let l3 = label.to_string();
    let l4 = label.to_string();
    let l5 = label.to_string();
    let l6 = label.to_string();
    let l7 = label.to_string();

    // Clone Arc<SyncEngine> for each callback that needs engine access
    let sync_plan = sync.clone();
    let sync_for_upload = sync.clone();
    let sync_for_download = sync.clone();
    let sync_encrypt = sync.clone();
    let sync_decrypt = sync.clone();
    let sync_scan = sync.clone();
    let sync_fetch = sync.clone();
    let sync_file_synced = sync.clone();

    // Track first progress event per file for info-level "file started" logs
    let upload_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    let download_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    let upload_started_cb = Arc::clone(&upload_started);
    let download_started_cb = Arc::clone(&download_started);

    manager.set_progress(SyncProgress {
        on_sync_plan_ready: Some(Arc::new(move |uploads, downloads, local_deletes, remote_deletes, renames| {
            sync_plan.touch_progress_time();
            let total = uploads.len() + downloads.len() + local_deletes.len() + remote_deletes.len() + renames.len();
            if total == 0 {
                return;
            }
            info!(
                "Sync plan ready [{}]: {} uploads, {} downloads, {} local_deletes, {} remote_deletes, {} renames",
                l0, uploads.len(), downloads.len(), local_deletes.len(), remote_deletes.len(), renames.len()
            );

            // Extract paths and sizes from SyncPlanFile entries
            let upload_paths: Vec<String> = uploads.iter().map(|f| f.path.clone()).collect();
            let download_paths: Vec<String> = downloads.iter().map(|f| f.path.clone()).collect();
            let local_delete_paths: Vec<String> = local_deletes.iter().map(|f| f.path.clone()).collect();
            let remote_delete_paths: Vec<String> = remote_deletes.iter().map(|f| f.path.clone()).collect();

            // Build file size map for all plan entries so register_files
            // can set total_bytes upfront (including download sizes from
            // the fresh remote tree in hcfs-client's memory).
            let size_map: std::collections::HashMap<String, u64> = uploads
                .iter()
                .chain(downloads.iter())
                .chain(local_deletes.iter())
                .chain(remote_deletes.iter())
                .filter(|f| f.size_bytes > 0)
                .map(|f| (f.path.clone(), f.size_bytes))
                .collect();

            // Merge real file counts into the empty session created before sync started
            let file_list = crate::sync_progress::SessionFileList {
                upload_files: Some(upload_paths.clone()),
                download_files: Some(download_paths.clone()),
                local_delete_files: Some(local_delete_paths.clone()),
                remote_delete_files: Some(remote_delete_paths.clone()),
            };
            let _ = crate::sync_progress::merge_into_session(
                &sync_plan,
                uploads.len() as u32, downloads.len() as u32,
                local_deletes.len() as u32, remote_deletes.len() as u32,
                Some(file_list), Some(l0.clone()),
            );

            // Patch file sizes from the plan into the session entries.
            // This gives accurate byte totals immediately — no need to
            // wait for each file's first progress callback.
            if !size_map.is_empty() {
                let mut progress_state = sync_plan.progress.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(session) = progress_state.current_session.as_mut() {
                    let mut patched = 0usize;
                    for (path, size) in &size_map {
                        if let Some(file) = session.files.get_mut(path) {
                            if file.total_bytes == 0 {
                                file.total_bytes = *size;
                                patched += 1;
                            }
                        }
                    }
                    if patched > 0 {
                        info!(patched, total, label = %l0, "Patched file sizes from sync plan");
                    }
                }
                drop(progress_state);
                sync_plan.emit_snapshot(true);
            }

            let _ = a0.emit(
                sync_events::SYNC_PLAN_READY,
                sync_events::SyncPlanReadyPayload {
                    label: l0.clone(),
                    uploads: uploads.len(),
                    downloads: downloads.len(),
                    local_deletes: local_deletes.len(),
                    remote_deletes: remote_deletes.len(),
                    upload_files: upload_paths,
                    download_files: download_paths,
                    local_delete_files: local_delete_paths,
                    remote_delete_files: remote_delete_paths,
                },
            );
        })),
        on_upload_progress: Some(Arc::new(move |b, t, p| {
            sync_for_upload.touch_progress_time();
            // Log first progress event for each file at info level
            if let Some(path_str) = p {
                let file_name = Path::new(path_str)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.to_string());
                if let Ok(mut set) = upload_started_cb.lock() {
                    if set.insert(path_str.to_string()) {
                        if b > 0 {
                            info!(
                                "Upload resuming [{}]: {} from {} bytes ({} total)",
                                l1, file_name, b, t
                            );
                        } else {
                            info!(
                                "Upload started [{}]: {} ({} bytes)",
                                l1, file_name, t
                            );
                        }
                    }
                }
                // Track per-file progress for the sync progress UI
                let _ = crate::sync_progress::update_file_progress(
                    &sync_for_upload, path_str.to_string(), b, t,
                    crate::sync_progress::FileAction::Upload,
                    Some(l1.clone()),
                );
            }
            debug!("Upload [{}]: {}/{} bytes, path: {:?}", l1, b, t, p);
            let _ = a1.emit(
                sync_events::UPLOAD_PROGRESS,
                sync_events::TransferProgressPayload { label: l1.clone(), bytes: b, total: t, path: p.map(String::from) },
            );
            if b == t && t > 0 {
                if let Some(path_str) = p {
                    // Use the full relative path (e.g. "bucket/photo.jpg")
                    // so recent-files can resolve the correct on-disk location.
                    let file_name = path_str.to_string();
                    info!("Upload complete [{}]: {} ({} bytes)", l1, file_name, t);
                    sync_for_upload.add_pending_activity(SyncActivityItem {
                        file_name,
                        action: "uploaded".to_string(),
                        timestamp: chrono::Utc::now().timestamp(),
                        size_bytes: t,
                        label: l1.clone(),
                    });
                    if l1 == "migration" {
                        crate::commands::migration::record_migration_upload(&a1, path_str.to_string());
                    }
                }
            }
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            sync_for_download.touch_progress_time();
            // Log first progress event for each file at info level
            if let Some(path_str) = p {
                let file_name = Path::new(path_str)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.to_string());
                if let Ok(mut set) = download_started_cb.lock() {
                    if set.insert(path_str.to_string()) {
                        if b > 0 {
                            info!(
                                "Download resuming [{}]: {} from {} bytes ({} total)",
                                l2, file_name, b, t
                            );
                        } else {
                            info!(
                                "Download started [{}]: {} ({} bytes)",
                                l2, file_name, t
                            );
                        }
                    }
                }
                // Track per-file progress for the sync progress UI
                let _ = crate::sync_progress::update_file_progress(
                    &sync_for_download, path_str.to_string(), b, t,
                    crate::sync_progress::FileAction::Download,
                    Some(l2.clone()),
                );
            }
            debug!("Download [{}]: {}/{} bytes, path: {:?}", l2, b, t, p);
            let _ = a2.emit(
                sync_events::DOWNLOAD_PROGRESS,
                sync_events::TransferProgressPayload { label: l2.clone(), bytes: b, total: t, path: p.map(String::from) },
            );
            // Record download completion with the encrypted name. The real
            // file name is resolved later in trigger_sync_for_drive using
            // the path_index (the callback only sees names like "file_09977d01...").
            if b == t && t > 0 {
                if let Some(path_str) = p {
                    let file_name = Path::new(path_str)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| path_str.to_string());
                    info!("Download complete [{}]: {} ({} bytes)", l2, file_name, t);
                    sync_for_download.add_pending_activity(SyncActivityItem {
                        file_name,
                        action: "downloaded".to_string(),
                        timestamp: chrono::Utc::now().timestamp(),
                        size_bytes: t,
                        label: l2.clone(),
                    });
                }
            }
        })),
        on_encrypt_progress: Some(Arc::new(move |b, t, p| {
            sync_encrypt.touch_progress_time();
            if b == 0 {
                info!("Encrypt starting [{}]: {:?} ({} bytes)", l3, p, t);
            } else if b == t && t > 0 {
                info!("Encrypt complete [{}]: {:?} ({} bytes)", l3, p, t);
            }
            // Track encrypt progress for UI (no per-chunk Tauri emit — that
            // was the main encryption bottleneck at ~1333 emits per 341MB).
            if let Some(path_str) = p {
                let _ = crate::sync_progress::update_file_progress(
                    &sync_encrypt, path_str.to_string(), b, t,
                    crate::sync_progress::FileAction::Encrypt,
                    Some(l3.clone()),
                );
            }
        })),
        on_decrypt_progress: Some(Arc::new(move |b, t, p| {
            sync_decrypt.touch_progress_time();
            if b == 0 {
                info!("Decrypt starting [{}]: {:?} ({} bytes)", l4, p, t);
            } else if b == t && t > 0 {
                info!("Decrypt complete [{}]: {:?} ({} bytes)", l4, p, t);
            }
            // Track decrypt progress for UI (no per-chunk Tauri emit).
            if let Some(path_str) = p {
                let _ = crate::sync_progress::update_file_progress(
                    &sync_decrypt, path_str.to_string(), b, t,
                    crate::sync_progress::FileAction::Decrypt,
                    Some(l4.clone()),
                );
            }
        })),
        on_scan_progress: Some(Arc::new(move |n, p| {
            sync_scan.touch_progress_time();
            info!("Scan [{}]: {} files scanned, current: {:?}", l5, n, p);
            let _ = a5.emit(
                sync_events::SCAN_PROGRESS,
                sync_events::ScanProgressPayload { label: l5.clone(), scanned: n, path: p.map(|p| p.to_string()) },
            );
        })),
        on_fetch_state_progress: Some(Arc::new(move |f, t| {
            sync_fetch.touch_progress_time();
            info!("Fetch state [{}]: {}/{} entries", l6, f, t);
            let _ = a6.emit(
                sync_events::FETCH_PROGRESS,
                sync_events::FetchProgressPayload { label: l6.clone(), fetched: f, total: t },
            );
        })),
        on_file_synced: Some(Arc::new(move |rel_path: &str, path_hash_hex: &str, arion_cid: &str, action: &str| {
            debug!(
                "File synced [{}]: {} ({}) cid={}",
                l7, rel_path, action, arion_cid
            );
            // Update the synced-paths cache incrementally so the frontend
            // can show arion hashes for files that completed during sync,
            // without waiting for the full cycle to finish.
            if !rel_path.is_empty() {
                let info = crate::commands::file_commands::SyncedFileInfo::new(
                    path_hash_hex.to_string(),
                    arion_cid.to_string(),
                );
                sync_file_synced.upsert_synced_path(
                    &l7,
                    rel_path.to_string(),
                    info,
                );
            }
        })),
    });
}

/// Retrieve the master BIP-39 mnemonic for an account by decrypting it from
/// disk. Shared implementation used by both the Tauri command and the billing
/// auth module.
///
/// Takes `&AppState` to access both the DB pool and the live drive registry
/// without relying on global state.
pub async fn get_mnemonic_for_account(
    app_state: &crate::app_state::AppState,
    account_id: &str,
) -> Result<String, String> {
    let pool = app_state.pool()?;
    let drive_password = get_drive_password(pool, account_id).await?;

    // Prefer the master mnemonic at account level
    let master_path = master_mnemonic_path(account_id)?;
    if master_path.exists() {
        let mnemonic = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
            .map_err(|e| e.to_string())?;
        return Ok(mnemonic.to_string());
    }

    // Fallback: try the first active drive's folder mnemonic (pre-migration state).
    warn!(
        "Master mnemonic not found at {:?}, falling back to per-folder mnemonic",
        master_path
    );
    let first_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.values().next().map(|slot| slot.manager.clone())
    };
    match first_arc {
        Some(arc) => {
            let m = arc.lock().await;
            if m.is_initialized() {
                m.export_mnemonic(&drive_password)
            } else {
                Err("Drive is not initialized".to_string())
            }
        }
        None => {
            // No active drive — try reading DB for any sync path
            let owner = account_key(account_id);
            let result: Option<(String, String)> =
                sqlx::query_as("SELECT path, label FROM sync_paths WHERE owner = ? LIMIT 1")
                    .bind(&owner)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| format!("DB error: {e}"))?;

            if let Some((path, lbl)) = result {
                let folder_dir = config_dir_for_folder(account_id, &lbl)?;
                let manager = HcfsDriveManager::new(PathBuf::from(&path), folder_dir);
                if manager.is_initialized() {
                    manager.export_mnemonic(&drive_password)
                } else {
                    Err("Drive is not initialized".to_string())
                }
            } else {
                Err("No sync paths configured".to_string())
            }
        }
    }
}

/// Tauri command wrapper: return the master BIP-39 mnemonic by decrypting it
/// from disk.
#[tauri::command]
pub async fn get_drive_mnemonic(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<String, String> {
    get_mnemonic_for_account(&state, &account_id).await
}

/// Persist the master mnemonic to disk early (during login), even before any
/// sync folder is configured. This prevents the fallback to a random master
/// that would make cross-device sync impossible.
///
/// If a master already exists on disk but differs from the provided mnemonic,
/// it is updated to match the login mnemonic (source of truth for cross-device
/// sync). No-op if the HCFS drive password has not been set yet.
#[tauri::command]
pub async fn persist_master_mnemonic(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    mnemonic: String,
) -> Result<(), String> {
    let pool = state.pool()?;
    let master_path = master_mnemonic_path(&account_id)?;

    let drive_password = match get_drive_password(pool, &account_id).await {
        Ok(pw) => pw,
        Err(_) => {
            // HCFS config not set up yet — nothing we can do.
            // The master will be saved when initialize_sync runs.
            return Ok(());
        }
    };

    if master_path.exists() {
        // Compare stored master with the login mnemonic. A mismatch means
        // the master was generated randomly (e.g. app restart lost the
        // in-memory mnemonic). Update it so initialize_sync's step 4b and
        // ensure_derived_mnemonic can detect and fix folder key mismatches.
        use zeroize::Zeroize;
        let stored = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
            .map_err(|e| format!("Failed to recover master: {e}"))?;
        let mut stored_str = stored.to_string();
        if stored_str == mnemonic {
            stored_str.zeroize();
            return Ok(());
        }
        stored_str.zeroize();
        info!("Stored master differs from login mnemonic — updating early");
    }

    let acct_dir = account_dir(&account_id)?;
    std::fs::create_dir_all(&acct_dir).map_err(|e| format!("Failed to create account dir: {e}"))?;

    hcfs_client::auth::save_encrypted_mnemonic(&master_path, &mnemonic, &drive_password)
        .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;

    info!(
        "Eagerly persisted master mnemonic for account {}",
        &account_id[..8.min(account_id.len())]
    );
    Ok(())
}

/// Stage changes and return a preview of what will sync.
/// Pauses auto-sync while the user reviews.
#[tauri::command]
pub async fn stage_changes(app: tauri::AppHandle) -> Result<StagedChanges, String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // RAII guard: sets review_mode=true now, resets on drop unless commit()ed.
    let review_guard = ReviewModeGuard::new(sync.clone());

    // For V1, stage the first available drive
    let first_arc = {
        let guard = sync.drives.lock().await;
        guard.values().next().map(|slot| slot.manager.clone())
    };
    let arc = first_arc.ok_or_else(|| "Drive not initialized".to_string())?;

    let m = arc
        .try_lock()
        .map_err(|_| "Sync is in progress, please wait".to_string())?;

    if !m.is_unlocked() {
        return Err("Drive is not unlocked".to_string());
    }

    let changes = m.stage_with_paths().await?;
    review_guard.commit();
    Ok(changes)
}

/// Sync with user-provided conflict resolutions, then resume auto-sync.
/// `resolutions` maps hex-encoded FileId → resolution string
/// (one of: "keep_local", "accept_remote", "keep_both", "skip").
#[tauri::command]
pub async fn sync_with_conflict_resolutions(
    app: AppHandle,
    resolutions: HashMap<String, String>,
) -> Result<(), String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Validate resolution values before proceeding
    for (file_id, resolution) in &resolutions {
        if !matches!(
            resolution.as_str(),
            "keep_local" | "accept_remote" | "keep_both" | "skip"
        ) {
            return Err(format!(
                "Invalid resolution '{}' for file {}",
                resolution, file_id
            ));
        }
    }

    // For V1, use the first drive's label
    let label: String = {
        let guard = sync.drives.lock().await;
        guard
            .keys()
            .next()
            .cloned()
            .unwrap_or_else(|| "default".to_string())
    };

    // Mark syncing in shared state
    sync.update_state(&label, |s| {
        s.is_syncing = true;
    });

    let _ = app.emit(sync_events::SYNC_STARTED, sync_events::LabelPayload { label: label.clone() });

    // Suppress file watcher during sync to prevent feedback loops
    sync.begin_sync();

    let result = {
        let drive_arc = {
            let guard = sync.drives.lock().await;
            guard.get(&label).map(|slot| slot.manager.clone())
        };
        match drive_arc {
            Some(arc) => {
                let mut m = arc.lock().await;
                if m.is_unlocked() {
                    Some(m.sync_with_resolutions(resolutions).await)
                } else {
                    None
                }
            }
            None => None,
        }
    };

    // Re-enable file watcher after a short delay to ignore trailing FS events
    {
        let sync_for_delay = sync.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            sync_for_delay.end_sync();
        });
    }

    // Resume auto-sync
    sync.review_mode.store(false, Ordering::Release);
    sync.clear_review_entered();

    // Update shared state
    sync.update_state(&label, |s| {
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    });

    match result {
        Some(Ok(outcome)) => {
            info!(
                "Reviewed sync completed: uploaded={}, downloaded={}, deleted_local={}, deleted_remote={}, conflicts_resolved={}, conflicts_skipped={}",
                outcome.files_uploaded,
                outcome.files_downloaded,
                outcome.files_deleted_locally,
                outcome.files_deleted_remotely,
                outcome.conflicts_resolved,
                outcome.conflicts_skipped,
            );
            let _ = app.emit(
                sync_events::SYNC_COMPLETED,
                sync_events::SyncCompletedPayload::from_outcome(&label, &outcome),
            );
            Ok(())
        }
        Some(Err(e)) => {
            let _ = app.emit(
                sync_events::SYNC_ERROR,
                sync_events::SyncErrorPayload { label: label.clone(), error: e.clone(), retry_in_secs: 0, consecutive_failures: 0 },
            );
            Err(e)
        }
        None => {
            let msg = "Drive not initialized or not unlocked".to_string();
            let _ = app.emit(
                sync_events::SYNC_ERROR,
                sync_events::SyncErrorPayload { label: label.clone(), error: msg.clone(), retry_in_secs: 0, consecutive_failures: 0 },
            );
            Err(msg)
        }
    }
}

/// Cancel the review dialog and resume auto-sync without syncing.
#[tauri::command]
pub async fn cancel_review(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    sync.review_mode.store(false, Ordering::Release);
    sync.clear_review_entered();
    info!("Review cancelled, auto-sync resumed");
    Ok(())
}

/// Create a password-protected zip file containing the plaintext mnemonic.
/// Uses AES-256 encryption on the zip entry.
#[tauri::command]
pub async fn create_encrypted_backup(
    mut mnemonic: String,
    mut password: String,
    output_path: String,
) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let buf = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(buf);

        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .with_aes_encryption(zip::AesMode::Aes256, &password);

        zip.start_file("recovery-phrase.txt", options)
            .map_err(|e| format!("Failed to create zip entry: {e}"))?;
        zip.write_all(mnemonic.as_bytes())
            .map_err(|e| format!("Failed to write mnemonic: {e}"))?;

        let cursor = zip
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {e}"))?;
        std::fs::write(&output_path, cursor.into_inner())
            .map_err(|e| format!("Failed to write backup file: {e}"))?;

        Ok(())
    })();

    // Clear sensitive data from memory before dropping.
    zeroize::Zeroize::zeroize(&mut mnemonic);
    zeroize::Zeroize::zeroize(&mut password);

    result
}

// =============================================================================
// Remote Storage Stats (aggregated across all folders + S3 uploads)
// =============================================================================

#[derive(serde::Serialize, Clone)]
pub struct RemoteStorageStatsResult {
    pub total_bytes: u64,
    pub file_count: u64,
}

/// Get aggregated storage stats for the user from the HCFS server.
///
/// Unlike `list_remote_folders` (which only counts sync folder files),
/// this calls `GET /get_user_summary/{account_id}` which returns totals
/// across all manifests — sync folders AND S3 uploads.
#[tauri::command]
pub async fn get_remote_storage_stats(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<RemoteStorageStatsResult, String> {
    let pool = state.pool()?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };

    let bearer_token = get_api_token(pool, &account_id)
        .await
        .map_err(|e| format!("Failed to get auth token: {e}"))?
        .ok_or_else(|| "No authentication token found. Please log in again.".to_string())?;

    let url = format!("{}/get_user_summary/{}", server_url, account_id);

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .header("X-API-Key", "Arion")
        .header("Authorization", format!("Bearer {}", bearer_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch storage stats: {e}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(RemoteStorageStatsResult {
            total_bytes: 0,
            file_count: 0,
        });
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Server returned {status}: {body}"));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    // Server returns NetworkResponse enum: {"Success": {...}} or {"Error": {...}}
    match body.get("Success") {
        Some(data) => {
            let total_bytes = data
                .get("total_bytes")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let file_count = data.get("file_count").and_then(|v| v.as_u64()).unwrap_or(0);
            Ok(RemoteStorageStatsResult {
                total_bytes,
                file_count,
            })
        }
        None => {
            let err_msg = body
                .get("Error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            Err(format!("Server error: {err_msg}"))
        }
    }
}

// =============================================================================
// Remote Folder Discovery (Restore from Remote)
// =============================================================================

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

/// List all folders registered for the current account on the remote server.
#[tauri::command]
pub async fn list_remote_folders(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<Vec<RemoteFolderInfoResult>, String> {
    info!("Listing remote folders for account '{}'", account_id);
    let pool = state.pool()?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };

    let bearer_token = get_api_token(pool, &account_id)
        .await
        .map_err(|e| format!("Failed to get auth token: {e}"))?
        .ok_or_else(|| "No authentication token found. Please log in again.".to_string())?;

    let client_config = HcfsClientConfig {
        base_url: server_url,
        api_key: "Arion".to_string(),
        bearer_token,
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: account_id.clone(),
        folder_hash: String::new(),
    };

    let client = hcfs_client::client::HcfsClient::new(client_config)
        .map_err(|e| format!("Failed to create HCFS client: {e}"))?;

    let folders = client.list_remote_folders(&account_id).await.map_err(|e| {
        error!(
            "Failed to list remote folders for account '{}': {e}",
            account_id
        );
        format!("Failed to list remote folders: {e}")
    })?;

    info!(
        "Found {} remote folders for account '{}'",
        folders.len(),
        account_id
    );

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

fn sanitize_label(label: &str) -> Result<String, String> {
    let sanitized: String = label
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ' || *c == '.')
        .collect();
    let trimmed = sanitized.trim_matches('.').trim();
    if trimmed.is_empty() {
        return Err(format!("Invalid folder label: '{}'", label));
    }
    Ok(trimmed.to_string())
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
) -> Result<Vec<RestoreResult>, String> {
    info!(
        "Restoring {} remote folder(s) to '{}' for account '{}'",
        folders.len(),
        base_path,
        account_id
    );
    let pool = state.pool()?;
    let mut results = Vec::with_capacity(folders.len());
    let mut any_success = false;

    for folder in &folders {
        let safe_label = match sanitize_label(&folder.label) {
            Ok(l) => l,
            Err(e) => {
                results.push(RestoreResult {
                    label: folder.label.clone(),
                    success: false,
                    error: Some(e),
                });
                continue;
            }
        };
        let folder_path = PathBuf::from(&base_path).join(&safe_label);

        // Create the directory
        if let Err(e) = std::fs::create_dir_all(&folder_path) {
            results.push(RestoreResult {
                label: folder.label.clone(),
                success: false,
                error: Some(format!("Failed to create directory: {e}")),
            });
            continue;
        }

        let path_str = folder_path.to_string_lossy().to_string();

        // Set sync path in DB
        if let Err(e) = crate::commands::substrate_tx::set_sync_path_internal(
            pool,
            &account_id,
            &path_str,
            false,
            Some(&folder.label),
        )
        .await
        {
            results.push(RestoreResult {
                label: folder.label.clone(),
                success: false,
                error: Some(format!("Failed to set sync path: {e}")),
            });
            continue;
        }

        // Wipe stale sync state before restore so the three-tree algorithm
        // treats all remote files as RemoteCreate (download), not LocalDelete
        // (which would delete them from the server). This is critical: a leftover
        // sync_state.json with a populated synced tree + empty local folder would
        // cause the sync engine to propagate "local deletions" to the server.
        if let Ok(fd) = config_dir_for_folder(&account_id, &folder.label) {
            for name in &["sync_state.json", "sync_state.json.bak"] {
                let p = fd.join(name);
                if p.exists() {
                    info!(
                        "Removing stale {} for '{}' to prevent remote deletions",
                        name, folder.label
                    );
                    let _ = std::fs::remove_file(&p);
                }
            }
        }

        // Initialize sync without starting the loop (start_loop = false)
        match initialize_sync_inner(
            app.clone(),
            account_id.clone(),
            folder.label.clone(),
            existing_mnemonic.clone(),
            false,
        )
        .await
        {
            Ok(_) => {
                any_success = true;
                info!("Successfully restored remote folder '{}'", folder.label);
                results.push(RestoreResult {
                    label: folder.label.clone(),
                    success: true,
                    error: None,
                });
            }
            Err(e) => {
                error!("Failed to restore remote folder '{}': {e}", folder.label);
                // Rollback: remove the sync path we just inserted
                if let Err(rollback_err) = crate::commands::substrate_tx::remove_sync_path_internal(
                    pool,
                    &account_id,
                    &folder.label,
                )
                .await
                {
                    warn!(
                        "Failed to rollback sync path for '{}': {rollback_err}",
                        folder.label
                    );
                }
                results.push(RestoreResult {
                    label: folder.label.clone(),
                    success: false,
                    error: Some(e),
                });
            }
        }
    }

    // Start the sync loop once for all successfully restored drives
    if any_success {
        start_sync_loop(app.clone()).await;
    }

    Ok(results)
}

// =============================================================================
// Delete Remote Folder
// =============================================================================

#[derive(serde::Serialize)]
pub struct DeleteRemoteFolderResult {
    pub files_deleted: u64,
    pub was_local: bool,
}

/// Delete all files for a folder from the remote server and unregister it.
/// If the folder is also synced locally, stops the drive and removes the sync path.
#[tauri::command]
pub async fn delete_remote_folder(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
) -> Result<DeleteRemoteFolderResult, String> {
    info!(
        "Deleting remote folder '{}' for account '{}'",
        label, account_id
    );
    let pool = state.pool()?;
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };

    let bearer_token = get_api_token(pool, &account_id)
        .await
        .map_err(|e| format!("Failed to get auth token: {e}"))?
        .ok_or_else(|| "No authentication token found. Please log in again.".to_string())?;

    let fhash = folder_hash(&label);

    let client_config = HcfsClientConfig {
        base_url: server_url,
        api_key: "Arion".to_string(),
        bearer_token,
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: fhash.clone(),
    };

    let client = hcfs_client::client::HcfsClient::new(client_config)
        .map_err(|e| format!("Failed to create HCFS client: {e}"))?;

    let result = client
        .unregister_folder(&account_id, &fhash)
        .await
        .map_err(|e| format!("Failed to delete remote folder: {e}"))?;

    // If this folder is also synced locally, stop the drive and remove the path
    let was_local = {
        let guard = state.sync.drives.lock().await;
        guard.contains_key(&label)
    }; // map lock released

    if was_local {
        if let Err(e) = stop_drive(app, label.clone()).await {
            warn!(
                "Failed to stop drive '{}' during remote folder deletion: {e}",
                label
            );
        }
        if let Err(e) =
            crate::commands::substrate_tx::remove_sync_path_internal(pool, &account_id, &label)
                .await
        {
            warn!(
                "Failed to remove sync path '{}' during remote folder deletion: {e}",
                label
            );
        }
    }

    info!(
        "Remote folder '{}' deleted: {} files removed, was_local={}",
        label, result.files_deleted, was_local
    );

    Ok(DeleteRemoteFolderResult {
        files_deleted: result.files_deleted,
        was_local,
    })
}

// =============================================================================
// Device Name
// =============================================================================

/// Internal helper to read the device name from DB.
async fn get_device_name_internal(pool: &SqlitePool) -> Result<String, String> {
    let row =
        sqlx::query_scalar::<_, String>("SELECT device_name FROM device_settings WHERE id = 1")
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to read device name: {e}"))?;
    Ok(row.unwrap_or_else(|| "My Device".to_string()))
}

/// Get the friendly device name for this machine.
#[tauri::command]
pub async fn get_device_name(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<String, String> {
    get_device_name_internal(state.pool()?).await
}

/// Set a custom friendly device name for this machine.
#[tauri::command]
pub async fn set_device_name(
    state: tauri::State<'_, crate::app_state::AppState>,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Device name cannot be empty".to_string());
    }
    let pool = state.pool()?;
    sqlx::query(
        "INSERT INTO device_settings (id, device_name, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET device_name = excluded.device_name, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(&name)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save device name: {e}"))?;
    info!("Device name updated: {}", name);
    Ok(())
}
