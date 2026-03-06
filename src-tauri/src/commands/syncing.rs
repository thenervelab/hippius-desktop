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

use crate::DB_POOL;
use crate::hcfs_drive::{
    HCFS_DRIVES, HcfsDriveManager, SYNC_IN_PROGRESS, SYNC_LOOP_HANDLE, SYNC_REVIEW_MODE,
    StagedChanges, start_sync_loop,
};
use crate::sync_shared::{
    SyncActivityItem, add_pending_activity, clear_cancel, discard_all_pending_activity,
    discard_pending_activity_for_label, remove_state, request_cancel, reset_all_states,
    update_state,
};
use crate::utils::account_key::account_key;
use crate::utils::objectstore_tokens::get_temp_auth_key;
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::sync::SyncProgress;
use sha2::{Digest, Sha256};
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
    account_id: String,
    server_url: String,
    drive_password: String,
) -> Result<(), String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;
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
pub async fn update_hcfs_server_url(account_id: String, server_url: String) -> Result<(), String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;
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

/// Update the bearer token on all live drives and persist it in the DB.
///
/// Called by the frontend after re-authenticating when the server returns
/// 401 Unauthorized (expired token).
#[tauri::command]
pub async fn update_sync_bearer_token(
    account_id: String,
    bearer_token: String,
) -> Result<(), String> {
    // 1. Persist to DB so future initialize_sync calls use the fresh token
    crate::utils::objectstore_tokens::save_temp_auth_key(&account_id, &bearer_token)
        .await
        .map_err(|e| format!("Failed to persist auth token: {e}"))?;

    // 2. Update all live drives in-memory
    let mut guard = HCFS_DRIVES.lock().await;
    for (label, manager) in guard.iter_mut() {
        if let Err(e) = manager.update_bearer_token(bearer_token.clone()) {
            eprintln!(
                "[Auth] Failed to update bearer token for drive '{}': {}",
                label, e
            );
        } else {
            println!("[Auth] Updated bearer token for drive '{}'", label);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_hcfs_config(account_id: String) -> Result<HcfsConfigResult, String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

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

pub(crate) async fn get_drive_password(account_id: &str) -> Result<String, String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;
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
async fn get_sync_path_for_label(account_id: &str, label: &str) -> Result<String, String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;
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
        println!(
            "[Migration] Folder '{}' uses raw master mnemonic — re-deriving",
            label
        );
    } else {
        println!(
            "[Migration] Folder '{}' uses wrong derived mnemonic (old master?) — re-deriving",
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
    std::fs::File::create(&marker).map_err(|e| {
        format!("Failed to create rekey marker: {e}")
    })?;

    hcfs_client::auth::save_encrypted_mnemonic(
        &folder_enc, &expected, password,
    )
    .map_err(|e| format!("Failed to save derived mnemonic: {e}"))?;
    expected.zeroize();

    // Wipe sync state so files get re-uploaded with the new key
    let state_path = folder_dir.join("sync_state.json");
    let state_bak = folder_dir.join("sync_state.json.bak");
    let _ = std::fs::remove_file(&state_path);
    let _ = std::fs::remove_file(&state_bak);

    println!(
        "[Migration] Re-derived mnemonic for '{}', wiped sync state (remote files preserved)",
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
        println!(
            "[Migration] Legacy A detected: {:?} → {:?}",
            legacy_a_dir, folder_dir
        );

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
            println!("[Migration] Saved master mnemonic from Legacy A");
        }

        // Remove legacy dir (non-fatal on failure)
        if let Err(e) = std::fs::remove_dir_all(&legacy_a_dir) {
            println!("[Migration] Warning: could not remove legacy A dir: {e}");
        } else {
            println!("[Migration] Removed legacy A directory");
        }

        return Ok(());
    }

    // --- Legacy B: account_dir/enc_mnemonic.json (per-account, not per-folder) ---
    if legacy_b_enc.exists() {
        println!(
            "[Migration] Legacy B detected: {:?} → {:?}",
            legacy_b_enc, folder_dir
        );

        // Save as master if not already present
        if !master_path.exists() {
            std::fs::copy(&legacy_b_enc, master_path)
                .map_err(|e| format!("Failed to copy to master mnemonic: {e}"))?;
            println!("[Migration] Saved master mnemonic from Legacy B");
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
                println!("[Migration] Copied {} to folder dir", name);
            }
        }

        let temp_src = account_dir.join("temp");
        if temp_src.is_dir() {
            let temp_dst = folder_dir.join("temp");
            copy_dir_recursive(&temp_src, &temp_dst)
                .map_err(|e| format!("Failed to copy temp dir: {e}"))?;
            println!("[Migration] Copied temp/ to folder dir");
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

        println!("[Migration] Legacy B migration complete");
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
    println!(
        "[Setup] initialize_sync called for account: {}, label: '{}'",
        account_id, label
    );

    // 0. Stop only the drive with the matching label if it exists
    {
        let mut drives_guard = HCFS_DRIVES.lock().await;
        if drives_guard.remove(&label).is_some() {
            println!(
                "[Setup] Dropped previous drive instance for label '{}'",
                label
            );
        }
        discard_pending_activity_for_label(&label);
        remove_state(&label);
    }
    SYNC_IN_PROGRESS.store(false, Ordering::Release);
    SYNC_REVIEW_MODE.store(false, Ordering::Release);

    // 1. Read sync path for the given label from database
    let sync_path = get_sync_path_for_label(&account_id, &label).await?;
    println!("[Setup] Sync path: {}, label: {}", sync_path, label);

    // 2. Read HCFS config from database
    let drive_password = get_drive_password(&account_id).await?;
    let config = get_hcfs_config(account_id.clone()).await?;

    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };
    println!("[Setup] Server URL: {}", server_url);

    // 3. Ensure sync directory exists
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
            let stored = hcfs_client::auth::recover_mnemonic(
                &master_path, &drive_password,
            )
            .map_err(|e| format!("Failed to recover master: {e}"))?;
            let mut stored_str = stored.to_string();
            if stored_str != *imported {
                println!(
                    "[Setup] Stored master differs from login mnemonic — \
                     updating master before derivation check"
                );
                hcfs_client::auth::save_encrypted_mnemonic(
                    &master_path, imported, &drive_password,
                )
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

    // 6. Retrieve the auth token BEFORE unlock so we can set account_ss58 first
    let bearer_token = get_temp_auth_key(&account_id)
        .await
        .map_err(|e| format!("Failed to get auth token: {e}"))?
        .ok_or_else(|| "No authentication token found. Please log in again.".to_string())?;

    println!(
        "[Setup] Retrieved auth token for account_id (SS58): {}",
        account_id
    );
    println!("[Setup] This account_id will be used as user_id for sync requests.");

    // Set HCFS client config BEFORE unlock so account_ss58 is available
    manager.set_config(HcfsClientConfig {
        base_url: server_url.clone(),
        api_key: "Arion".to_string(),
        bearer_token: bearer_token.clone(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        account_ss58: format!("{}_{}", account_id, folder_hash(&label)),
    })?;
    let fhash = folder_hash(&label);
    println!(
        "[Setup] HCFS config set with account_ss58: {}_{} (before unlock). folder_hash('{}')={}",
        account_id, fhash, label, fhash
    );

    // 7. Init or unlock the drive (now account_ss58 is set, so user_id will be correct)
    let (user_id, mnemonic, is_new_setup) = if manager.is_initialized() {
        // Existing folder — just unlock
        println!(
            "[Setup] Drive already initialized for '{}', unlocking...",
            label
        );
        println!("[Setup] Config dir: {:?}", folder_dir);
        println!("[Setup] Password length: {} chars", drive_password.len());

        match manager.unlock(&drive_password) {
            Ok(uid) => {
                println!("[Setup] Drive unlocked, user_id: {}", uid);
                (uid, None, false)
            }
            Err(e) => {
                println!("[Setup] ERROR: unlock failed for '{}': {}", label, e);
                println!("[Setup] Attempting recovery: cleaning up encrypted files...");

                // Remove the corrupted/mismatched enc_mnemonic.json
                let enc_path = folder_dir.join("enc_mnemonic.json");
                if enc_path.exists() {
                    if let Err(rm_err) = std::fs::remove_file(&enc_path) {
                        println!(
                            "[Setup] WARNING: Failed to remove enc_mnemonic.json: {}",
                            rm_err
                        );
                    } else {
                        println!("[Setup] Removed enc_mnemonic.json");
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

                println!("[Setup] Recovery cleanup complete. Retrying initialization...");

                drop(manager);
                manager = HcfsDriveManager::new(PathBuf::from(&sync_path), folder_dir.clone());
                manager.set_config(HcfsClientConfig {
                    base_url: server_url.clone(),
                    api_key: "Arion".to_string(),
                    bearer_token: bearer_token.clone(),
                    accept_invalid_certs: true,
                    billing_bypass_token: None,
                    account_ss58: format!("{}_{}", account_id, folder_hash(&label)),
                })?;

                println!("[Setup] Creating fresh drive after recovery...");

                // Use the login mnemonic if available so recovery stays
                // compatible with other devices. Only generate a random
                // master as a last resort.
                let master_str = if let Some(ref imported) = existing_mnemonic {
                    println!("[Setup] Using login mnemonic as master for recovery");
                    imported.clone()
                } else {
                    let master = bip39::Mnemonic::generate(24)
                        .map_err(|e| format!("Failed to generate mnemonic: {e}"))?;
                    println!("[Setup] Generated new random master for recovery (no login mnemonic available)");
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
                println!(
                    "[Setup] Drive re-initialized and unlocked, derived user_id: {}",
                    uid
                );

                (uid, Some(master_str), true)
            }
        }
    } else {
        // New folder — need to derive or generate mnemonic
        println!(
            "[Setup] Drive not initialized for '{}', creating... (existing_mnemonic={}, master_exists={})",
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
                        &master_path, imported, &drive_password,
                    )
                    .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;
                    println!("[Setup] Saved login mnemonic as master (new device)");
                } else {
                    let stored = hcfs_client::auth::recover_mnemonic(
                        &master_path, &drive_password,
                    )
                    .map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
                    let mut stored_str = stored.to_string();
                    if stored_str != *imported {
                        println!(
                            "[Setup] Stored master differs from login mnemonic — updating master"
                        );
                        hcfs_client::auth::save_encrypted_mnemonic(
                            &master_path, imported, &drive_password,
                        )
                        .map_err(|e| format!("Failed to update master mnemonic: {e}"))?;
                    } else {
                        println!("[Setup] Stored master matches login mnemonic");
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
            println!("[Setup] Derived folder mnemonic from existing master");
            (derived, None, false)
        } else {
            // No login mnemonic AND no master on disk. Generating a random
            // master would silently encrypt files with a key that no other
            // device can derive, causing "Chunk 0 decryption failed" on
            // cross-device sync. Fail loudly so the user can re-login.
            return Err(
                "No encryption key available. Please log out and log in \
                 again with your mnemonic to enable sync."
                    .to_string(),
            );
        };

        // Initialize drive with the folder-specific derived mnemonic
        let mut init_mnemonic = manager.init(&drive_password, Some(&folder_mnemonic))?;
        zeroize::Zeroize::zeroize(&mut init_mnemonic);
        drop(init_mnemonic);
        let mut folder_mnemonic = folder_mnemonic;
        zeroize::Zeroize::zeroize(&mut folder_mnemonic);

        let uid = manager.unlock(&drive_password)?;
        println!(
            "[Setup] Drive initialized and unlocked for '{}', derived user_id: {}",
            label, uid
        );

        (uid, master_for_backup, generated_new_master)
    };

    println!(
        "[Setup] Drive user_id after unlock: {} (should match account_id)",
        user_id
    );
    if user_id != account_id {
        println!(
            "[Setup] WARNING: user_id ({}) != account_id ({}). This may cause 403 errors!",
            user_id, account_id
        );
    }

    // 8. Test server connectivity
    {
        let test_url = format!("{}/health", &server_url);
        println!("[Setup] Testing connectivity to: {}", test_url);
        let test_result = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| format!("Failed to build test client: {e}"))?
            .get(&test_url)
            .header("X-API-Key", "Arion")
            .send()
            .await;
        match test_result {
            Ok(resp) => println!("[Setup] Health check OK: status={}", resp.status()),
            Err(e) => {
                let mut msg = format!("{e}");
                let mut source: Option<&dyn std::error::Error> = e.source();
                while let Some(cause) = source {
                    msg.push_str(&format!("\n  caused by: {cause}"));
                    source = cause.source();
                }
                println!("[Setup] Health check FAILED: {}", msg);
            }
        }
    }

    // 9. Setup progress event handlers with label
    setup_progress_handlers(&app, &mut manager, &label);

    // 10. Clear any previous cancellation flag
    clear_cancel();

    // 11. If ensure_derived_mnemonic left a rekey marker, just consume it.
    //     We intentionally do NOT delete remote files — doing so destroys
    //     data on other devices. Stale remote files encrypted with the old
    //     key will fail to decrypt and be skipped; local files will be
    //     re-uploaded with the new key on the next sync cycle.
    {
        let marker = folder_dir.join(".needs_rekey");
        if marker.exists() {
            println!(
                "[Rekey] Rekey marker found for '{}' — consuming without remote purge",
                label
            );
            let _ = std::fs::remove_file(&marker);
        }
    }

    // 12. Store the manager in the drives registry
    {
        let mut guard = HCFS_DRIVES.lock().await;
        guard.insert(label.clone(), manager);
    }

    // 13. Start (or restart) the background sync loop to pick up the new drive
    if start_loop {
        start_sync_loop(app.clone()).await;
    }

    println!(
        "[Setup] Sync initialized successfully for '{}'. User ID: {}, New setup: {}",
        label, user_id, is_new_setup
    );

    // Register folder with server for cross-device discovery (best-effort)
    {
        let composite = format!("{}_{}", account_id, folder_hash(&label));
        let reg_server = server_url.clone();
        let reg_token = bearer_token.clone();
        let reg_label = label.clone();
        tokio::spawn(async move {
            let config = HcfsClientConfig {
                base_url: reg_server,
                api_key: "Arion".to_string(),
                bearer_token: reg_token,
                accept_invalid_certs: true,
                billing_bypass_token: None,
                account_ss58: String::new(),
            };
            match hcfs_client::client::HcfsClient::new(config) {
                Ok(client) => {
                    if let Err(e) = client.register_folder(&composite, &reg_label).await {
                        println!("[Setup] Warning: folder registration failed: {}", e);
                    } else {
                        println!("[Setup] Folder '{}' registered with server", reg_label);
                    }
                }
                Err(e) => {
                    println!("[Setup] Warning: could not create client for folder registration: {}", e);
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
    request_cancel();

    // Abort the background sync loop task to prevent spurious error events
    {
        let mut handle_guard = SYNC_LOOP_HANDLE.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
    }

    let mut guard = HCFS_DRIVES.lock().await;
    guard.clear();
    SYNC_REVIEW_MODE.store(false, Ordering::Release);
    reset_all_states();
    discard_all_pending_activity();

    // Emit sync stopped event so frontend can reset UI state (tray icon, sync widget)
    let _ = app.emit("hcfs_sync_stopped", ());

    Ok(())
}

/// Stop a single drive by label. If no drives remain, also stops the sync loop.
#[tauri::command]
pub async fn stop_drive(app: AppHandle, label: String) -> Result<(), String> {
    let remaining = {
        let mut guard = HCFS_DRIVES.lock().await;
        guard.remove(&label);
        guard.len()
    };

    remove_state(&label);
    discard_pending_activity_for_label(&label);

    if remaining == 0 {
        // No more drives — stop the sync loop entirely
        request_cancel();
        let mut handle_guard = SYNC_LOOP_HANDLE.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
        SYNC_REVIEW_MODE.store(false, Ordering::Release);
        let _ = app.emit("hcfs_sync_stopped", ());
    } else {
        // Restart sync loop to update watchers (removed drive's path)
        clear_cancel();
        start_sync_loop(app.clone()).await;
    }

    println!(
        "[Sync] Stopped drive '{}', {} drives remaining",
        label, remaining
    );
    Ok(())
}

/// Reset sync data for an account, clearing all local sync state.
/// This allows starting fresh without corrupted or stale sync data.
///
/// IMPORTANT: This does NOT delete files in the sync folder - only HCFS metadata.
/// Files on the server remain intact.
#[tauri::command]
pub async fn reset_sync_data(app: AppHandle, account_id: String) -> Result<(), String> {
    println!("[Sync] Resetting sync data for account: {}", account_id);

    // First stop all active syncs
    stop_sync(app.clone()).await?;

    // Get the account directory
    let acct_dir = account_dir(&account_id)?;

    println!("[Sync] Reset: Deleting account directory: {:?}", acct_dir);

    // Delete the entire account directory (contains sync state, encrypted mnemonic, etc.)
    if acct_dir.exists() {
        std::fs::remove_dir_all(&acct_dir)
            .map_err(|e| format!("Failed to delete account directory: {}", e))?;
        println!("[Sync] Reset: Deleted account directory");
    }

    // Also clear the hcfs_config from database so user goes through setup again
    let db = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .execute(db)
        .await
        .map_err(|e| format!("Failed to clear config: {}", e))?;

    println!("[Sync] Reset: Cleared database config");

    // Emit event so frontend knows to show setup UI
    let _ = app.emit(
        "hcfs_sync_reset",
        serde_json::json!({
            "account_id": account_id,
            "message": "Sync data has been reset. Please set up sync again."
        }),
    );

    println!("[Sync] Reset complete for account: {}", account_id);

    Ok(())
}

/// Check whether the HCFS sync engine is active.
/// With optional label: checks if that specific drive is active.
/// Without label: checks if any drive is active.
#[tauri::command]
pub fn is_drive_active(label: Option<String>) -> bool {
    match HCFS_DRIVES.try_lock() {
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

fn setup_progress_handlers(app: &AppHandle, manager: &mut HcfsDriveManager, label: &str) {
    let a1 = app.clone();
    let a2 = app.clone();
    let a3 = app.clone();
    let a4 = app.clone();
    let a5 = app.clone();
    let a6 = app.clone();

    let l1 = label.to_string();
    let l2 = label.to_string();
    let l3 = label.to_string();
    let l4 = label.to_string();
    let l5 = label.to_string();
    let l6 = label.to_string();

    manager.set_progress(SyncProgress {
        on_upload_progress: Some(Arc::new(move |b, t, p| {
            println!(
                "[Progress] Upload [{}]: {}/{} bytes, path: {:?}",
                l1, b, t, p
            );
            let _ = a1.emit(
                "hcfs_upload_progress",
                serde_json::json!({"label": l1, "bytes": b, "total": t, "path": p}),
            );
            if b == t && t > 0 {
                if let Some(path_str) = p {
                    let file_name = Path::new(path_str)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| path_str.to_string());
                    println!("[Sync] Upload sent [{}]: {}", l1, file_name);
                    add_pending_activity(SyncActivityItem {
                        file_name,
                        action: "uploaded".to_string(),
                        timestamp: chrono::Utc::now().timestamp(),
                        size_bytes: t,
                        label: l1.clone(),
                    });
                }
            }
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            println!(
                "[Progress] Download [{}]: {}/{} bytes, path: {:?}",
                l2, b, t, p
            );
            let _ = a2.emit(
                "hcfs_download_progress",
                serde_json::json!({"label": l2, "bytes": b, "total": t, "path": p}),
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
                    add_pending_activity(SyncActivityItem {
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
            let _ = a3.emit(
                "hcfs_encrypt_progress",
                serde_json::json!({"label": l3, "bytes": b, "total": t, "path": p}),
            );
        })),
        on_decrypt_progress: Some(Arc::new(move |b, t, p| {
            let _ = a4.emit(
                "hcfs_decrypt_progress",
                serde_json::json!({"label": l4, "bytes": b, "total": t, "path": p}),
            );
        })),
        on_scan_progress: Some(Arc::new(move |n, p| {
            let _ = a5.emit(
                "hcfs_scan_progress",
                serde_json::json!({"label": l5, "scanned": n, "path": p}),
            );
        })),
        on_fetch_state_progress: Some(Arc::new(move |f, t| {
            let _ = a6.emit(
                "hcfs_fetch_progress",
                serde_json::json!({"label": l6, "fetched": f, "total": t}),
            );
        })),
    });
}

/// Retrieve the master BIP-39 mnemonic for an account by decrypting it from
/// disk. Shared implementation used by both the Tauri command and the billing
/// auth module.
pub async fn get_mnemonic_for_account(account_id: &str) -> Result<String, String> {
    let drive_password = get_drive_password(account_id).await?;

    // Prefer the master mnemonic at account level
    let master_path = master_mnemonic_path(account_id)?;
    if master_path.exists() {
        let mnemonic = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
            .map_err(|e| e.to_string())?;
        return Ok(mnemonic.to_string());
    }

    // Fallback: try the first active drive's folder mnemonic (pre-migration state).
    println!(
        "[Warning] Master mnemonic not found at {:?}, falling back to per-folder mnemonic",
        master_path
    );
    let guard = HCFS_DRIVES.lock().await;
    let first_drive = guard.values().next();
    match first_drive {
        Some(m) if m.is_initialized() => m.export_mnemonic(&drive_password),
        Some(_) => Err("Drive is not initialized".to_string()),
        None => {
            // No active drive — try reading DB for any sync path
            let db = DB_POOL.get().ok_or("Database not initialized")?;
            let owner = account_key(account_id);
            let result: Option<(String, String)> =
                sqlx::query_as("SELECT path, label FROM sync_paths WHERE owner = ? LIMIT 1")
                    .bind(&owner)
                    .fetch_optional(db)
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
pub async fn get_drive_mnemonic(account_id: String) -> Result<String, String> {
    get_mnemonic_for_account(&account_id).await
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
    account_id: String,
    mnemonic: String,
) -> Result<(), String> {
    let master_path = master_mnemonic_path(&account_id)?;

    let drive_password = match get_drive_password(&account_id).await {
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
        let stored = hcfs_client::auth::recover_mnemonic(
            &master_path, &drive_password,
        )
        .map_err(|e| format!("Failed to recover master: {e}"))?;
        let mut stored_str = stored.to_string();
        if stored_str == mnemonic {
            stored_str.zeroize();
            return Ok(());
        }
        stored_str.zeroize();
        println!(
            "[Setup] Stored master differs from login mnemonic — updating early"
        );
    }

    let acct_dir = account_dir(&account_id)?;
    std::fs::create_dir_all(&acct_dir)
        .map_err(|e| format!("Failed to create account dir: {e}"))?;

    hcfs_client::auth::save_encrypted_mnemonic(
        &master_path,
        &mnemonic,
        &drive_password,
    )
    .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;

    println!(
        "[Setup] Eagerly persisted master mnemonic for account {}",
        &account_id[..8.min(account_id.len())]
    );
    Ok(())
}

/// Stage changes and return a preview of what will sync.
/// Pauses auto-sync while the user reviews.
#[tauri::command]
pub async fn stage_changes() -> Result<StagedChanges, String> {
    // Pause auto-sync so the review is stable
    SYNC_REVIEW_MODE.store(true, Ordering::Release);

    let guard = HCFS_DRIVES.lock().await;
    // For V1, stage the first available drive
    let first_drive = guard.values().next();
    match first_drive {
        Some(m) if m.is_unlocked() => match m.stage_with_paths().await {
            Ok(changes) => Ok(changes),
            Err(e) => {
                SYNC_REVIEW_MODE.store(false, Ordering::Release);
                Err(e)
            }
        },
        Some(_) => {
            SYNC_REVIEW_MODE.store(false, Ordering::Release);
            Err("Drive is not unlocked".to_string())
        }
        None => {
            SYNC_REVIEW_MODE.store(false, Ordering::Release);
            Err("Drive not initialized".to_string())
        }
    }
}

/// Sync with user-provided conflict resolutions, then resume auto-sync.
/// `resolutions` maps hex-encoded FileId → resolution string
/// (one of: "keep_local", "accept_remote", "keep_both", "skip").
#[tauri::command]
pub async fn sync_with_conflict_resolutions(
    app: AppHandle,
    resolutions: HashMap<String, String>,
) -> Result<(), String> {
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
    let label = {
        let guard = HCFS_DRIVES.lock().await;
        guard
            .keys()
            .next()
            .cloned()
            .unwrap_or_else(|| "default".to_string())
    };

    // Mark syncing in shared state
    update_state(&label, |s| {
        s.is_syncing = true;
    });

    let _ = app.emit("hcfs_sync_started", serde_json::json!({"label": label}));

    // Suppress file watcher during sync to prevent feedback loops
    SYNC_IN_PROGRESS.store(true, Ordering::Release);

    let result = {
        let mut guard = HCFS_DRIVES.lock().await;
        match guard.get_mut(&label) {
            Some(m) if m.is_unlocked() => Some(m.sync_with_resolutions(resolutions).await),
            _ => None,
        }
    };

    // Re-enable file watcher after a short delay to ignore trailing FS events
    {
        let flag = SYNC_IN_PROGRESS.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            flag.store(false, Ordering::Release);
        });
    }

    // Resume auto-sync
    SYNC_REVIEW_MODE.store(false, Ordering::Release);

    // Update shared state
    update_state(&label, |s| {
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    });

    match result {
        Some(Ok(outcome)) => {
            println!(
                "[Sync] Reviewed sync completed: uploaded={}, downloaded={}, deleted_local={}, deleted_remote={}, conflicts_resolved={}, conflicts_skipped={}",
                outcome.files_uploaded,
                outcome.files_downloaded,
                outcome.files_deleted_locally,
                outcome.files_deleted_remotely,
                outcome.conflicts_resolved,
                outcome.conflicts_skipped,
            );
            let _ = app.emit(
                "hcfs_sync_completed",
                serde_json::json!({
                    "label": label,
                    "files_uploaded": outcome.files_uploaded,
                    "files_downloaded": outcome.files_downloaded,
                    "files_deleted_locally": outcome.files_deleted_locally,
                    "files_deleted_remotely": outcome.files_deleted_remotely,
                    "conflicts_resolved": outcome.conflicts_resolved,
                    "conflicts_skipped": outcome.conflicts_skipped,
                }),
            );
            Ok(())
        }
        Some(Err(e)) => {
            let _ = app.emit(
                "hcfs_sync_error",
                serde_json::json!({"label": label, "error": e}),
            );
            Err(e)
        }
        None => {
            let msg = "Drive not initialized or not unlocked";
            let _ = app.emit(
                "hcfs_sync_error",
                serde_json::json!({"label": label, "error": msg}),
            );
            Err(msg.to_string())
        }
    }
}

/// Cancel the review dialog and resume auto-sync without syncing.
#[tauri::command]
pub async fn cancel_review() -> Result<(), String> {
    SYNC_REVIEW_MODE.store(false, Ordering::Release);
    println!("[Sync] Review cancelled, auto-sync resumed");
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
}

/// List all folders registered for the current account on the remote server.
#[tauri::command]
pub async fn list_remote_folders(
    account_id: String,
) -> Result<Vec<RemoteFolderInfoResult>, String> {
    let config = get_hcfs_config(account_id.clone()).await?;
    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };

    let bearer_token = get_temp_auth_key(&account_id)
        .await
        .map_err(|e| format!("Failed to get auth token: {e}"))?
        .ok_or_else(|| "No authentication token found. Please log in again.".to_string())?;

    let client_config = HcfsClientConfig {
        base_url: server_url,
        api_key: "Arion".to_string(),
        bearer_token,
        accept_invalid_certs: true,
        billing_bypass_token: None,
        account_ss58: String::new(),
    };

    let client = hcfs_client::client::HcfsClient::new(client_config)
        .map_err(|e| format!("Failed to create HCFS client: {e}"))?;

    let folders = client
        .list_remote_folders(&account_id)
        .await
        .map_err(|e| format!("Failed to list remote folders: {e}"))?;

    Ok(folders
        .into_iter()
        .map(|f| RemoteFolderInfoResult {
            label: f.label,
            folder_hash: f.folder_hash,
            file_count: f.file_count,
            total_bytes: f.total_bytes,
            created_at: f.created_at,
            updated_at: f.updated_at,
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
    app: tauri::AppHandle,
    account_id: String,
    base_path: String,
    folders: Vec<RestoreFolderRequest>,
    existing_mnemonic: Option<String>,
) -> Result<Vec<RestoreResult>, String> {
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
                results.push(RestoreResult {
                    label: folder.label.clone(),
                    success: true,
                    error: None,
                });
            }
            Err(e) => {
                // Rollback: remove the sync path we just inserted
                let _ = crate::commands::substrate_tx::remove_sync_path_internal(
                    &account_id,
                    &folder.label,
                )
                .await;
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
