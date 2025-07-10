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
use once_cell::sync::Lazy;
use std::collections::HashSet;

pub static SYNC_STATUS: once_cell::sync::Lazy<Arc<Mutex<SyncStatus>>> = once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(SyncStatus::default())));

pub static UPLOAD_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

// Track files currently being uploaded to prevent duplicates
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> = Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track which accounts are already syncing to prevent duplicates
pub static SYNCING_ACCOUNTS: Lazy<Arc<Mutex<HashSet<String>>>> = Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track recently uploaded files to prevent immediate re-processing
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> = Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

pub fn start_folder_sync(account_id: String, seed_phrase: String) {
    // Check if this account is already syncing
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&account_id) {
            println!("[FolderSync] Account {} is already syncing, skipping.", account_id);
            return;
        }
        syncing_accounts.insert(account_id.clone());
    }
    
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

    // Periodic checker thread
    let sync_path_clone = PathBuf::from(SYNC_PATH);
    let checker_account_id = account_id;
    let _checker_seed_phrase = seed_phrase;
    thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(120)); // 2 minutes

            println!("[FolderSync] Periodic check: scanning for unsynced files...");

            // Recursively collect all files in sync_path_clone
            let mut files_to_check = Vec::new();
            collect_files_recursively(&sync_path_clone, &mut files_to_check);

            for file_path in files_to_check {
                // Check if file is already being uploaded
                let file_path_str = file_path.to_string_lossy().to_string();
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&file_path_str) {
                        println!("[FolderSync] File {:?} is being uploaded, skipping periodic check.", file_path);
                        continue;
                    }
                }
                
                // Check if file was recently uploaded
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) {
                        println!("[FolderSync] File {:?} was recently uploaded, skipping periodic check.", file_path);
                        continue;
                    }
                }
                
                // Check if file is in profile DB and update source
                let _ = is_file_in_profile_db(&file_path, &checker_account_id);
            }
        }
    });
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

fn handle_event(event: Event, account_id: &str, seed_phrase: &str) {
    match event.kind {
        EventKind::Create(kind) => {
            for path in event.paths {
                // Check if file was recently uploaded
                let file_path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) {
                        println!("[FolderSync] File {:?} was recently uploaded, skipping event.", path);
                        continue;
                    }
                }
                
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
                // Check if file was recently uploaded
                let file_path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) {
                        println!("[FolderSync] File {:?} was recently uploaded, skipping modification event.", path);
                        continue;
                    }
                }
                
                // clear db and unpin, then upload
                replace_file_and_db_records(&path, account_id, seed_phrase);
            }
        }
        _ => {}
    }
}

fn upload_file(path: &Path, account_id: &str, seed_phrase: &str) -> bool {
    if !path.is_file() {
        return false;
    }

    let file_path_str = path.to_string_lossy().to_string();
    
    // Check if file is already being uploaded
    {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        if uploading_files.contains(&file_path_str) {
            println!("[FolderSync] File {:?} is already being uploaded, skipping.", path);
            return false;
        }
        uploading_files.insert(file_path_str.clone());
    }

    // Check if file is already in the DB
    if is_file_in_profile_db(path, account_id) {
        println!("[FolderSync] File {:?} already in profile, skipping upload.", path);
        // Remove from uploading set
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&file_path_str);
        return false;
    }

    // Acquire the lock before uploading
    let _guard = UPLOAD_LOCK.lock().unwrap();

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
        Ok(res) => {
            println!();
            println!("Uploaded file: {}", res);
            println!();
            {
                let mut status = SYNC_STATUS.lock().unwrap();
                status.synced_files = 1;
                status.in_progress = false;
            }

            // Remove from uploading set
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&file_path_str);
            
            // Add to recently uploaded set to prevent immediate re-processing
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            recently_uploaded.insert(file_path_str.clone());
            
            // Remove from recently uploaded set after 2 seconds
            let file_path_str_clone = file_path_str.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                recently_uploaded.remove(&file_path_str_clone);
            });
            
            return true;
        },
        Err(e) => {
            eprintln!("Upload failed: {}", e);
            {
                let mut status = SYNC_STATUS.lock().unwrap();
                status.synced_files = 1;
                status.in_progress = false;
            }

            // Remove from uploading set
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&file_path_str);
            return false;
        }
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
            let upload_success = upload_file(&file, account_id, seed_phrase);
            if upload_success {
                let mut status = SYNC_STATUS.lock().unwrap();
                status.synced_files += 1;
            }
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
    
    let file_path_str = path.to_string_lossy().to_string();
    
    // Check if file is already being uploaded
    {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        if uploading_files.contains(&file_path_str) {
            println!("[FolderSync] File {:?} is already being uploaded, skipping replace.", path);
            return;
        }
        uploading_files.insert(file_path_str.clone());
    }
    
    // Extract file name
    let file_name = match path.file_name().map(|s| s.to_string_lossy().to_string()) {
        Some(name) => name,
        None => {
            eprintln!("[FolderSync] Could not extract file name from path: {}", path.display());
            // Remove from uploading set
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&file_path_str);
            return;
        }
    };
    
    println!("[FolderSync] Replacing file: {}", file_name);
    
    // First upload the new file
    let upload_result = upload_file(path, account_id, seed_phrase);
    
    // Only delete/unpin old records if upload was successful
    if upload_result {
        println!("[FolderSync] Upload successful for '{}', now cleaning up old records...", file_name);
        let delete_result = block_on(delete_and_unpin_user_file_records_by_name(&file_name, &seed_phrase));
        if delete_result.is_err() {
            eprintln!("[FolderSync] Failed to delete/unpin old records for '{}', but upload succeeded.", file_name);
        } else {
            println!("[FolderSync] Successfully cleaned up old records for '{}'", file_name);
        }
    } else {
        eprintln!("[FolderSync] Upload failed for '{}', skipping delete/unpin.", file_name);
        // Remove from uploading set since upload failed
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&file_path_str);
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