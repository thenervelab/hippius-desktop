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
use crate::sync_shared::{add_pending_activity, clear_cancel, request_cancel, SyncActivityItem, HCFS_SYNC_STATE};
use crate::utils::account_key::account_key;
use crate::DB_POOL;
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::sync::SyncProgress;
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

/// Initialize sync by reading config from database, creating the HCFS Drive,
/// and starting the background sync loop.
#[tauri::command]
pub async fn initialize_sync(
    app: tauri::AppHandle,
    account_id: String,
    existing_mnemonic: Option<String>,
) -> Result<InitSyncResult, String> {
    println!("[Setup] initialize_sync called for account: {}", account_id);

    // 1. Read sync path from database
    let sync_path = get_sync_path(&account_id).await?;
    println!("[Setup] Sync path: {}", sync_path);

    // 2. Read HCFS config from database
    let drive_password = get_drive_password(&account_id).await?;
    let config = get_hcfs_config(account_id.clone()).await?;

    let server_url = if config.server_url.is_empty() {
        "https://57.129.36.43:9999".to_string()
    } else {
        config.server_url
    };
    println!("[Setup] Server URL: {}", server_url);

    // 3. Ensure sync directory exists
    std::fs::create_dir_all(&sync_path)
        .map_err(|e| format!("Failed to create sync directory: {}", e))?;

    // 4. Create HcfsDriveManager
    let mut manager = HcfsDriveManager::new(PathBuf::from(&sync_path));

    // 5. Init or unlock the drive
    let (user_id, mnemonic, is_new_setup) = if manager.is_initialized() {
        println!("[Setup] Drive already initialized, unlocking...");
        let uid = manager.unlock(&drive_password)?;
        println!("[Setup] Drive unlocked, user_id: {}", uid);
        (uid, None, false)
    } else {
        println!("[Setup] Drive not initialized, creating...");
        let mnemonic_str = manager.init(&drive_password, existing_mnemonic.as_deref())?;
        // After init(), the drive is not yet unlocked — user_id is only derived during unlock().
        // We must unlock to populate signing_key, encryption_key, and user_id.
        let uid = manager.unlock(&drive_password)?;
        println!("[Setup] Drive initialized and unlocked, user_id: {}", uid);

        // Only return mnemonic for backup if we generated a new one (no existing mnemonic provided)
        let mnemonic_to_return = if existing_mnemonic.is_none() {
            Some(mnemonic_str)
        } else {
            None
        };
        (uid, mnemonic_to_return, existing_mnemonic.is_none())
    };

    // 6. Test server connectivity before configuring the drive
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

    // Set HCFS client config (server URL + auth)
    manager.set_config(HcfsClientConfig {
        base_url: server_url,
        api_key: "Arion".to_string(),
        bearer_token: user_id.clone(),
        accept_invalid_certs: true,
    })?;

    // 7. Setup progress event handlers
    setup_progress_handlers(&app, &mut manager);

    // 8. Clear any previous cancellation flag
    clear_cancel();

    // 9. Store the manager globally
    {
        let mut guard = HCFS_DRIVE.lock().await;
        *guard = Some(manager);
    }

    // 10. Start the background sync loop
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
pub async fn stop_sync() -> Result<(), String> {
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
    HCFS_SYNC_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).reset();
    Ok(())
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

/// Return the Drive's actual BIP-39 mnemonic by decrypting it from disk.
/// Requires the Drive to be initialized and the password to be stored in DB.
#[tauri::command]
pub async fn get_drive_mnemonic(account_id: String) -> Result<String, String> {
    let drive_password = get_drive_password(&account_id).await?;
    let guard = HCFS_DRIVE.lock().await;
    match guard.as_ref() {
        Some(m) if m.is_initialized() => m.export_mnemonic(&drive_password),
        Some(_) => Err("Drive is not initialized".to_string()),
        None => {
            // Drive not loaded — try to read mnemonic directly from the sync path
            let sync_path = get_sync_path(&account_id).await?;
            let manager = HcfsDriveManager::new(PathBuf::from(&sync_path));
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
    SYNC_REVIEW_MODE.store(true, Ordering::Relaxed);

    let guard = HCFS_DRIVE.lock().await;
    match guard.as_ref() {
        Some(m) if m.is_unlocked() => match m.stage_with_paths().await {
            Ok(changes) => Ok(changes),
            Err(e) => {
                SYNC_REVIEW_MODE.store(false, Ordering::Relaxed);
                Err(e)
            }
        },
        Some(_) => {
            SYNC_REVIEW_MODE.store(false, Ordering::Relaxed);
            Err("Drive is not unlocked".to_string())
        }
        None => {
            SYNC_REVIEW_MODE.store(false, Ordering::Relaxed);
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
    // Mark syncing in shared state
    {
        let mut s = HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        s.is_syncing = true;
    }

    let _ = app.emit("hcfs_sync_started", ());

    // Suppress file watcher during sync to prevent feedback loops
    SYNC_IN_PROGRESS.store(true, Ordering::Relaxed);

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
            flag.store(false, Ordering::Relaxed);
        });
    }

    // Resume auto-sync
    SYNC_REVIEW_MODE.store(false, Ordering::Relaxed);

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
    SYNC_REVIEW_MODE.store(false, Ordering::Relaxed);
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

    // SAFETY: Clear sensitive data from memory before dropping
    // (best-effort; the compiler may not re-use the allocation, but this
    // prevents the plaintext lingering in the heap after the function returns).
    unsafe {
        let mnemonic_bytes = mnemonic.as_bytes_mut();
        mnemonic_bytes.fill(0);
        let password_bytes = password.as_bytes_mut();
        password_bytes.fill(0);
    }

    result
}
