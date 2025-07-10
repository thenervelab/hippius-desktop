use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind, event::CreateKind, event::ModifyKind};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::thread;
use crate::constants::substrate::{SYNC_PATH};
use crate::constants::ipfs::{API_URL};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse, DEFAULT_K, DEFAULT_M, DEFAULT_CHUNK_SIZE};
use crate::commands::ipfs_commands::{encrypt_and_upload_file};
use crate::utils::file_operations::delete_and_unpin_user_file_records_by_name;
use tauri::async_runtime::block_on;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use crate::DB_POOL;
use std::ffi::OsStr;

pub static SYNC_STATUS: once_cell::sync::Lazy<Arc<Mutex<SyncStatus>>> = once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(SyncStatus::default())));

pub fn start_folder_sync(account_id: String, seed_phrase: String) {
    let sync_path = PathBuf::from(SYNC_PATH);
    let watcher_account_id = account_id.clone();
    let watcher_seed_phrase = seed_phrase.clone();
    // Watcher thread (existing code)
    thread::spawn(move || {
        let (tx, rx) = channel();

        let mut watcher: RecommendedWatcher = Watcher::new(tx, notify::Config::default())
            .expect("[FolderSync] Failed to create watcher");

        watcher
            .watch(&sync_path, RecursiveMode::Recursive)
            .expect("[FolderSync] Failed to watch sync directory");

        for res in rx {
            match res {
                Ok(event) => handle_event(event, &watcher_account_id, &watcher_seed_phrase),
                Err(e) => eprintln!("[FolderSync] Watch error: {:?}", e),
            }
        }
    });
}

fn handle_event(event: Event, account_id: &str, seed_phrase: &str) {
    match event.kind {
        EventKind::Create(kind) => {
            for path in event.paths {
                match kind {
                    CreateKind::File => {
                        upload_file(&path, account_id, seed_phrase);
                    }
                    CreateKind::Folder => {
                        upload_folder(&path, account_id, seed_phrase);
                    }
                    _ => {}
                }
            }
        }
        EventKind::Modify(ModifyKind::Data(_)) => {
            for path in event.paths {
                // clear db and unpin, then upload
                replace_file_and_db_records(&path, account_id, seed_phrase);
            }
        }
        _ => {}
    }
}

fn upload_file(path: &Path, account_id: &str, seed_phrase: &str) {
    if !path.is_file() {
        return;
    }

    // Check if file is already in the DB
    if is_file_in_profile_db(path, account_id) {
        println!("[FolderSync] File {:?} already in profile DB, skipping upload.", path);
        return;
    }

    // Set sync status for single file
    {
        let mut status = SYNC_STATUS.lock().unwrap();
        status.total_files = 1;
        status.synced_files = 0;
        status.in_progress = true;
    }

    let file_path = path.to_string_lossy().to_string();

    // Call the async upload command in a blocking way
    let result = block_on(encrypt_and_upload_file(
        account_id.to_string(),
        file_path,
        API_URL.to_string(),
        Some(DEFAULT_K),
        Some(DEFAULT_M),
        Some(DEFAULT_CHUNK_SIZE),
        seed_phrase.to_string()
    ));

    match result {
        Ok(cid) => println!("[FolderSync] Uploaded file, metadata CID: {}", cid),
        Err(e) => eprintln!("[FolderSync] Upload failed: {}", e),
    }

    {
        let mut status = SYNC_STATUS.lock().unwrap();
        status.synced_files = 1;
        status.in_progress = false;
    }
}

fn upload_folder(folder_path: &Path, account_id: &str, seed_phrase: &str) {
    if !folder_path.is_dir() {
        return;
    }
    // Recursively walk the folder and upload each file
    let walker = fs::read_dir(folder_path);
    if let Ok(entries) = walker {
        let files: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        {
            let mut status = SYNC_STATUS.lock().unwrap();
            status.total_files = files.len();
            status.synced_files = 0;
            status.in_progress = true;
        }
        for file in files {
            upload_file(&file, account_id, seed_phrase);
            let mut status = SYNC_STATUS.lock().unwrap();
            status.synced_files += 1;
        }
        {
            let mut status = SYNC_STATUS.lock().unwrap();
            status.in_progress = false;
        }
    }
}

fn replace_file_and_db_records(path: &Path, account_id: &str, seed_phrase: &str) {
    if !path.is_file() {
        return;
    }
    // Extract file name
    let file_name = match path.file_name().map(|s| s.to_string_lossy().to_string()) {
        Some(name) => name,
        None => {
            eprintln!("[FolderSync] Could not extract file name from path: {}", path.display());
            return;
        }
    };
    // Delete and unpin old records
    let delete_result = block_on(delete_and_unpin_user_file_records_by_name(&file_name, &seed_phrase));
    if delete_result.is_ok() {
        // Upload the file only if delete succeeded
        upload_file(path, account_id, seed_phrase);
    } else {
        eprintln!("[FolderSync] Failed to delete/unpin old records for '{}', skipping upload.", file_name);
    }
}

// Helper to recursively collect files
fn collect_files_recursively(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                files.push(path);
            } else if path.is_dir() {
                collect_files_recursively(&path, files);
            }
        }
    }
}

fn is_file_in_profile_db(file_path: &Path, account_id: &str) -> bool {
    // Extract file name as string
    let file_name = match file_path.file_name().and_then(OsStr::to_str) {
        Some(name) => name,
        None => return false,
    };

    // Get the DB pool
    let pool = match DB_POOL.get() {
        Some(pool) => pool,
        None => return false,
    };

    // Run the query in a blocking context
    let found = tauri::async_runtime::block_on(async {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT 1 FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(file_name)
        .fetch_optional(pool)
        .await
    });

    if matches!(found, Ok(Some(_))) {
        // Update the source column to the sync folder path for this file
        let file_path_str = file_path.to_string_lossy().to_string();
        let _ = tauri::async_runtime::block_on(async {
            sqlx::query(
                "UPDATE user_profiles SET source = ? WHERE owner = ? AND file_name = ?"
            )
            .bind(&file_path_str)
            .bind(account_id)
            .bind(file_name)
            .execute(pool)
            .await
        });
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn start_folder_sync_tauri(account_id: String, seed_phrase: String) {
    start_folder_sync(account_id, seed_phrase);
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