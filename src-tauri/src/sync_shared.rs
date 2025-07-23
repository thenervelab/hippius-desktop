use std::sync::{Arc, Mutex};
use std::collections::HashSet;
use once_cell::sync::Lazy;
use once_cell::sync::OnceCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use tokio::sync::mpsc;
use crate::folder_sync::collect_files_recursively;
use std::path::Path;
use tauri::{AppHandle, Wry};
use std::fs;

// Global sync status tracking
pub static SYNC_STATUS: Lazy<Arc<Mutex<SyncStatus>>> =
    Lazy::new(|| Arc::new(Mutex::new(SyncStatus::default())));

// Upload lock to prevent concurrent uploads
pub static UPLOAD_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

// Track files currently being uploaded to prevent duplicates
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track accounts currently syncing (account_id + sync_type)
pub static SYNCING_ACCOUNTS: Lazy<Arc<Mutex<HashSet<(String, &'static str)>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track recently uploaded files to prevent immediate re-processing
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track recently uploaded folders to prevent immediate re-processing
pub static RECENTLY_UPLOADED_FOLDERS: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Debounce state for batching create events
pub static CREATE_BATCH: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
pub static CREATE_BATCH_TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
pub struct UploadJob {
    pub account_id: String,
    pub seed_phrase: String,
    pub file_path: String,
    pub is_folder: bool,  // New field to distinguish folders from files
}

pub static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();

pub async fn insert_file_if_not_exists(pool: &sqlx::SqlitePool, file_path: &Path, owner: &str, is_public: bool, is_folder: bool) {
    let file_name = file_path.file_name().unwrap().to_string_lossy();
    let file_type = if is_public { "public" } else { "private" };
    println!("file type {:?}, is_folder : {:?}, filename {:?}", file_type, is_folder, file_name);
    
    // If this is a folder, collect and insert all its files first
    if is_folder && file_path.is_dir() {
        println!("[DB] Processing folder: {}", file_path.display());
        let mut files = Vec::new();
        collect_files_recursively(file_path, &mut files);
        println!("[DB] Found {} files in folder", files.len());
        for file in files {
            println!("[DB] Processing file");
            let file_name = file.file_name().unwrap().to_string_lossy();
            let exists: Option<(String,)> = sqlx::query_as("SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?")
                .bind(&file_name)
                .bind(owner)
                .bind(file_type)
                .fetch_optional(pool)
                .await
                .unwrap();
            println!("file exists: {:?}", exists.is_some());
            if exists.is_none() {
                println!("file type {:?}, is_folder : {:?}, filename {:?}", file_type, is_folder, file_name);
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
                .bind(false)
                .execute(pool)
                .await
                .unwrap();
            }
        }
    }
    let exists: Option<(String,)> = sqlx::query_as("SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?")
        .bind(&file_name)
        .bind(owner)
        .bind(file_type)
        .fetch_optional(pool)
        .await
        .unwrap();
    println!("folder exists: {:?}", exists.is_some());
    if exists.is_none() {
        sqlx::query(
            "INSERT INTO sync_folder_files (
                file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, main_req_hash, selected_validator, total_replicas, block_number, profile_cid, source, miner_ids, type, is_folder
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&file_name)
        .bind(owner) // owner
        .bind("") // cid
        .bind("") // file_hash
        .bind(0) // file_size_in_bytes
        .bind(false) // is_assigned
        .bind(0) // last_charged_at
        .bind("") // main_req_hash
        .bind("") // selected_validator
        .bind(0) // total_replicas
        .bind(0) // block_number
        .bind("") // profile_cid
        .bind("") // source
        .bind("") // miner_ids
        .bind(file_type) // type
        .bind(is_folder) // is_folder
        .execute(pool)
        .await
        .unwrap();
    }
}

pub fn collect_files_and_folders_recursively(dir: &Path, items: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() || path.is_dir() {
                items.push(path.clone());
                if path.is_dir() {
                    collect_files_and_folders_recursively(&path, items);
                }
            }
        }
    }
}

#[tauri::command]
pub fn get_sync_status() -> SyncStatusResponse {
    let status = SYNC_STATUS.lock().unwrap();
    let percent = if status.total_files > 0 {
        (status.synced_files as f32 / status.total_files as f32) * 100.0
    } else {
        0.0
    };

    SyncStatusResponse {
        synced_files: status.synced_files,
        total_files: status.total_files,
        in_progress: status.in_progress,
        percent,
    }
}

#[tauri::command]
pub fn app_close(app: AppHandle<Wry>) {
    app.exit(0);      
}

