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
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::error::Error as _;
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;

/// HCFS server configuration returned by `get_hcfs_config`.
#[derive(serde::Serialize, Clone)]
pub struct HcfsConfigResult {
    pub server_url: String,
    pub has_password: bool,
}

/// Result of `initialize_sync` — contains the derived user ID and
/// whether this is a fresh setup (no existing drive metadata found).
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
) -> Result<(), crate::error::AppError> {
    let db = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r"
        INSERT INTO hcfs_config (owner, server_url, drive_password, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password,
            updated_at = CURRENT_TIMESTAMP
        ",
    )
    .bind(&owner)
    .bind(&server_url)
    .bind(&drive_password)
    .execute(db)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn update_hcfs_server_url(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    server_url: String,
) -> Result<(), crate::error::AppError> {
    let db = state.pool()?;
    let owner = account_key(&account_id);

    let result = sqlx::query(
        r"
        UPDATE hcfs_config SET server_url = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ?
        ",
    )
    .bind(&server_url)
    .bind(&owner)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(crate::error::AppError::Other("HCFS config not found. Please set up sync first.".into()));
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
) -> Result<(), crate::error::AppError> {
    let pool = state.pool()?;
    Ok(state.sync.update_bearer_token(pool, &account_id, &bearer_token).await?)
}

/// Internal helper that accepts a pool reference directly.
/// Used by both the Tauri command and other internal callers.
pub(crate) async fn get_hcfs_config_internal(pool: &SqlitePool, account_id: &str) -> Result<HcfsConfigResult, crate::error::AppError> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String, String)> = sqlx::query_as(
        r"
        SELECT server_url, drive_password FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

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
) -> Result<HcfsConfigResult, crate::error::AppError> {
    get_hcfs_config_internal(state.pool()?, &account_id).await
}

pub(crate) async fn get_drive_password(pool: &SqlitePool, account_id: &str) -> Result<String, crate::error::AppError> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String,)> = sqlx::query_as(
        r"
        SELECT drive_password FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

    result
        .map(|(password,)| password)
        .ok_or_else(|| crate::error::AppError::Other("HCFS config not found".into()))
}

/// Read the sync path for a specific label from the database.
async fn get_sync_path_for_label(pool: &SqlitePool, account_id: &str, label: &str) -> Result<String, crate::error::AppError> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String,)> = sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(label)
        .fetch_optional(db)
        .await?;

    result
        .map(|(path,)| path)
        .ok_or_else(|| crate::error::AppError::NotReady(crate::error::NotReadyKind::SyncSetup))
}

/// Compute the account-level directory: `~/.hippius/drives/<account_key>/`
fn account_dir(account_id: &str) -> Result<PathBuf, crate::error::AppError> {
    let home = dirs::home_dir().ok_or(crate::error::AppError::Other("Could not determine home directory".into()))?;
    let key = account_key(account_id);
    Ok(home.join(".hippius").join("drives").join(key))
}

/// Deterministic 16-char hex hash of a folder label, used as subdirectory name
/// and server namespace suffix.
fn folder_hash(label: &str) -> String {
    let digest = Sha256::digest(label.as_bytes());
    hex::encode(digest)[..16].to_string()
}

/// Compute the per-folder config directory:
/// `~/.hippius/drives/<account_key>/<folder_hash>/`
fn config_dir_for_folder(account_id: &str, label: &str) -> Result<PathBuf, crate::error::AppError> {
    Ok(account_dir(account_id)?.join(folder_hash(label)))
}

/// Path to the master encrypted mnemonic at the account level:
/// `~/.hippius/drives/<account_key>/master_enc_mnemonic.json`
fn master_mnemonic_path(account_id: &str) -> Result<PathBuf, crate::error::AppError> {
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
fn derive_folder_mnemonic(master_mnemonic: &str, label: &str) -> Result<String, crate::error::AppError> {
    use bip39::Mnemonic;
    use std::str::FromStr;
    use zeroize::Zeroize;

    let master = Mnemonic::from_str(master_mnemonic).map_err(|e| crate::error::AppError::Other(format!("Invalid master mnemonic: {e}")))?;
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
fn ensure_derived_mnemonic(folder_dir: &Path, master_path: &Path, password: &str, label: &str) -> Result<(), crate::error::AppError> {
    use zeroize::Zeroize;

    let folder_enc = folder_dir.join("enc_mnemonic.json");
    if !folder_enc.exists() || !master_path.exists() {
        return Ok(());
    }

    let master = hcfs_client::auth::recover_mnemonic(master_path, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    let mut master_str = master.to_string();

    let folder = hcfs_client::auth::recover_mnemonic(&folder_enc, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
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
        info!("Folder '{}' uses wrong derived mnemonic (old master?) — re-deriving", label);
    }
    folder_str.zeroize();
    master_str.zeroize();

    // Create the rekey marker BEFORE saving the new mnemonic. If the
    // process crashes after the mnemonic is saved but before the marker
    // is written, the next startup would see folder == expected and
    // skip — leaving stale remote files encrypted with the old key.
    let marker = folder_dir.join(".needs_rekey");
    std::fs::File::create(&marker)?;

    hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, &expected, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    expected.zeroize();

    // Wipe sync state so files get re-uploaded with the new key
    let state_path = folder_dir.join("sync_state.json");
    let state_bak = folder_dir.join("sync_state.json.bak");
    let _ = std::fs::remove_file(&state_path);
    let _ = std::fs::remove_file(&state_bak);

    info!("Re-derived mnemonic for '{}', wiped sync state (remote files preserved)", label);

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
fn run_migration(sync_path: &str, account_dir: &Path, folder_dir: &Path, master_path: &Path) -> Result<(), crate::error::AppError> {
    // If folder_dir already has an enc_mnemonic.json, migration is complete
    if folder_dir.join("enc_mnemonic.json").exists() {
        return Ok(());
    }

    let legacy_a_dir = PathBuf::from(sync_path).join(".hippius");
    let legacy_b_enc = account_dir.join("enc_mnemonic.json");

    // --- Legacy A: <sync_folder>/.hippius/ ---
    if legacy_a_dir.exists() && legacy_a_dir.join("enc_mnemonic.json").exists() {
        info!("Legacy A detected: {:?} → {:?}", legacy_a_dir, folder_dir);

        std::fs::create_dir_all(folder_dir)?;

        // Copy all files into folder_dir
        copy_dir_contents(&legacy_a_dir, folder_dir)?;

        // Verify critical file
        if !folder_dir.join("enc_mnemonic.json").exists() {
            return Err(crate::error::AppError::Other(
                "Migration A verification failed: enc_mnemonic.json not in folder dir".into(),
            ));
        }

        // This mnemonic is the master — save it at account level if not already there
        if !master_path.exists() {
            std::fs::create_dir_all(account_dir)?;
            std::fs::copy(folder_dir.join("enc_mnemonic.json"), master_path)?;
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
            std::fs::copy(&legacy_b_enc, master_path)?;
            info!("Saved master mnemonic from Legacy B");
        }

        std::fs::create_dir_all(folder_dir)?;

        // Move enc_mnemonic.json, sync_state.json*, temp/ into folder_dir
        for name in &["enc_mnemonic.json", "sync_state.json", "sync_state.json.bak"] {
            let src = account_dir.join(name);
            if src.exists() {
                let dst = folder_dir.join(name);
                std::fs::copy(&src, &dst)?;
                debug!("Copied {} to folder dir", name);
            }
        }

        let temp_src = account_dir.join("temp");
        if temp_src.is_dir() {
            let temp_dst = folder_dir.join("temp");
            copy_dir_recursive(&temp_src, &temp_dst)?;
            debug!("Copied temp/ to folder dir");
        }

        // Verify critical file
        if !folder_dir.join("enc_mnemonic.json").exists() {
            return Err(crate::error::AppError::Other(
                "Migration B verification failed: enc_mnemonic.json not in folder dir".into(),
            ));
        }

        // Clean up originals from account_dir (not master_enc_mnemonic.json)
        for name in &["enc_mnemonic.json", "sync_state.json", "sync_state.json.bak"] {
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
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), crate::error::AppError> {
    let entries = std::fs::read_dir(src).map_err(|e| crate::error::AppError::Other(format!("Failed to read dir {}: {e}", src.display())))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };

        if path.is_file() {
            std::fs::copy(&path, dst.join(&name))?;
        } else if path.is_dir() {
            copy_dir_recursive(&path, &dst.join(&name))?;
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

/// Construct an `HcfsClientConfig` from the common connection parameters.
fn build_hcfs_config(server_url: &str, bearer_token: &str, account_id: &str, folder_hash: &str) -> HcfsClientConfig {
    HcfsClientConfig {
        base_url: server_url.to_string(),
        api_key: "Arion".to_string(),
        bearer_token: bearer_token.to_string(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: folder_hash.to_string(),
    }
}

/// Loaded sync configuration from the database for a single label.
struct SyncConfig {
    sync_path: String,
    drive_password: String,
    server_url: String,
}

/// Read the sync path, drive password, and server URL from the DB.
async fn load_sync_config(pool: &SqlitePool, account_id: &str, label: &str) -> Result<SyncConfig, crate::error::AppError> {
    let sync_path = get_sync_path_for_label(pool, account_id, label).await?;
    debug!("Sync path: {}, label: {}", sync_path, label);

    let drive_password = get_drive_password(pool, account_id).await?;
    let config = get_hcfs_config_internal(pool, account_id).await?;

    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };
    debug!("Server URL: {}", server_url);

    Ok(SyncConfig {
        sync_path,
        drive_password,
        server_url,
    })
}

/// Check if the sync directory was deleted by the user and handle cleanup.
///
/// If the config dir has sync state (was previously syncing) but the sync
/// folder is completely gone, the user intentionally removed it. Removes
/// the stale DB row and returns an error so `initialize_sync_inner` aborts.
async fn check_deleted_sync_dir(pool: &SqlitePool, account_id: &str, label: &str, sync_path: &str) -> Result<(), crate::error::AppError> {
    let sync_dir_existed = Path::new(sync_path).exists();
    let folder_dir = config_dir_for_folder(account_id, label)?;
    let had_sync_state = folder_dir.join("sync_state.json").exists();

    if !sync_dir_existed && had_sync_state {
        warn!(
            "Sync folder '{}' was deleted but config still exists for '{}'. \
             Removing stale sync path from DB to prevent remote file deletion.",
            sync_path, label
        );
        if let Err(e) = crate::commands::substrate_tx::remove_sync_path_internal(pool, account_id, label).await {
            warn!("Failed to remove stale sync path for '{}': {}", label, e);
        }
        let _ = std::fs::remove_file(folder_dir.join("sync_state.json"));
        let _ = std::fs::remove_file(folder_dir.join("sync_state.json.bak"));
        return Err(crate::error::AppError::Validation(format!(
            "Sync folder '{sync_path}' for '{label}' was removed. \
             It has been unregistered from sync. \
             Re-add it from Settings if this was unintentional."
        )));
    }
    Ok(())
}

/// Compute config directories, run legacy migration, and reconcile the
/// master mnemonic with the login mnemonic (if provided).
fn prepare_config_dir(
    account_id: &str,
    label: &str,
    sync_path: &str,
    drive_password: &str,
    existing_mnemonic: Option<&str>,
) -> Result<(PathBuf, PathBuf, PathBuf), crate::error::AppError> {
    let acct_dir = account_dir(account_id)?;
    let folder_dir = config_dir_for_folder(account_id, label)?;
    let master_path = master_mnemonic_path(account_id)?;
    run_migration(sync_path, &acct_dir, &folder_dir, &master_path)?;

    // If the login mnemonic is available, ensure the stored master matches.
    if let Some(imported) = existing_mnemonic
        && master_path.exists()
    {
        use zeroize::Zeroize;
        let stored = hcfs_client::auth::recover_mnemonic(&master_path, drive_password)?;
        let mut stored_str = stored.to_string();
        if stored_str != *imported {
            info!(
                "Stored master differs from login mnemonic — \
                 updating master before derivation check"
            );
            hcfs_client::auth::save_encrypted_mnemonic(&master_path, imported, drive_password)?;
        }
        stored_str.zeroize();
    }

    ensure_derived_mnemonic(&folder_dir, &master_path, drive_password, label)?;

    Ok((acct_dir, folder_dir, master_path))
}

/// Parameters for drive recovery that group connection and identity info.
struct RecoveryContext<'a> {
    sync_path: &'a str,
    folder_dir: &'a Path,
    master_path: &'a Path,
    server_url: &'a str,
    bearer_token: &'a str,
    account_id: &'a str,
    fhash: &'a str,
    label: &'a str,
    drive_password: &'a str,
    existing_mnemonic: Option<&'a str>,
}

/// Recover a drive after unlock failure: clean up corrupted config files,
/// create a fresh `HcfsDriveManager`, re-derive the mnemonic, and unlock.
///
/// Returns `(new_manager, user_id, optional_master_mnemonic)`.
fn recover_drive(manager: HcfsDriveManager, ctx: &RecoveryContext<'_>) -> Result<(HcfsDriveManager, String, Option<String>), crate::error::AppError> {
    // Remove corrupted enc_mnemonic.json
    let enc_path = ctx.folder_dir.join("enc_mnemonic.json");
    if enc_path.exists() {
        if let Err(rm_err) = std::fs::remove_file(&enc_path) {
            warn!("Failed to remove enc_mnemonic.json: {}", rm_err);
        } else {
            debug!("Removed enc_mnemonic.json");
        }
    }

    // Remove sync state and rekey marker to start fresh
    let _ = std::fs::remove_file(ctx.folder_dir.join("sync_state.json"));
    let _ = std::fs::remove_file(ctx.folder_dir.join("sync_state.json.bak"));
    let _ = std::fs::remove_file(ctx.folder_dir.join(".needs_rekey"));
    info!("Recovery cleanup complete. Retrying initialization...");

    drop(manager);
    let mut new_manager = HcfsDriveManager::new(PathBuf::from(ctx.sync_path), ctx.folder_dir.to_path_buf());
    new_manager.set_config(build_hcfs_config(ctx.server_url, ctx.bearer_token, ctx.account_id, ctx.fhash))?;

    debug!("Creating fresh drive after recovery...");

    let master_str = if let Some(imported) = ctx.existing_mnemonic {
        debug!("Using login mnemonic as master for recovery");
        imported.to_string()
    } else {
        let master = bip39::Mnemonic::generate(24).map_err(|e| crate::error::AppError::Crypto(e.to_string()))?;
        warn!("Generated new random master for recovery (no login mnemonic available)");
        master.to_string()
    };
    hcfs_client::auth::save_encrypted_mnemonic(ctx.master_path, &master_str, ctx.drive_password)?;
    let derived = derive_folder_mnemonic(&master_str, ctx.label)?;

    let mut init_mnemonic = new_manager.init(ctx.drive_password, Some(&derived))?;
    zeroize::Zeroize::zeroize(&mut init_mnemonic);

    let uid = new_manager.unlock(ctx.drive_password)?;
    info!("Drive re-initialized and unlocked, derived user_id: {}", uid);

    Ok((new_manager, uid, Some(master_str)))
}

/// Initialize a brand-new folder: resolve the mnemonic source (imported
/// login mnemonic, existing master on disk, or error), init the drive,
/// and unlock it.
///
/// Returns `(user_id, optional_master_for_backup, is_new_master)`.
fn init_new_drive(
    manager: &mut HcfsDriveManager,
    label: &str,
    master_path: &Path,
    drive_password: &str,
    existing_mnemonic: Option<&str>,
) -> Result<(String, Option<String>, bool), crate::error::AppError> {
    info!(
        "Drive not initialized for '{}', creating... (existing_mnemonic={}, master_exists={})",
        label,
        existing_mnemonic.is_some(),
        master_path.exists(),
    );

    let (folder_mnemonic, master_for_backup, generated_new) = if let Some(imported) = existing_mnemonic {
        use zeroize::Zeroize;
        if master_path.exists() {
            let stored =
                hcfs_client::auth::recover_mnemonic(master_path, drive_password).map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
            let mut stored_str = stored.to_string();
            if stored_str == *imported {
                debug!("Stored master matches login mnemonic");
            } else {
                info!("Stored master differs from login mnemonic — updating master");
                hcfs_client::auth::save_encrypted_mnemonic(master_path, imported, drive_password)?;
            }
            stored_str.zeroize();
        } else {
            hcfs_client::auth::save_encrypted_mnemonic(master_path, imported, drive_password)?;
            info!("Saved login mnemonic as master (new device)");
        }
        let derived = derive_folder_mnemonic(imported, label)?;
        (derived, None, false)
    } else if master_path.exists() {
        let master =
            hcfs_client::auth::recover_mnemonic(master_path, drive_password).map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
        let mut master_str = master.to_string();
        let derived = derive_folder_mnemonic(&master_str, label)?;
        zeroize::Zeroize::zeroize(&mut master_str);
        debug!("Derived folder mnemonic from existing master");
        (derived, None, false)
    } else {
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::NoEncryptionKey));
    };

    let mut init_mnemonic = manager.init(drive_password, Some(&folder_mnemonic))?;
    zeroize::Zeroize::zeroize(&mut init_mnemonic);
    drop(init_mnemonic);
    let mut folder_mnemonic = folder_mnemonic;
    zeroize::Zeroize::zeroize(&mut folder_mnemonic);

    let uid = manager.unlock(drive_password)?;
    info!("Drive initialized and unlocked for '{}', derived user_id: {}", label, uid);

    Ok((uid, master_for_backup, generated_new))
}

/// Fire-and-log a health check against the HCFS server.
async fn check_init_server_health(server_url: &str) {
    let test_url = format!("{server_url}/health");
    debug!("Testing connectivity to: {}", test_url);
    let test_result = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map(|c| c.get(&test_url).header("X-API-Key", "Arion").send());
    let resp = match test_result {
        Ok(fut) => fut.await,
        Err(e) => {
            warn!("Failed to build test client: {e}");
            return;
        }
    };
    match resp {
        Ok(r) => debug!("Health check OK: status={}", r.status()),
        Err(e) => {
            let mut msg = format!("{e}");
            let mut source: Option<&dyn std::error::Error> = e.source();
            while let Some(cause) = source {
                use std::fmt::Write;
                let _ = write!(msg, "\n  caused by: {cause}");
                source = cause.source();
            }
            warn!("Health check failed: {}", msg);
        }
    }
}

/// Spawn a background task to register the folder with the server for
/// cross-device discovery.
fn spawn_folder_registration(server_url: &str, bearer_token: &str, label: &str, account_id: &str, fhash: &str, pool: &SqlitePool) {
    let config = build_hcfs_config(server_url, bearer_token, account_id, fhash);
    let reg_label = label.to_string();
    let reg_ss58 = account_id.to_string();
    let reg_fhash = fhash.to_string();
    let reg_pool = pool.clone();
    tokio::spawn(async move {
        match hcfs_client::client::HcfsClient::new(config) {
            Ok(client) => {
                let dev_name = get_device_name_internal(&reg_pool).await.ok();
                if let Err(e) = client.register_folder(&reg_ss58, &reg_fhash, &reg_label, dev_name.as_deref()).await {
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
) -> Result<InitSyncResult, crate::error::AppError> {
    initialize_sync_inner(app, account_id, label, existing_mnemonic, true).await
}

/// Stop the existing drive with the given label, discard its pending activity
/// and progress session files, and emit a snapshot.
async fn teardown_previous_drive(sync: &crate::sync_engine::SyncEngine, label: &str) {
    {
        let mut drives_guard = sync.drives.lock().await;
        if let Some(old_slot) = drives_guard.remove(label) {
            old_slot.cancel_token.cancel();
            debug!("Dropped previous drive instance for label '{}'", label);
        }
        sync.discard_pending_activity_for_label(label);
        sync.remove_state(label);
    }
    {
        let mut state = sync.progress.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(session) = state.current_session.as_mut() {
            let before = session.files.len();
            session.files.retain(|_path, file| file.label != *label);
            let removed = before - session.files.len();
            if removed > 0 {
                info!(label = %label, removed, "Removed stale files for re-initializing label");
            }
        }
    }
    sync.emit_snapshot(true);
}

/// Pre-populate the synced-paths cache and store the manager in the drive
/// registry so the first sync cycle sees correct state immediately.
async fn register_drive(sync: &crate::sync_engine::SyncEngine, manager: HcfsDriveManager, label: &str, sync_path: &str, folder_dir: &Path) {
    // Consume rekey marker (no remote purge)
    let marker = folder_dir.join(".needs_rekey");
    if marker.exists() {
        info!("Rekey marker found for '{}' — consuming without remote purge", label);
        let _ = std::fs::remove_file(&marker);
    }

    // Pre-populate synced-paths cache
    if let Ok(state) = manager.load_sync_state() {
        let paths = crate::sync_shared::build_synced_paths_from_state(&state);
        if !paths.is_empty() {
            info!(
                label = %label,
                synced_count = paths.len(),
                "Pre-populated synced-paths cache at drive registration",
            );
        }
        sync.update_synced_paths_cache(label, paths);
    }

    sync.register_label_root(label.to_string(), PathBuf::from(sync_path));
    let mut guard = sync.drives.lock().await;
    guard.insert(
        label.to_string(),
        DriveSlot {
            manager: std::sync::Arc::new(TokioMutex::new(manager)),
            cancel_token: CancellationToken::new(),
        },
    );
}

/// Core init logic. When `start_loop` is false the caller is responsible for
/// starting the sync loop after all drives have been registered (batch restore).
async fn initialize_sync_inner(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    existing_mnemonic: Option<String>,
    start_loop: bool,
) -> Result<InitSyncResult, crate::error::AppError> {
    use tauri::Manager;
    let label = sanitize_label(&label)?;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;
    let pool_owned = app_state.pool()?.clone();
    let pool = &pool_owned;
    info!("initialize_sync called for account: {}, label: '{}'", account_id, label);

    teardown_previous_drive(sync, &label).await;

    // Load config, validate sync dir, prepare config dir
    let cfg = load_sync_config(pool, &account_id, &label).await?;
    crate::commands::file_commands::allow_asset_directory(&app, &cfg.sync_path);
    check_deleted_sync_dir(pool, &account_id, &label, &cfg.sync_path).await?;
    std::fs::create_dir_all(&cfg.sync_path)?;

    let (_acct_dir, folder_dir, master_path) =
        prepare_config_dir(&account_id, &label, &cfg.sync_path, &cfg.drive_password, existing_mnemonic.as_deref())?;

    // Create drive and set HCFS config
    let mut manager = HcfsDriveManager::new(PathBuf::from(&cfg.sync_path), folder_dir.clone());
    let bearer_token = get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;
    let fhash = folder_hash(&label);
    manager.set_config(build_hcfs_config(&cfg.server_url, &bearer_token, &account_id, &fhash))?;

    // Init or unlock
    let (user_id, mnemonic, is_new_setup) = if manager.is_initialized() {
        debug!("Drive already initialized for '{}', unlocking...", label);
        match manager.unlock(&cfg.drive_password) {
            Ok(uid) => {
                info!("Drive unlocked, user_id: {}", uid);
                (uid, None, false)
            }
            Err(e) => {
                error!("Unlock failed for '{}': {}", label, e);
                info!("Attempting recovery: cleaning up encrypted files...");
                let ctx = RecoveryContext {
                    sync_path: &cfg.sync_path,
                    folder_dir: &folder_dir,
                    master_path: &master_path,
                    server_url: &cfg.server_url,
                    bearer_token: &bearer_token,
                    account_id: &account_id,
                    fhash: &fhash,
                    label: &label,
                    drive_password: &cfg.drive_password,
                    existing_mnemonic: existing_mnemonic.as_deref(),
                };
                let (new_mgr, uid, master) = recover_drive(manager, &ctx)?;
                manager = new_mgr;
                (uid, master, true)
            }
        }
    } else {
        init_new_drive(&mut manager, &label, &master_path, &cfg.drive_password, existing_mnemonic.as_deref())?
    };

    // Validate user_id
    let expected_user_id = format!("{account_id}_{fhash}");
    if user_id != expected_user_id {
        return Err(crate::error::AppError::Validation(format!(
            "Drive user_id mismatch: got '{user_id}', expected '{expected_user_id}'. \
             This indicates a corrupted config directory. \
             Please remove the folder and re-add it."
        )));
    }

    check_init_server_health(&cfg.server_url).await;
    setup_progress_handlers(&app, &mut manager, &label, sync);
    sync.clear_cancel();
    register_drive(sync, manager, &label, &cfg.sync_path, &folder_dir).await;

    if start_loop {
        start_sync_loop(app.clone()).await;
    }
    info!(
        "Sync initialized successfully for '{}'. User ID: {}, New setup: {}",
        label, user_id, is_new_setup
    );
    spawn_folder_registration(&cfg.server_url, &bearer_token, &label, &account_id, &fhash, pool);

    Ok(InitSyncResult {
        user_id,
        mnemonic,
        is_new_setup,
    })
}

/// Stop ALL drives (used on logout).
#[tauri::command]
pub async fn stop_sync(app: AppHandle) -> Result<(), crate::error::AppError> {
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
    sync.clear_all_reviews();
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
pub async fn stop_drive(app: AppHandle, label: String) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let (remaining, removed_path) = {
        let mut guard = sync.drives.lock().await;
        let path = guard
            .get(&label)
            .and_then(|slot| slot.manager.try_lock().ok().map(|m| m.sync_path().to_path_buf()));
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
        if let (Ok(pool), Ok(acct)) = (app_state.pool(), crate::utils::sync::current_account_id(&app_state))
            && let Err(e) = crate::commands::substrate_tx::remove_sync_path_internal(pool, &acct, &label).await
        {
            warn!("Failed to remove sync path for '{}' from DB: {e}", label);
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
        sync.clear_all_reviews();
        let _ = app.emit(sync_events::SYNC_STOPPED, ());
    }

    info!("Stopped drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Pause a sync folder: stop the drive in-memory and mark it as paused in the DB.
/// Unlike `stop_drive`, the DB row is preserved so the folder reappears on restart
/// (but won't auto-sync until resumed).
#[tauri::command]
pub async fn pause_drive(app: AppHandle, label: String) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Stop the drive in-memory (cancel, remove from map, unwatch)
    let (remaining, removed_path) = {
        let mut guard = sync.drives.lock().await;
        let path = guard
            .get(&label)
            .and_then(|slot| slot.manager.try_lock().ok().map(|m| m.sync_path().to_path_buf()));
        if let Some(slot) = guard.remove(&label) {
            slot.cancel_token.cancel();
        }
        (guard.len(), path)
    };
    sync.unregister_label_root(&label);

    if let Some(path) = &removed_path {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(w) = watcher_guard.as_mut() {
            let _ = w.unwatch(path);
        }
    }

    sync.remove_state(&label);
    sync.discard_pending_activity_for_label(&label);
    let _ = crate::sync_progress::remove_files_for_label(sync, label.clone());

    // Mark as paused in DB (keep the row, unlike stop_drive which deletes it)
    if let (Ok(pool), Ok(acct)) = (app_state.pool(), crate::utils::sync::current_account_id(&app_state))
        && let Err(e) = crate::commands::substrate_tx::set_sync_path_paused(pool, &acct, &label, true).await
    {
        warn!("Failed to mark '{}' as paused in DB: {e}", label);
    }

    if remaining == 0 {
        sync.request_cancel();
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
        {
            let mut watcher_guard = sync.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            *watcher_guard = None;
        }
        sync.clear_all_reviews();
        let _ = app.emit(sync_events::SYNC_STOPPED, ());
    }

    info!("Paused drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Resume a paused sync folder: clear the paused flag and re-initialize.
#[tauri::command]
pub async fn resume_drive(app: AppHandle, label: String, mnemonic: Option<String>) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    let account_id = crate::utils::sync::current_account_id(&app_state)?;
    let pool = app_state.pool()?;

    // Clear the paused flag first
    crate::commands::substrate_tx::set_sync_path_paused(pool, &account_id, &label, false).await?;

    // Re-initialize the drive
    initialize_sync_inner(app.clone(), account_id, label.clone(), mnemonic, true).await?;

    info!("Resumed drive '{}'", label);
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
) -> Result<(), crate::error::AppError> {
    info!("Resetting sync data for account: {}", account_id);

    // First stop all active syncs
    stop_sync(app.clone()).await?;

    // Get the account directory
    let acct_dir = account_dir(&account_id)?;

    debug!("Reset: Deleting account directory: {:?}", acct_dir);

    // Delete the entire account directory (contains sync state, encrypted mnemonic, etc.)
    if acct_dir.exists() {
        std::fs::remove_dir_all(&acct_dir)?;
        debug!("Reset: Deleted account directory");
    }

    // Also clear the hcfs_config from database so user goes through setup again
    let db = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM hcfs_config WHERE owner = ?").bind(&owner).execute(db).await?;

    debug!("Reset: Cleared database config");

    // Emit event so frontend knows to show setup UI
    let _ = app.emit(
        sync_events::SYNC_RESET,
        sync_events::SyncResetPayload {
            account_id: account_id.clone(),
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
pub fn is_drive_active(state: tauri::State<'_, crate::app_state::AppState>, label: Option<String>) -> bool {
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
pub async fn trigger_sync_now(app: AppHandle) -> Result<(), crate::error::AppError> {
    crate::hcfs_drive::trigger_sync(&app).await;
    Ok(())
}

/// Direction of a file transfer for progress callbacks.
enum TransferDirection {
    Upload,
    Download,
}

/// Shared state for a transfer progress callback.
struct TransferContext {
    sync: Arc<crate::sync_engine::SyncEngine>,
    app: AppHandle,
    label: String,
    started_set: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    direction: TransferDirection,
}

/// Handle per-chunk transfer progress: log first event, track in UI, emit
/// Tauri event, and record completion activity. Shared between upload and
/// download callbacks to avoid code duplication.
fn handle_transfer_progress(ctx: &TransferContext, bytes: u64, total: u64, path: Option<&str>) {
    ctx.sync.touch_progress_time();
    let (dir_name, event_name, file_action) = match ctx.direction {
        TransferDirection::Upload => ("Upload", sync_events::UPLOAD_PROGRESS, crate::sync_progress::FileAction::Upload),
        TransferDirection::Download => ("Download", sync_events::DOWNLOAD_PROGRESS, crate::sync_progress::FileAction::Download),
    };

    if let Some(path_str) = path {
        let file_name = Path::new(path_str)
            .file_name()
            .map_or_else(|| path_str.to_string(), |f| f.to_string_lossy().to_string());
        if let Ok(mut set) = ctx.started_set.lock()
            && set.insert(path_str.to_string())
        {
            if bytes > 0 {
                info!(
                    "{} resuming [{}]: {} from {} bytes ({} total)",
                    dir_name, ctx.label, file_name, bytes, total
                );
            } else {
                info!("{} started [{}]: {} ({} bytes)", dir_name, ctx.label, file_name, total);
            }
        }
        let _ = crate::sync_progress::update_file_progress(&ctx.sync, path_str.to_string(), bytes, total, file_action, Some(ctx.label.clone()));
    }
    debug!("{} [{}]: {}/{} bytes, path: {:?}", dir_name, ctx.label, bytes, total, path);
    let _ = ctx.app.emit(
        event_name,
        sync_events::TransferProgressPayload {
            label: ctx.label.clone(),
            bytes,
            total,
            path: path.map(String::from),
        },
    );

    if bytes == total
        && total > 0
        && let Some(path_str) = path
    {
        let display_name = Path::new(path_str)
            .file_name()
            .map_or_else(|| path_str.to_string(), |f| f.to_string_lossy().to_string());
        let action_str = match ctx.direction {
            TransferDirection::Upload => "uploaded",
            TransferDirection::Download => "downloaded",
        };
        info!("{} complete [{}]: {} ({} bytes)", dir_name, ctx.label, display_name, total);
        ctx.sync.add_pending_activity(SyncActivityItem {
            file_name: path_str.to_string(),
            action: action_str.to_string(),
            timestamp: chrono::Utc::now().timestamp(),
            size_bytes: total,
            label: ctx.label.clone(),
        });
    }
}

/// Build the `on_sync_plan_ready` callback that merges the sync plan into the
/// progress session and emits the `SYNC_PLAN_READY` event.
fn build_plan_ready_callback(app: &AppHandle, label: &str, sync: &Arc<crate::sync_engine::SyncEngine>) -> hcfs_client::sync::SyncPlanReadyFn {
    let app = app.clone();
    let label = label.to_string();
    let sync = sync.clone();
    Arc::new(move |uploads, downloads, local_deletes, remote_deletes, renames| {
        sync.touch_progress_time();
        let total = uploads.len() + downloads.len() + local_deletes.len() + remote_deletes.len() + renames.len();
        if total == 0 {
            return;
        }
        info!(
            "Sync plan ready [{}]: {} uploads, {} downloads, {} local_deletes, {} remote_deletes, {} renames",
            label,
            uploads.len(),
            downloads.len(),
            local_deletes.len(),
            remote_deletes.len(),
            renames.len()
        );

        let upload_paths: Vec<String> = uploads.iter().map(|f| f.path.clone()).collect();
        let download_paths: Vec<String> = downloads.iter().map(|f| f.path.clone()).collect();
        let local_delete_paths: Vec<String> = local_deletes.iter().map(|f| f.path.clone()).collect();
        let remote_delete_paths: Vec<String> = remote_deletes.iter().map(|f| f.path.clone()).collect();

        let size_map: std::collections::HashMap<String, u64> = uploads
            .iter()
            .chain(downloads.iter())
            .chain(local_deletes.iter())
            .chain(remote_deletes.iter())
            .filter(|f| f.size_bytes > 0)
            .map(|f| (f.path.clone(), f.size_bytes))
            .collect();

        let file_list = crate::sync_progress::SessionFileList {
            upload_files: Some(upload_paths.clone()),
            download_files: Some(download_paths.clone()),
            local_delete_files: Some(local_delete_paths.clone()),
            remote_delete_files: Some(remote_delete_paths.clone()),
        };
        let _ = crate::sync_progress::merge_into_session(
            &sync,
            uploads.len() as u32,
            downloads.len() as u32,
            local_deletes.len() as u32,
            remote_deletes.len() as u32,
            Some(file_list),
            Some(label.clone()),
        );

        if !size_map.is_empty() {
            let mut progress_state = sync.progress.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(session) = progress_state.current_session.as_mut() {
                let mut patched = 0usize;
                for (path, size) in &size_map {
                    if let Some(file) = session.files.get_mut(path)
                        && file.total_bytes == 0
                    {
                        file.total_bytes = *size;
                        patched += 1;
                    }
                }
                if patched > 0 {
                    info!(patched, total, label = %label, "Patched file sizes from sync plan");
                }
            }
            drop(progress_state);
            sync.emit_snapshot(true);
        }

        let _ = app.emit(
            sync_events::SYNC_PLAN_READY,
            sync_events::SyncPlanReadyPayload {
                label: label.clone(),
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
    })
}

fn setup_progress_handlers(app: &AppHandle, manager: &mut HcfsDriveManager, label: &str, sync: &Arc<crate::sync_engine::SyncEngine>) {
    let upload_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    let download_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

    // Upload callback
    let upload_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: label.to_string(),
        started_set: Arc::clone(&upload_started),
        direction: TransferDirection::Upload,
    });
    let app_migration = app.clone();
    let label_migration = label.to_string();

    // Download callback
    let download_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: label.to_string(),
        started_set: Arc::clone(&download_started),
        direction: TransferDirection::Download,
    });

    // Encrypt/decrypt callbacks
    let sync_encrypt = sync.clone();
    let l3 = label.to_string();
    let sync_decrypt = sync.clone();
    let l4 = label.to_string();

    // Scan/fetch/synced callbacks
    let sync_scan = sync.clone();
    let a5 = app.clone();
    let l5 = label.to_string();
    let sync_fetch = sync.clone();
    let a6 = app.clone();
    let l6 = label.to_string();
    let sync_file_synced = sync.clone();
    let l7 = label.to_string();

    manager.set_progress(SyncProgress {
        on_sync_plan_ready: Some(build_plan_ready_callback(app, label, sync)),
        on_upload_progress: Some(Arc::new(move |b, t, p| {
            handle_transfer_progress(&upload_ctx, b, t, p);
            if b == t
                && t > 0
                && let Some(path_str) = p
                && label_migration == "migration"
            {
                crate::commands::migration::record_migration_upload(&app_migration, path_str.to_string());
            }
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            handle_transfer_progress(&download_ctx, b, t, p);
        })),
        on_encrypt_progress: Some(Arc::new(move |b, t, p| {
            sync_encrypt.touch_progress_time();
            if b == 0 {
                info!("Encrypt starting [{}]: {:?} ({} bytes)", l3, p, t);
            } else if b == t && t > 0 {
                info!("Encrypt complete [{}]: {:?} ({} bytes)", l3, p, t);
            }
            if let Some(path_str) = p {
                let _ = crate::sync_progress::update_file_progress(
                    &sync_encrypt,
                    path_str.to_string(),
                    b,
                    t,
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
            if let Some(path_str) = p {
                let _ = crate::sync_progress::update_file_progress(
                    &sync_decrypt,
                    path_str.to_string(),
                    b,
                    t,
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
                sync_events::ScanProgressPayload {
                    label: l5.clone(),
                    scanned: n,
                    path: p.map(std::string::ToString::to_string),
                },
            );
        })),
        on_fetch_state_progress: Some(Arc::new(move |f, t| {
            sync_fetch.touch_progress_time();
            info!("Fetch state [{}]: {}/{} entries", l6, f, t);
            let _ = a6.emit(
                sync_events::FETCH_PROGRESS,
                sync_events::FetchProgressPayload {
                    label: l6.clone(),
                    fetched: f,
                    total: t,
                },
            );
        })),
        on_file_synced: Some(Arc::new(move |rel_path: &str, path_hash_hex: &str, arion_cid: &str, action: &str| {
            debug!("File synced [{}]: {} ({}) cid={}", l7, rel_path, action, arion_cid);
            if !rel_path.is_empty() {
                let info = crate::sync_shared::SyncedFileInfo::new(path_hash_hex.to_string(), arion_cid.to_string());
                sync_file_synced.upsert_synced_path(&l7, rel_path.to_string(), info);
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
pub async fn get_mnemonic_for_account(app_state: &crate::app_state::AppState, account_id: &str) -> Result<String, crate::error::AppError> {
    let pool = app_state.pool()?;
    let drive_password = get_drive_password(pool, account_id).await?;

    // Prefer the master mnemonic at account level
    let master_path = master_mnemonic_path(account_id)?;
    if master_path.exists() {
        let mnemonic = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)?;
        return Ok(mnemonic.to_string());
    }

    // Fallback: try the first active drive's folder mnemonic (pre-migration state).
    warn!("Master mnemonic not found at {:?}, falling back to per-folder mnemonic", master_path);
    let first_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.values().next().map(|slot| slot.manager.clone())
    };
    if let Some(arc) = first_arc {
        let m = arc.lock().await;
        if m.is_initialized() {
            Ok(m.export_mnemonic(&drive_password)?)
        } else {
            Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized))
        }
    } else {
        // No active drive — try reading DB for any sync path
        let owner = account_key(account_id);
        let result: Option<(String, String)> = sqlx::query_as("SELECT path, label FROM sync_paths WHERE owner = ? LIMIT 1")
            .bind(&owner)
            .fetch_optional(pool)
            .await?;

        if let Some((path, lbl)) = result {
            let folder_dir = config_dir_for_folder(account_id, &lbl)?;
            let manager = HcfsDriveManager::new(PathBuf::from(&path), folder_dir);
            if manager.is_initialized() {
                Ok(manager.export_mnemonic(&drive_password)?)
            } else {
                Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized))
            }
        } else {
            Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::SyncSetup))
        }
    }
}

/// Tauri command wrapper: return the master BIP-39 mnemonic by decrypting it
/// from disk.
#[tauri::command]
pub async fn get_drive_mnemonic(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<String, crate::error::AppError> {
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
) -> Result<(), crate::error::AppError> {
    let pool = state.pool()?;
    let master_path = master_mnemonic_path(&account_id)?;

    let Ok(drive_password) = get_drive_password(pool, &account_id).await else {
        // HCFS config not set up yet — nothing we can do.
        // The master will be saved when initialize_sync runs.
        return Ok(());
    };

    if master_path.exists() {
        // Compare stored master with the login mnemonic. A mismatch means
        // the master was generated randomly (e.g. app restart lost the
        // in-memory mnemonic). Update it so initialize_sync's step 4b and
        // ensure_derived_mnemonic can detect and fix folder key mismatches.
        use zeroize::Zeroize;
        let stored = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)?;
        let mut stored_str = stored.to_string();
        if stored_str == mnemonic {
            stored_str.zeroize();
            return Ok(());
        }
        stored_str.zeroize();
        info!("Stored master differs from login mnemonic — updating early");
    }

    let acct_dir = account_dir(&account_id)?;
    std::fs::create_dir_all(&acct_dir)?;

    hcfs_client::auth::save_encrypted_mnemonic(&master_path, &mnemonic, &drive_password)?;

    info!("Eagerly persisted master mnemonic for account {}", &account_id[..8.min(account_id.len())]);
    Ok(())
}

/// Stage changes and return a preview of what will sync.
/// Pauses auto-sync while the user reviews.
#[tauri::command]
pub async fn stage_changes(app: tauri::AppHandle) -> Result<StagedChanges, crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // For V1, stage the first available drive
    let (label, first_arc) = {
        let guard = sync.drives.lock().await;
        match guard.iter().next() {
            Some((k, slot)) => (k.clone(), slot.manager.clone()),
            None => return Err(crate::error::AppError::Other("Drive not initialized".into())),
        }
    };

    // RAII guard: sets review_mode for this drive, resets on drop unless commit()ed.
    let review_guard = ReviewModeGuard::new(sync.clone(), label);

    let m = first_arc.try_lock().map_err(|_| "Sync is in progress, please wait".to_string())?;

    if !m.is_unlocked() {
        return Err(crate::error::AppError::Other("Drive is not unlocked".into()));
    }

    let changes = m.stage_with_paths().await?;
    review_guard.commit();
    Ok(changes)
}

/// Sync with user-provided conflict resolutions, then resume auto-sync.
/// `resolutions` maps hex-encoded FileId → resolution string
/// (one of: "keep_local", "accept_remote", "keep_both", "skip").
#[tauri::command]
pub async fn sync_with_conflict_resolutions(app: AppHandle, resolutions: HashMap<String, String>) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Validate resolution values before proceeding
    for (file_id, resolution) in &resolutions {
        if !matches!(resolution.as_str(), "keep_local" | "accept_remote" | "keep_both" | "skip") {
            return Err(crate::error::AppError::Other(format!(
                "Invalid resolution '{resolution}' for file {file_id}"
            )));
        }
    }

    // For V1, use the first drive's label
    let label: String = {
        let guard = sync.drives.lock().await;
        guard.keys().next().cloned().unwrap_or_else(|| "default".to_string())
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

    // Resume auto-sync for this drive
    sync.clear_drive_review(&label);

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
                sync_events::SyncErrorPayload {
                    label: label.clone(),
                    error: e.clone(),
                    retry_in_secs: 0,
                    consecutive_failures: 0,
                },
            );
            Err(crate::error::AppError::from(e))
        }
        None => {
            let msg = "Drive not initialized or not unlocked";
            let _ = app.emit(
                sync_events::SYNC_ERROR,
                sync_events::SyncErrorPayload {
                    label: label.clone(),
                    error: msg.to_string(),
                    retry_in_secs: 0,
                    consecutive_failures: 0,
                },
            );
            Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::DriveNotUnlocked))
        }
    }
}

/// Cancel the review dialog and resume auto-sync without syncing.
#[tauri::command]
pub async fn cancel_review(app: tauri::AppHandle) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    sync.clear_all_reviews();
    info!("Review cancelled, auto-sync resumed");
    Ok(())
}

/// Create a password-protected zip file containing the plaintext mnemonic.
/// Uses AES-256 encryption on the zip entry.
#[tauri::command]
pub async fn create_encrypted_backup(mut mnemonic: String, mut password: String, output_path: String) -> Result<(), crate::error::AppError> {
    let result = (|| -> Result<(), crate::error::AppError> {
        let buf = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(buf);

        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .with_aes_encryption(zip::AesMode::Aes256, &password);

        zip.start_file("recovery-phrase.txt", options)
            .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
        zip.write_all(mnemonic.as_bytes())?;

        let cursor = zip.finish().map_err(|e| crate::error::AppError::Other(e.to_string()))?;
        std::fs::write(&output_path, cursor.into_inner())?;

        Ok(())
    })();

    // Clear sensitive data from memory before dropping.
    zeroize::Zeroize::zeroize(&mut mnemonic);
    zeroize::Zeroize::zeroize(&mut password);

    result
}

// =============================================================================
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
) -> Result<Vec<RemoteFolderInfoResult>, crate::error::AppError> {
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
        api_key: "Arion".to_string(),
        bearer_token,
        accept_invalid_certs: true,
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

fn sanitize_label(label: &str) -> Result<String, crate::error::AppError> {
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

/// Restore a single remote folder: create directory, set DB path, wipe stale
/// state, and initialize sync (without starting the loop).
async fn restore_single_folder(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    account_id: &str,
    base_path: &str,
    label: &str,
    existing_mnemonic: Option<&str>,
) -> Result<(), crate::error::AppError> {
    let safe_label = sanitize_label(label)?;
    let folder_path = PathBuf::from(base_path).join(&safe_label);

    std::fs::create_dir_all(&folder_path)?;

    let path_str = folder_path.to_string_lossy().to_string();

    crate::commands::substrate_tx::set_sync_path_internal(pool, account_id, &path_str, false, Some(label)).await?;

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
) -> Result<Vec<RestoreResult>, crate::error::AppError> {
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
        match restore_single_folder(&app, pool, &account_id, &base_path, &folder.label, existing_mnemonic.as_deref()).await {
            Ok(()) => {
                any_success = true;
                results.push(RestoreResult {
                    label: folder.label.clone(),
                    success: true,
                    error: None,
                });
            }
            Err(e) => {
                error!("Failed to restore remote folder '{}': {e}", folder.label);
                if let Err(rollback_err) = crate::commands::substrate_tx::remove_sync_path_internal(pool, &account_id, &folder.label).await {
                    warn!("Failed to rollback sync path for '{}': {rollback_err}", folder.label);
                }
                results.push(RestoreResult {
                    label: folder.label.clone(),
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
) -> Result<DeleteRemoteFolderResult, crate::error::AppError> {
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

    let client_config = HcfsClientConfig {
        base_url: server_url,
        api_key: "Arion".to_string(),
        bearer_token,
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: account_id.clone(),
        folder_hash: fhash.clone(),
    };

    let client = hcfs_client::client::HcfsClient::new(client_config).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    let result = client
        .unregister_folder(&account_id, &fhash)
        .await
        .map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    // If this folder is also synced locally, stop the drive and remove the path
    let was_local = {
        let guard = state.sync.drives.lock().await;
        guard.contains_key(&label)
    }; // map lock released

    if was_local {
        if let Err(e) = stop_drive(app, label.clone()).await {
            warn!("Failed to stop drive '{}' during remote folder deletion: {e}", label);
        }
        if let Err(e) = crate::commands::substrate_tx::remove_sync_path_internal(pool, &account_id, &label).await {
            warn!("Failed to remove sync path '{}' during remote folder deletion: {e}", label);
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
async fn get_device_name_internal(pool: &SqlitePool) -> Result<String, crate::error::AppError> {
    let row = sqlx::query_scalar::<_, String>("SELECT device_name FROM device_settings WHERE id = 1")
        .fetch_optional(pool)
        .await?;
    Ok(row.unwrap_or_else(|| "My Device".to_string()))
}

/// Get the friendly device name for this machine.
#[tauri::command]
pub async fn get_device_name(state: tauri::State<'_, crate::app_state::AppState>) -> Result<String, crate::error::AppError> {
    get_device_name_internal(state.pool()?).await
}

/// Set a custom friendly device name for this machine.
#[tauri::command]
pub async fn set_device_name(state: tauri::State<'_, crate::app_state::AppState>, name: String) -> Result<(), crate::error::AppError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::Other("Device name cannot be empty".into()));
    }
    let pool = state.pool()?;
    sqlx::query(
        "INSERT INTO device_settings (id, device_name, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET device_name = excluded.device_name, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(&name)
    .execute(pool)
    .await?;
    info!("Device name updated: {}", name);
    Ok(())
}
