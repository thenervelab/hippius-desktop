use crate::hcfs_drive::{HcfsDriveManager, HCFS_DRIVE};
use crate::sync_shared::{request_cancel, HCFS_SYNC_STATE};
use crate::DB_POOL;
use hcfs_client::sync::SyncProgress;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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
    .bind(&account_id)
    .bind(&server_url)
    .bind(&drive_password)
    .execute(db)
    .await
    .map_err(|e| format!("Failed to save HCFS config: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_hcfs_config(account_id: String) -> Result<HcfsConfigResult, String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;

    let result: Option<(String, String)> = sqlx::query_as(
        r#"
        SELECT server_url, drive_password FROM hcfs_config WHERE owner = ?
        "#,
    )
    .bind(&account_id)
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

    let result: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT drive_password FROM hcfs_config WHERE owner = ?
        "#,
    )
    .bind(account_id)
    .fetch_optional(db)
    .await
    .map_err(|e| format!("Failed to get drive password: {}", e))?;

    result
        .map(|(password,)| password)
        .ok_or_else(|| "HCFS config not found".to_string())
}

async fn get_sync_path(account_id: &str) -> Result<String, String> {
    let db = DB_POOL.get().ok_or("Database not initialized")?;

    let result: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT path FROM sync_paths WHERE owner = ? AND type = 'private'
        "#,
    )
    .bind(account_id)
    .fetch_optional(db)
    .await
    .map_err(|e| format!("Failed to get sync path: {}", e))?;

    result
        .map(|(path,)| path)
        .ok_or_else(|| "Sync path not configured".to_string())
}

fn generate_user_id(input: &str) -> String {
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    let hash_val = hasher.finish();
    format!("hcfs_user_{:x}", hash_val)
}

/// Initialize sync by reading config from database
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
    let _drive_password = get_drive_password(&account_id).await?;
    let config = get_hcfs_config(account_id.clone()).await?;

    let server_url = if config.server_url.is_empty() {
        "https://hcfs.hippius.com".to_string()
    } else {
        config.server_url
    };
    println!("[Setup] Server URL: {}", server_url);

    // 3. Generate user ID from account
    let user_id = generate_user_id(&account_id);

    // 4. Determine if this is a new setup and if we need to return a mnemonic
    let (generated_mnemonic, is_new_setup) = if existing_mnemonic.is_some() {
        // User provided mnemonic (mnemonic auth) - reuse it
        (None, false)
    } else {
        // OAuth user or first-time setup without mnemonic
        // TODO: Integrate with actual HCFS library to generate mnemonic
        // For now, return None - actual implementation will generate one
        (None, true)
    };

    // 5. Emit sync started event
    if let Err(e) = app.emit("hcfs_sync_started", &user_id) {
        eprintln!("[Setup] Failed to emit hcfs_sync_started event: {}", e);
    }

    println!(
        "[Setup] Sync initialized successfully. User ID: {}, New setup: {}",
        user_id, is_new_setup
    );

    Ok(InitSyncResult {
        user_id,
        mnemonic: generated_mnemonic,
        is_new_setup,
    })
}

// Placeholder for actual HCFS drive initialization
async fn initialize_hcfs_drive(
    sync_path: &str,
    password: &str,
    server_url: &str,
    api_key: &str,
    existing_mnemonic: Option<&str>,
) -> Result<(String, Option<String>, bool), String> {
    // TODO: Implement actual HCFS drive initialization
    // This should:
    // 1. Check if drive already exists at sync_path
    // 2. If exists: unlock with password, return (user_id, None, false)
    // 3. If not exists:
    //    - If existing_mnemonic provided: use it to derive keys
    //    - If no mnemonic: generate new one
    //    - Create drive, return (user_id, Some(mnemonic) if generated, true)

    println!(
        "[Setup] HCFS drive init - path: {}, server: {}, has_mnemonic: {}",
        sync_path,
        server_url,
        existing_mnemonic.is_some()
    );

    // Placeholder response
    let user_id = format!("hcfs_user_{}", &account_id_hash(sync_path));
    let (mnemonic, is_new) = if existing_mnemonic.is_some() {
        (None, false)
    } else {
        // Would generate new mnemonic here for OAuth users
        // For now, return None to indicate no backup needed
        (None, true)
    };

    Ok((user_id, mnemonic, is_new))
}

fn account_id_hash(input: &str) -> String {
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())[..8].to_string()
}

#[tauri::command]
pub async fn stop_sync() -> Result<(), String> {
    request_cancel();
    let mut guard = HCFS_DRIVE.lock().await;
    *guard = None;
    HCFS_SYNC_STATE.lock().unwrap().reset();
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
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            let _ = a2.emit(
                "hcfs_download_progress",
                serde_json::json!({"bytes": b, "total": t, "path": p}),
            );
        })),
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
