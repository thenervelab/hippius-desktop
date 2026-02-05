use crate::hcfs_drive::{HcfsDriveManager, HCFS_DRIVE};
use crate::sync_shared::{clear_cancel, request_cancel, HCFS_SYNC_STATE};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::sync::SyncProgress;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct InitSyncResult {
    pub user_id: String,
    pub mnemonic: Option<String>,
    pub is_new_setup: bool,
}

#[tauri::command]
pub async fn initialize_sync(
    app: AppHandle,
    sync_path: String,
    password: String,
    server_url: String,
    api_key: String,
    existing_mnemonic: Option<String>,
) -> Result<InitSyncResult, String> {
    // 1. Create Drive manager
    {
        let mut guard = HCFS_DRIVE.lock().await;
        *guard = Some(HcfsDriveManager::new(sync_path.into()));
    }

    let mut guard = HCFS_DRIVE.lock().await;
    let manager = guard.as_mut().unwrap();

    // 2. Init or unlock
    let is_new = !manager.is_initialized();
    let mnemonic = if is_new {
        Some(manager.init(&password, existing_mnemonic.as_deref())?)
    } else {
        None
    };
    let user_id = manager.unlock(&password)?;

    // 3. Configure server
    manager.set_config(HcfsClientConfig {
        base_url: server_url,
        api_key,
        bearer_token: String::new(),
        accept_invalid_certs: false,
    })?;

    // 4. Setup progress handlers
    setup_progress_handlers(&app, manager);

    // 5. Start sync loop
    drop(guard);
    clear_cancel();
    crate::hcfs_drive::start_sync_loop(app).await;

    Ok(InitSyncResult {
        user_id,
        mnemonic,
        is_new_setup: is_new,
    })
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
