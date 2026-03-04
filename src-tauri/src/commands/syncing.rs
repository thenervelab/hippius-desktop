//! HCFS sync control commands and configuration.
//!
//! This module contains the Tauri commands for managing the sync lifecycle:
//! - `initialize_sync` — reads config from DB, creates Drive, starts sync loop
//! - `stop_sync` — cancels the sync loop, drops the Drive
//! - `trigger_sync_now` — runs one immediate sync cycle
//! - `save_hcfs_config` / `get_hcfs_config` / `update_hcfs_server_url` — config CRUD
//!
//! It also contains `setup_progress_handlers()` which registers callbacks on the
//! Drive that emit Tauri events for upload/download/encrypt/decrypt progress.

use crate::hcfs_drive::{start_sync_loop, HcfsDriveManager, StagedChanges, HCFS_DRIVE, SYNC_IN_PROGRESS, SYNC_LOOP_HANDLE, SYNC_REVIEW_MODE};
use crate::sync_shared::{add_pending_activity, clear_cancel, discard_pending_activity, request_cancel, SyncActivityItem, HCFS_SYNC_STATE};
use crate::utils::account_key::account_key;
use crate::utils::objectstore_tokens::get_temp_auth_key;
use crate::DB_POOL;
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::sync::SyncProgress;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::error::Error as _;
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
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

async fn get_sync_path(account_id: &str) -> Result<String, String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(account_id);

    let result: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT path FROM sync_paths WHERE owner = ? AND type = 'private'
        "#,
    )
    .bind(&owner)
    .fetch_optional(db)
    .await
    .map_err(|e| format!("Failed to get sync path: {}", e))?;

    result
        .map(|(path,)| path)
        .ok_or_else(|| "Sync path not configured".to_string())
}

/// Compute the account-level directory: `~/.hippius/drives/<account_key>/`
fn account_dir(account_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let key = account_key(account_id);
    Ok(home.join(".hippius").join("drives").join(key))
}

/// Normalize a sync path for deterministic hashing.
///
/// Strips trailing path separators so `/Users/alice/Sync` and `/Users/alice/Sync/`
/// produce the same hash. Does NOT resolve symlinks (canonicalize) because that
/// would make the hash depend on whether a target volume is mounted, breaking
/// folder identity for paths on external or network drives.
fn normalize_sync_path(sync_path: &str) -> String {
    let trimmed = sync_path.trim_end_matches(std::path::is_separator);
    if trimmed.is_empty() {
        sync_path.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Deterministic 16-char hex hash of a sync folder path, used as subdirectory name.
fn folder_hash(sync_path: &str) -> String {
    let normalized = normalize_sync_path(sync_path);
    let digest = Sha256::digest(normalized.as_bytes());
    hex::encode(&digest)[..16].to_string()
}

/// Compute the per-folder config directory:
/// `~/.hippius/drives/<account_key>/<folder_hash>/`
fn config_dir_for_folder(account_id: &str, sync_path: &str) -> Result<PathBuf, String> {
    Ok(account_dir(account_id)?.join(folder_hash(sync_path)))
}

/// Path to the master encrypted mnemonic at the account level:
/// `~/.hippius/drives/<account_key>/master_enc_mnemonic.json`
fn master_mnemonic_path(account_id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(account_id)?.join("master_enc_mnemonic.json"))
}

/// Derive a folder-specific mnemonic from the master mnemonic + sync folder path.
///
/// `folder_entropy = SHA256(master_seed[..32] || sync_path_bytes)`
/// `folder_mnemonic = Mnemonic::from_entropy(folder_entropy)` → 24 words
///
/// Same master + same folder path always produces the same derived mnemonic,
/// giving a deterministic but unique `user_id` per folder on the server.
fn derive_folder_mnemonic(master_mnemonic: &str, sync_path: &str) -> Result<String, String> {
    use bip39::Mnemonic;
    use std::str::FromStr;
    use zeroize::Zeroize;

    let master = Mnemonic::from_str(master_mnemonic)
        .map_err(|e| format!("Invalid master mnemonic: {e}"))?;
    let mut seed = master.to_seed("");

    let normalized = normalize_sync_path(sync_path);
    let mut hasher = Sha256::new();
    hasher.update(&seed[..32]);
    hasher.update(normalized.as_bytes());
    seed.zeroize();
    let mut folder_entropy: [u8; 32] = hasher.finalize().into();

    let folder_mnemonic = Mnemonic::from_entropy(&folder_entropy)
        .map_err(|e| {
            folder_entropy.zeroize();
            format!("Failed to derive folder mnemonic: {e}")
        })?;
    folder_entropy.zeroize();
    Ok(folder_mnemonic.to_string())
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
            return Err("Migration A verification failed: enc_mnemonic.json not in folder dir".to_string());
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
        for name in &["enc_mnemonic.json", "sync_state.json", "sync_state.json.bak"] {
            let src = account_dir.join(name);
            if src.exists() {
                let dst = folder_dir.join(name);
                std::fs::copy(&src, &dst)
                    .map_err(|e| format!("Failed to copy {name}: {e}"))?;
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
            return Err("Migration B verification failed: enc_mnemonic.json not in folder dir".to_string());
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

        println!("[Migration] Legacy B migration complete");
        return Ok(());
    }

    // No legacy layout found — fresh setup
    Ok(())
}

/// Copy all entries from `src` into `dst`, recursing into subdirectories.
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {:?}: {e}", src))?;

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

/// Initialize sync by reading config from database, creating the HCFS Drive,
/// and starting the background sync loop.
///
/// Each sync folder gets its own derived mnemonic from the master, producing
/// a unique `user_id` on the server. This keeps folder namespaces isolated:
/// switching folders won't download files from the previous folder.
#[tauri::command]
pub async fn initialize_sync(
    app: tauri::AppHandle,
    account_id: String,
    existing_mnemonic: Option<String>,
) -> Result<InitSyncResult, String> {
    println!("[Setup] initialize_sync called for account: {}", account_id);

    // 0. Stop any previously running sync to ensure clean account switches
    {
        request_cancel();
        let mut handle_guard = SYNC_LOOP_HANDLE.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
            println!("[Setup] Aborted previous sync loop");
        }
        let mut drive_guard = HCFS_DRIVE.lock().await;
        if drive_guard.is_some() {
            *drive_guard = None;
            println!("[Setup] Dropped previous drive instance");
        }
        SYNC_IN_PROGRESS.store(false, Ordering::Release);
        SYNC_REVIEW_MODE.store(false, Ordering::Release);
        discard_pending_activity();
        HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset();
    }

    // 1. Read sync path from database
    let sync_path = get_sync_path(&account_id).await?;
    println!("[Setup] Sync path: {}", sync_path);

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
    let folder_dir = config_dir_for_folder(&account_id, &sync_path)?;
    let master_path = master_mnemonic_path(&account_id)?;
    run_migration(&sync_path, &acct_dir, &folder_dir, &master_path)?;

    // 5. Create HcfsDriveManager with per-folder config directory
    let mut manager = HcfsDriveManager::new(PathBuf::from(&sync_path), folder_dir.clone());

    // 6. Retrieve the auth token BEFORE unlock so we can set account_ss58 first
    // This is critical: unlock() uses account_ss58 to determine the user_id.
    // If account_ss58 is not set before unlock(), the user_id will be the
    // hex-encoded ed25519 public key instead of the SS58 substrate address,
    // causing 403 errors on the server (token's substrate_address won't match).
    let bearer_token = get_temp_auth_key(&account_id)
        .await
        .map_err(|e| format!("Failed to get auth token: {e}"))?
        .ok_or_else(|| {
            "No authentication token found. Please log in again.".to_string()
        })?;
    
    // Debug: Log account and token info for troubleshooting 403 errors
    println!("[Setup] Retrieved auth token for account_id (SS58): {}", account_id);
    println!("[Setup] account_id length: {} chars", account_id.len());
    println!("[Setup] This account_id will be used as user_id for sync requests.");

    // Set HCFS client config BEFORE unlock so account_ss58 is available
    manager.set_config(HcfsClientConfig {
        base_url: server_url.clone(),
        api_key: "Arion".to_string(),
        bearer_token: bearer_token.clone(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        account_ss58: format!("{}_{}", account_id, folder_hash(&sync_path)),
    })?;
    println!("[Setup] HCFS config set with account_ss58: {}_{} (before unlock)", account_id, folder_hash(&sync_path));

    // 7. Init or unlock the drive (now account_ss58 is set, so user_id will be correct)
    let (user_id, mnemonic, is_new_setup) = if manager.is_initialized() {
        // Existing folder — just unlock
        println!("[Setup] Drive already initialized, unlocking...");
        // Debug: Log the config directory and enc_mnemonic path
        println!("[Setup] Config dir: {:?}", folder_dir);
        println!("[Setup] Password length: {} chars", drive_password.len());
        
        match manager.unlock(&drive_password) {
            Ok(uid) => {
                println!("[Setup] Drive unlocked, user_id: {}", uid);
                (uid, None, false)
            }
            Err(e) => {
                // Detailed error logging for unlock failure
                println!("[Setup] ERROR: unlock failed: {}", e);
                // If unlock fails, the enc_mnemonic.json might be corrupted or encrypted with
                // a different password. Clean up ALL encrypted files and start fresh.
                println!("[Setup] Attempting recovery: cleaning up encrypted files...");
                
                // Remove the corrupted/mismatched enc_mnemonic.json
                let enc_path = folder_dir.join("enc_mnemonic.json");
                if enc_path.exists() {
                    if let Err(rm_err) = std::fs::remove_file(&enc_path) {
                        println!("[Setup] WARNING: Failed to remove enc_mnemonic.json: {}", rm_err);
                    } else {
                        println!("[Setup] Removed enc_mnemonic.json");
                    }
                }
                
                // Also remove the master mnemonic - it might be encrypted with wrong password too
                if master_path.exists() {
                    if let Err(rm_err) = std::fs::remove_file(&master_path) {
                        println!("[Setup] WARNING: Failed to remove master_enc_mnemonic.json: {}", rm_err);
                    } else {
                        println!("[Setup] Removed master_enc_mnemonic.json (will regenerate)");
                    }
                }
                
                // Also remove sync_state.json to start fresh
                let state_path = folder_dir.join("sync_state.json");
                let state_bak_path = folder_dir.join("sync_state.json.bak");
                let _ = std::fs::remove_file(&state_path);
                let _ = std::fs::remove_file(&state_bak_path);
                
                println!("[Setup] Recovery cleanup complete. Retrying initialization...");
                
                // Instead of returning an error, let's retry the initialization
                // by falling through to the "not initialized" branch
                // We need to recreate the manager since the old one might have stale state
                drop(manager);
                manager = HcfsDriveManager::new(PathBuf::from(&sync_path), folder_dir.clone());
                manager.set_config(HcfsClientConfig {
                    base_url: server_url.clone(),
                    api_key: "Arion".to_string(),
                    bearer_token: bearer_token.clone(),
                    accept_invalid_certs: true,
                    billing_bypass_token: None,
                    account_ss58: account_id.clone(),
                })?;
                
                // Now continue with fresh initialization
                println!("[Setup] Creating fresh drive after recovery...");
                
                // Generate new master and folder mnemonic
                let master = bip39::Mnemonic::generate(24)
                    .map_err(|e| format!("Failed to generate mnemonic: {e}"))?;
                let master_str = master.to_string();
                hcfs_client::auth::save_encrypted_mnemonic(
                    &master_path,
                    &master_str,
                    &drive_password,
                )
                .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;
                println!("[Setup] Generated and saved new master mnemonic");
                let derived = derive_folder_mnemonic(&master_str, &sync_path)?;
                
                // Initialize drive with the folder-specific derived mnemonic
                let mut init_mnemonic = manager.init(&drive_password, Some(&derived))?;
                zeroize::Zeroize::zeroize(&mut init_mnemonic);
                
                let uid = manager.unlock(&drive_password)?;
                println!("[Setup] Drive re-initialized and unlocked, derived user_id: {}", uid);
                
                // Return the new master mnemonic for backup
                (uid, Some(master_str), true)
            }
        }
    } else {
        // New folder — need to derive or generate mnemonic
        println!("[Setup] Drive not initialized, creating...");

        let (folder_mnemonic, master_for_backup, generated_new_master) =
            if let Some(ref imported) = existing_mnemonic {
                // User importing a mnemonic (first setup or recovery)
                if !master_path.exists() {
                    hcfs_client::auth::save_encrypted_mnemonic(
                        &master_path,
                        imported,
                        &drive_password,
                    )
                    .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;
                    println!("[Setup] Saved imported mnemonic as master");
                    let derived = derive_folder_mnemonic(imported, &sync_path)?;
                    (derived, None, false)
                } else {
                    // Master already exists — derive from the existing master so
                    // get_drive_mnemonic() stays consistent with the derivation.
                    println!("[Setup] Master already exists, deriving from it (ignoring import)");
                    let master = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
                        .map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
                    let mut master_str = master.to_string();
                    let derived = derive_folder_mnemonic(&master_str, &sync_path)?;
                    zeroize::Zeroize::zeroize(&mut master_str);
                    (derived, None, false)
                }
            } else if master_path.exists() {
                // Folder switch — read master, derive new folder mnemonic
                let master = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
                    .map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
                let mut master_str = master.to_string();
                let derived = derive_folder_mnemonic(&master_str, &sync_path)?;
                zeroize::Zeroize::zeroize(&mut master_str);
                println!("[Setup] Derived folder mnemonic from existing master");
                (derived, None, false)
            } else {
                // First-ever setup — generate new 24-word master mnemonic
                let master = bip39::Mnemonic::generate(24)
                    .map_err(|e| format!("Failed to generate mnemonic: {e}"))?;
                let master_str = master.to_string();
                hcfs_client::auth::save_encrypted_mnemonic(
                    &master_path,
                    &master_str,
                    &drive_password,
                )
                .map_err(|e| format!("Failed to save master mnemonic: {e}"))?;
                println!("[Setup] Generated and saved new master mnemonic");
                let derived = derive_folder_mnemonic(&master_str, &sync_path)?;
                // master_str returned for backup display — frontend is responsible for clearing
                (derived, Some(master_str), true)
            };

        // Initialize drive with the folder-specific derived mnemonic
        let mut init_mnemonic = manager.init(&drive_password, Some(&folder_mnemonic))?;
        zeroize::Zeroize::zeroize(&mut init_mnemonic);
        drop(init_mnemonic);
        let mut folder_mnemonic = folder_mnemonic;
        zeroize::Zeroize::zeroize(&mut folder_mnemonic);

        let uid = manager.unlock(&drive_password)?;
        println!("[Setup] Drive initialized and unlocked, derived user_id: {}", uid);

        (uid, master_for_backup, generated_new_master)
    };

    // Log the final user_id that will be used (should match account_id/account_ss58)
    println!("[Setup] Drive user_id after unlock: {} (should match account_id)", user_id);
    if user_id != account_id {
        println!("[Setup] WARNING: user_id ({}) != account_id ({}). This may cause 403 errors!", user_id, account_id);
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

    // 9. Setup progress event handlers
    setup_progress_handlers(&app, &mut manager);

    // 10. Clear any previous cancellation flag
    clear_cancel();

    // 11. Store the manager globally
    {
        let mut guard = HCFS_DRIVE.lock().await;
        *guard = Some(manager);
    }

    // 12. Start the background sync loop
    start_sync_loop(app.clone()).await;

    println!(
        "[Setup] Sync initialized successfully. User ID: {}, New setup: {}",
        user_id, is_new_setup
    );

    Ok(InitSyncResult {
        user_id,
        mnemonic,
        is_new_setup,
    })
}

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

    let mut guard = HCFS_DRIVE.lock().await;
    *guard = None;
    SYNC_REVIEW_MODE.store(false, Ordering::Release);
    HCFS_SYNC_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).reset();

    // Emit sync stopped event so frontend can reset UI state (tray icon, sync widget)
    let _ = app.emit("hcfs_sync_stopped", ());

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
    
    // First stop any active sync
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
    let _ = app.emit("hcfs_sync_reset", serde_json::json!({
        "account_id": account_id,
        "message": "Sync data has been reset. Please set up sync again."
    }));
    
    println!("[Sync] ✅ Reset complete for account: {}", account_id);
    
    Ok(())
}

/// Check whether the HCFS drive is loaded (sync engine is active).
/// Unlike `get_sync_status().is_syncing` (which indicates an active sync *operation*),
/// this indicates whether the sync *engine* is running.
#[tauri::command]
pub fn is_drive_active() -> bool {
    match HCFS_DRIVE.try_lock() {
        Ok(guard) => guard.is_some(),
        // If the lock is held, the drive is in use (sync in progress) → active
        Err(_) => true,
    }
}

#[tauri::command]
pub async fn trigger_sync_now(app: AppHandle) -> Result<(), String> {
    crate::hcfs_drive::trigger_sync(&app).await;
    Ok(())
}

fn setup_progress_handlers(app: &AppHandle, manager: &mut HcfsDriveManager) {
    let a1 = app.clone();
    let a2 = app.clone();
    let a3 = app.clone();
    let a4 = app.clone();
    let a5 = app.clone();
    let a6 = app.clone();

    manager.set_progress(SyncProgress {
        on_upload_progress: Some(Arc::new(move |b, t, p| {
            println!("[Progress] Upload: {}/{} bytes, path: {:?}", b, t, p);
            let _ = a1.emit(
                "hcfs_upload_progress",
                serde_json::json!({"bytes": b, "total": t, "path": p}),
            );
            // Buffer file activity when all bytes are sent. The item is only committed
            // to the real activity log after trigger_sync confirms the sync succeeded.
            if b == t && t > 0 {
                if let Some(path_str) = p {
                    let file_name = Path::new(path_str)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| path_str.to_string());
                    println!("[Sync] Upload sent: {}", file_name);
                    add_pending_activity(SyncActivityItem {
                        file_name,
                        action: "uploaded".to_string(),
                        timestamp: chrono::Utc::now().timestamp(),
                        size_bytes: t,
                    });
                }
            }
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            println!("[Progress] Download: {}/{} bytes, path: {:?}", b, t, p);
            let _ = a2.emit(
                "hcfs_download_progress",
                serde_json::json!({"bytes": b, "total": t, "path": p}),
            );
            // Buffer file activity when all bytes are received. Only committed after
            // trigger_sync confirms the sync succeeded.
            if b == t && t > 0 {
                if let Some(path_str) = p {
                    let file_name = Path::new(path_str)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| path_str.to_string());
                    println!("[Sync] Download received: {}", file_name);
                    add_pending_activity(SyncActivityItem {
                        file_name,
                        action: "downloaded".to_string(),
                        timestamp: chrono::Utc::now().timestamp(),
                        size_bytes: t,
                    });
                }
            }
        })),
        // Note: encrypt/decrypt/scan/fetch progress events are emitted but not yet
        // consumed by the frontend. They're available for future UI enhancements.
        on_encrypt_progress: Some(Arc::new(move |b, t, p| {
            let _ = a3.emit(
                "hcfs_encrypt_progress",
                serde_json::json!({"bytes": b, "total": t, "path": p}),
            );
        })),
        on_decrypt_progress: Some(Arc::new(move |b, t, p| {
            let _ = a4.emit(
                "hcfs_decrypt_progress",
                serde_json::json!({"bytes": b, "total": t, "path": p}),
            );
        })),
        on_scan_progress: Some(Arc::new(move |n, p| {
            let _ = a5.emit(
                "hcfs_scan_progress",
                serde_json::json!({"scanned": n, "path": p}),
            );
        })),
        on_fetch_state_progress: Some(Arc::new(move |f, t| {
            let _ = a6.emit(
                "hcfs_fetch_progress",
                serde_json::json!({"fetched": f, "total": t}),
            );
        })),
    });
}

/// Return the master BIP-39 mnemonic by decrypting it from disk.
///
/// Returns the **master** mnemonic (the one the user should back up), not the
/// per-folder derived mnemonic. This is the recovery seed that can reconstruct
/// any folder's derived mnemonic.
#[tauri::command]
pub async fn get_drive_mnemonic(account_id: String) -> Result<String, String> {
    let drive_password = get_drive_password(&account_id).await?;

    // Prefer the master mnemonic at account level
    let master_path = master_mnemonic_path(&account_id)?;
    if master_path.exists() {
        let mnemonic = hcfs_client::auth::recover_mnemonic(&master_path, &drive_password)
            .map_err(|e| e.to_string())?;
        return Ok(mnemonic.to_string());
    }

    // Fallback: try the active drive's folder mnemonic (pre-migration state).
    // WARNING: this returns a per-folder derived mnemonic, not the master.
    // This path should only be reached for users who haven't been migrated yet.
    println!(
        "[Warning] Master mnemonic not found at {:?}, falling back to per-folder mnemonic",
        master_path
    );
    let guard = HCFS_DRIVE.lock().await;
    match guard.as_ref() {
        Some(m) if m.is_initialized() => m.export_mnemonic(&drive_password),
        Some(_) => Err("Drive is not initialized".to_string()),
        None => {
            // Drive not loaded — try per-folder config
            let sync_path = get_sync_path(&account_id).await?;
            let folder_dir = config_dir_for_folder(&account_id, &sync_path)?;
            let manager = HcfsDriveManager::new(PathBuf::from(&sync_path), folder_dir);
            if manager.is_initialized() {
                manager.export_mnemonic(&drive_password)
            } else {
                Err("Drive is not initialized".to_string())
            }
        }
    }
}

/// Stage changes and return a preview of what will sync.
/// Pauses auto-sync while the user reviews.
#[tauri::command]
pub async fn stage_changes() -> Result<StagedChanges, String> {
    // Pause auto-sync so the review is stable
    SYNC_REVIEW_MODE.store(true, Ordering::Release);

    let guard = HCFS_DRIVE.lock().await;
    match guard.as_ref() {
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

    // Mark syncing in shared state
    {
        let mut s = HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        s.is_syncing = true;
    }

    let _ = app.emit("hcfs_sync_started", ());

    // Suppress file watcher during sync to prevent feedback loops
    SYNC_IN_PROGRESS.store(true, Ordering::Release);

    let result = {
        let mut guard = HCFS_DRIVE.lock().await;
        match guard.as_mut() {
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
    {
        let mut s = HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    }

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
            let _ = app.emit("hcfs_sync_error", serde_json::json!({"error": e}));
            Err(e)
        }
        None => {
            let msg = "Drive not initialized or not unlocked";
            let _ = app.emit("hcfs_sync_error", serde_json::json!({"error": msg}));
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

        let cursor = zip.finish().map_err(|e| format!("Failed to finalize zip: {e}"))?;
        std::fs::write(&output_path, cursor.into_inner())
            .map_err(|e| format!("Failed to write backup file: {e}"))?;

        Ok(())
    })();

    // Clear sensitive data from memory before dropping.
    // zeroize prevents the optimizer from eliding these writes.
    zeroize::Zeroize::zeroize(&mut mnemonic);
    zeroize::Zeroize::zeroize(&mut password);

    result
}
