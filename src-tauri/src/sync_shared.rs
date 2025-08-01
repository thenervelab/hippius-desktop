use std::sync::{Arc, Mutex};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Wry};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use once_cell::sync::Lazy;

// Global sync status tracking (split by sync type)
pub static PRIVATE_SYNC_STATUS: Lazy<Arc<Mutex<SyncStatus>>> =
    Lazy::new(|| Arc::new(Mutex::new(SyncStatus::default())));
pub static PUBLIC_SYNC_STATUS: Lazy<Arc<Mutex<SyncStatus>>> =
    Lazy::new(|| Arc::new(Mutex::new(SyncStatus::default())));

// Upload lock to prevent concurrent uploads
pub static UPLOAD_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

// Track accounts currently syncing (account_id + sync_type)
pub static SYNCING_ACCOUNTS: Lazy<Arc<Mutex<HashSet<(String, &'static str)>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

#[derive(Debug, Clone)]
pub struct UploadJob {
    pub account_id: String,
    pub seed_phrase: String,
    pub file_path: String,
    pub is_folder: bool,
}

#[tauri::command]
pub fn get_sync_status() -> SyncStatusResponse {
    let private_status = PRIVATE_SYNC_STATUS.lock().unwrap();
    let public_status = PUBLIC_SYNC_STATUS.lock().unwrap();

    let total_files = private_status.total_files + public_status.total_files;
    let processed_files = private_status.processed_files + public_status.processed_files;
    let synced_files = private_status.synced_files + public_status.synced_files;
    let in_progress = private_status.in_progress || public_status.in_progress;

    let percent = if total_files > 0 {
        (processed_files as f32 / total_files as f32) * 100.0
    } else if in_progress {
        0.0
    } else {
        100.0
    };

    SyncStatusResponse {
        synced_files,
        total_files,
        in_progress,
        percent,
    }
}

#[tauri::command]
pub fn app_close(app: AppHandle<Wry>) {
    app.exit(0);
}

pub fn collect_files_recursively(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            files.push(path);
        } else if path.is_dir() {
            collect_files_recursively(&path, files)?;
        }
    }
    Ok(())
}

pub fn find_top_level_folder(path: &Path, sync_path: &Path) -> Option<PathBuf> {
    // If the path is already a direct child of sync_path, return it
    if path.parent().map(|p| p == sync_path).unwrap_or(false) {
        return Some(path.to_path_buf());
    }
    
    // Otherwise walk up the tree to find the first child of sync_path
    let mut current = path;
    while let Some(parent) = current.parent() {
        if parent == sync_path {
            return Some(current.to_path_buf());
        }
        current = parent;
    }
    None
}

pub async fn insert_file_if_not_exists(pool: &sqlx::SqlitePool, file_path: &Path, owner: &str, is_public: bool, is_folder: bool) {
    let file_path = if file_path.is_relative() {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(file_path),
            Err(e) => {
                eprintln!("Failed to get current directory: {}", e);
                return;
            }
        }
    } else {
        file_path.to_path_buf()
    };
    let file_name = file_path.file_name().unwrap().to_string_lossy();
    let file_type = if is_public { "public" } else { "private" };

    let exists: Option<(String,)> = sqlx::query_as(
        "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
    )
    .bind(&file_name)
    .bind(owner)
    .bind(file_type)
    .fetch_optional(pool)
    .await
    .unwrap();
    if exists.is_none() {
        sqlx::query(
            "INSERT INTO sync_folder_files (
                file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, main_req_hash, selected_validator, total_replicas, block_number, profile_cid, source, miner_ids, type, is_folder
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&file_name)
        .bind(owner)
        .bind("")
        .bind("")
        .bind(0)
        .bind(false)
        .bind(0)
        .bind("")
        .bind("")
        .bind(0)
        .bind(0)
        .bind("")
        .bind("")
        .bind("")
        .bind(file_type)
        .bind(is_folder)
        .execute(pool)
        .await
        .unwrap();
    }
}