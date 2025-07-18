use crate::commands::ipfs_commands::encrypt_and_upload_file;
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use crate::constants::ipfs::API_URL;
use crate::utils::sync::get_private_sync_path;
use crate::utils::file_operations::delete_and_unpin_user_file_records_by_name;
use crate::DB_POOL;
use notify::{
    event::CreateKind, event::ModifyKind, Event, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use once_cell::sync::Lazy;
use once_cell::sync::OnceCell;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::async_runtime::block_on;
use tokio::sync::mpsc;
use std::sync::atomic::{AtomicBool, Ordering};
use sqlx::Row;

pub static SYNC_STATUS: once_cell::sync::Lazy<Arc<Mutex<SyncStatus>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(SyncStatus::default())));

pub static UPLOAD_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

// Track files currently being uploaded to prevent duplicates
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track which accounts are already syncing to prevent duplicates
pub static SYNCING_ACCOUNTS: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track recently uploaded files to prevent immediate re-processing
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
use tauri::{AppHandle, Wry};
// Debounce state for batching create events
static CREATE_BATCH: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
static CREATE_BATCH_TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct UploadJob {
    pub account_id: String,
    pub seed_phrase: String,
    pub file_path: String,
}

static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();

pub async fn start_folder_sync(account_id: String, seed_phrase: String) {
    println!("started sycn");
    // Check if this account is already syncing
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&account_id) {
            println!(
                "[FolderSync] Account {} is already syncing, skipping.",
                account_id
            );
            return;
        }
        syncing_accounts.insert(account_id.clone());
    }

    // Set up the upload queue and worker if not already started
    if UPLOAD_SENDER.get().is_none() {
        let (tx, mut rx) = mpsc::unbounded_channel::<UploadJob>();
        UPLOAD_SENDER.set(tx).ok();
        let _account_id = account_id.clone();
        let _seed_phrase = seed_phrase.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(job) = rx.recv().await {
                let file_path_str = job.file_path.clone();
                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&file_path_str) {
                        println!(
                            "[UploadWorker] File {} is already being uploaded, skipping.",
                            file_path_str
                        );
                        continue;
                    }
                    uploading_files.insert(file_path_str.clone());
                }

                let result = encrypt_and_upload_file(
                    job.account_id.clone(),
                    job.file_path.clone(),
                    job.seed_phrase.clone(),
                )
                .await;

                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    uploading_files.remove(&file_path_str);
                }
                {
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.insert(file_path_str.clone());
                }

                // Update sync status after upload (success or error)
                {
                    let mut status = SYNC_STATUS.lock().unwrap();
                    status.synced_files += 1;
                    println!("[DEBUG] Synced files: {} / {}", status.synced_files, status.total_files);
                    if status.synced_files == status.total_files {
                        status.in_progress = false;
                    }
                }

                // Remove from recently uploaded after 2 seconds
                let file_path_str_clone = file_path_str.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.remove(&file_path_str_clone);
                });

                tokio::time::sleep(Duration::from_secs(6)).await;
            }
        });
    }

    if let Some(pool) = crate::DB_POOL.get() {
        println!("getting sync path ");
        let sync_path = PathBuf::from(&get_private_sync_path().await);
        println!("got synced path ");
        let mut files = Vec::new();
        collect_files_recursively(&sync_path, &mut files);
        let dir_files: HashSet<String> = files.iter()
            .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
            .collect();
        let db_files: Vec<String> = sqlx::query_scalar::<_, String>(
            "SELECT file_name FROM sync_folder_files WHERE owner = ?"
        )
        .bind(&account_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        // Handle deleted files (in DB, not in folder)
        for db_file in &db_files {
            if !dir_files.contains(db_file) {
                println!("[Startup] File deleted from sync folder: {}", db_file);
                // Call delete_and_unpin and delete from sync_folder_files
                let result = delete_and_unpin_user_file_records_by_name(db_file, &seed_phrase).await;
                if result.is_ok() {
                    let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ?")
                        .bind(&account_id)
                        .bind(db_file)
                        .execute(pool)
                        .await;
                }
            }
        }
        // Handle new files (in folder, not in DB)
        let mut new_files_to_upload = Vec::new();
        for file_path in &files {
            let file_name = file_path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
            if let Some(file_name) = file_name {
                if !db_files.contains(&file_name) {
                    println!("[Startup] New file detected in sync folder: {}", file_name);
                    // Add to upload queue
                    if let Some(sender) = UPLOAD_SENDER.get() {
                        sender
                            .send(UploadJob {
                                account_id: account_id.clone(),
                                seed_phrase: seed_phrase.clone(),
                                file_path: file_path.to_string_lossy().to_string(),
                            })
                            .unwrap();
                    }
                    new_files_to_upload.push(file_path.clone());
                }
            }
        }
        // Set sync status for startup new files
        if !new_files_to_upload.is_empty() {
            let mut status = SYNC_STATUS.lock().unwrap();
            status.total_files = new_files_to_upload.len();
            status.synced_files = 0;
            status.in_progress = true;
        }
    }

    let sync_path = PathBuf::from(&get_private_sync_path().await);
    let watcher_account_id = account_id.clone();
    let watcher_seed_phrase = seed_phrase.clone();
    // Watcher thread (existing code)
    spawn_watcher_thread(account_id.clone(), seed_phrase.clone());

    // Periodic checker thread
    let checker_account_id = account_id.clone();
    let _checker_seed_phrase = seed_phrase.clone();
    thread::spawn(move || {
        loop {
            println!("[FolderSync] Periodic check: scanning for unsynced files...");

            // Always fetch the latest sync path from the DB
            let sync_path_str = tauri::async_runtime::block_on(get_private_sync_path());
            let sync_path = PathBuf::from(&sync_path_str);

            // Recursively collect all files in sync_path
            let mut files_to_check = Vec::new();
            collect_files_recursively(&sync_path, &mut files_to_check);

            for file_path in files_to_check {
                // Check if file is already being uploaded
                let file_path_str = file_path.to_string_lossy().to_string();
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&file_path_str) {
                        println!(
                            "[FolderSync] File {:?} is being uploaded, skipping periodic check.",
                            file_path
                        );
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

            std::thread::sleep(Duration::from_secs(120)); // 2 minutes
        }
    });
}

fn spawn_watcher_thread(account_id: String, seed_phrase: String) {
    thread::spawn(move || {
        let mut current_path = String::new();
        let mut watcher: Option<RecommendedWatcher> = None;
        let (stop_tx, stop_rx): (Sender<()>, Receiver<()>) = channel();

        loop {
            // Get the latest sync path
            let sync_path_str = tauri::async_runtime::block_on(get_private_sync_path());

            if sync_path_str != current_path {
                // Path changed, stop old watcher if exists
                if let Some(mut w) = watcher.take() {
                    // Dropping the watcher stops it
                    drop(w);
                    println!("[FolderSync] Stopped watching old path: {}", current_path);
                }

                // Start new watcher
                let (tx, rx) = channel();
                let mut new_watcher: RecommendedWatcher =
                    Watcher::new(tx, notify::Config::default())
                        .expect("[FolderSync] Failed to create watcher");

                new_watcher
                    .watch(Path::new(&sync_path_str), RecursiveMode::Recursive)
                    .expect("[FolderSync] Failed to watch sync directory");

                let watcher_account_id = account_id.clone();
                let watcher_seed_phrase = seed_phrase.clone();

                // Spawn a thread to handle events for this watcher
                thread::spawn(move || {
                    for res in rx {
                        match res {
                            Ok(event) => handle_event(event, &watcher_account_id, &watcher_seed_phrase),
                            Err(e) => eprintln!("[FolderSync] Watch error: {:?}", e),
                        }
                    }
                });

                println!("[FolderSync] Started watching new path: {}", sync_path_str);
                current_path = sync_path_str;
                watcher = Some(new_watcher);
            }

            // Check for path changes every 5 seconds
            thread::sleep(Duration::from_secs(5));
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
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            // Add all paths to the batch
            for path in event.paths {
                // Check if file was recently uploaded
                let file_path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) {
                        continue;
                    }
                }
                CREATE_BATCH.lock().unwrap().push(path.clone());
            }
            // Start debounce timer if not already running
            if !CREATE_BATCH_TIMER_RUNNING.swap(true, Ordering::SeqCst) {
                let account_id = account_id.to_string();
                let seed_phrase = seed_phrase.to_string();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(200));
                    let mut files = Vec::new();
                    {
                        let mut batch = CREATE_BATCH.lock().unwrap();
                        for path in batch.drain(..) {
                            if path.is_file() {
                                files.push(path.clone());
                            } else if path.is_dir() {
                                collect_files_recursively(&path, &mut files);
                            }
                        }
                    }

                    if !files.is_empty() {
                        // Set sync status for the batch
                        {
                            let mut status = SYNC_STATUS.lock().unwrap();
                            status.total_files = files.len();
                            status.synced_files = 0;
                            status.in_progress = true;
                        }
                        // Enqueue each file for upload
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            for file_path in files {
                                sender
                                    .send(UploadJob {
                                        account_id: account_id.clone(),
                                        seed_phrase: seed_phrase.clone(),
                                        file_path: file_path.to_string_lossy().to_string(),
                                    })
                                    .unwrap();
                            }
                        }
                    }
                    CREATE_BATCH_TIMER_RUNNING.store(false, Ordering::SeqCst);
                });
            }
        }
        EventKind::Modify(ModifyKind::Data(_)) => {
            for path in event.paths {
                // Check if file was recently uploaded
                let file_path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) {
                        continue;
                    }
                }
                // clear db and unpin, then upload
                replace_file_and_db_records(&path, account_id, seed_phrase);
            }
        }
        EventKind::Modify(ModifyKind::Name(_)) => {
            if event.paths.len() == 2 {
                let old_path = &event.paths[0];
                let new_path = &event.paths[1];
        
                // Handle deletion for old_path
                if let Some(file_name) = old_path.file_name().and_then(|s| s.to_str()) {
                    println!("[Watcher] File renamed, deleting old file records: {}", file_name);
                    let result = tauri::async_runtime::block_on(delete_and_unpin_user_file_records_by_name(file_name, seed_phrase));
                    if result.is_ok() {
                        if let Some(pool) = crate::DB_POOL.get() {
                            let _ = tauri::async_runtime::block_on(async {
                                sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ?")
                                    .bind(account_id)
                                    .bind(file_name)
                                    .execute(pool)
                                    .await
                            });
                            println!("[Watcher] Successfully deleted old file records for '{}'", file_name);
                        }
                    } else {
                        eprintln!("[Watcher] Failed to delete/unpin old file records for '{}'", file_name);
                    }
                }
        
                // Handle creation for new_path
                if new_path.is_file() {
                    let file_path_str = new_path.to_string_lossy().to_string();
                    // Check if file was recently uploaded to avoid immediate re-processing
                    {
                        let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        if recently_uploaded.contains(&file_path_str) {
                            println!("[Watcher] File {} was recently uploaded, skipping.", file_path_str);
                            return;
                        }
                    }
                    // Check if file is already being uploaded
                    {
                        let uploading_files = UPLOADING_FILES.lock().unwrap();
                        if uploading_files.contains(&file_path_str) {
                            println!("[Watcher] File {} is already being uploaded, skipping.", file_path_str);
                            return;
                        }
                    }
                    // Enqueue the new file for upload
                    if let Some(sender) = UPLOAD_SENDER.get() {
                        sender
                            .send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: file_path_str.clone(),
                            })
                            .unwrap();
                        println!("[Watcher] Enqueued new file for upload: {}", file_path_str);
                    }
                }
            } else {
                // Fallback for single-path rename events (e.g., file moved out of sync folder)
                for path in event.paths {
                    if !path.exists() {
                        if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                            println!("[Watcher] File deleted (via rename/move) from sync folder: {}", file_name);
                            let result = tauri::async_runtime::block_on(delete_and_unpin_user_file_records_by_name(file_name, seed_phrase));
                            if result.is_ok() {
                                if let Some(pool) = crate::DB_POOL.get() {
                                    let _ = tauri::async_runtime::block_on(async {
                                        sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ?")
                                            .bind(account_id)
                                            .bind(file_name)
                                            .execute(pool)
                                            .await
                                    });
                                    println!("[Watcher] Successfully deleted file records for '{}'", file_name);
                                }
                            } else {
                                eprintln!("[Watcher] Failed to delete/unpin file records for '{}'", file_name);
                            }
                        }
                    }
                }
            }
        }
        EventKind::Remove(_) => {
            for path in event.paths {
                let file_name = path.file_name().and_then(|s| s.to_str());
                if let Some(file_name) = file_name {
                    println!("[Watcher] File deleted from sync folder: {}", file_name);
                    // Delete from sync_folder_files and call delete_and_unpin
                    let result = tauri::async_runtime::block_on(delete_and_unpin_user_file_records_by_name(file_name, seed_phrase));
                    if result.is_ok() {
                        if let Some(pool) = crate::DB_POOL.get() {
                            let _ = tauri::async_runtime::block_on(async {
                                sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ?")
                                    .bind(file_name)
                                    .execute(pool)
                                    .await
                            });
                        }
                    }
                }
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
            return false;
        }
        uploading_files.insert(file_path_str.clone());
    }

    // Check if file is already in the DB
    if is_file_in_profile_db(path, account_id) {
        // Remove from uploading set
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&file_path_str);
        return false;
    }

    // Acquire the lock before uploading
    let _guard = UPLOAD_LOCK.lock().unwrap();

    let file_path = path.to_string_lossy().to_string();

    // Call the async upload command in a blocking way
    let result = block_on(encrypt_and_upload_file(
        account_id.to_string(),
        file_path,
        seed_phrase.to_string(),
    ));

    match result {
        Ok(res) => {
            println!();
            println!("Uploaded file: {}", res);
            println!();

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
            
            // Insert into DB if not exists
            if let Some(pool) = crate::DB_POOL.get() {
                insert_file_if_not_exists(pool, path, account_id);
            }

            return true;
        }
        Err(e) => {
            eprintln!("Upload failed: {}", e);

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
    let walker = fs::read_dir(folder_path);
    if let Ok(entries) = walker {
        let files: Vec<_> = entries.flatten().filter(|e| e.path().is_file()).collect();
        for entry in files.into_iter() {
            let path = entry.path();
            // Enqueue each file for upload
            if let Some(sender) = UPLOAD_SENDER.get() {
                sender
                    .send(UploadJob {
                        account_id: account_id.to_string(),
                        seed_phrase: seed_phrase.to_string(),
                        file_path: path.to_string_lossy().to_string(),
                    })
                    .unwrap();
            }
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
            println!(
                "[FolderSync] File {:?} is already being uploaded, skipping replace.",
                path
            );
            return;
        }
        uploading_files.insert(file_path_str.clone());
    }

    // Extract file name
    let file_name = match path.file_name().map(|s| s.to_string_lossy().to_string()) {
        Some(name) => name,
        None => {
            eprintln!(
                "[FolderSync] Could not extract file name from path: {}",
                path.display()
            );
            // Remove from uploading set
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&file_path_str);
            return;
        }
    };

    // Only upload if file exists in user_profiles and is_assigned is true
    let should_upload = {
        if let Some(pool) = crate::DB_POOL.get() {
            let row: Option<(bool,)> = tauri::async_runtime::block_on(async {
                sqlx::query_as(
                    "SELECT is_assigned FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
                )
                .bind(account_id)
                .bind(&file_name)
                .fetch_optional(pool)
                .await
            }).unwrap_or(None);
            match row {
                Some((is_assigned,)) if is_assigned => true,
                _ => false,
            }
        } else {
            false
        }
    };
    if !should_upload {
        println!("[FolderSync] Skipping upload: file '{}' is not assigned or not found in user_profiles.", file_name);
        // Remove from uploading set
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&file_path_str);
        return;
    }

    println!("[FolderSync] Replacing file: {}", file_name);

    // First upload the new file
    let upload_result = upload_file(path, account_id, seed_phrase);

    // Only delete/unpin old records if upload was successful
    if upload_result {
        println!(
            "[FolderSync] Upload successful for '{}', now cleaning up old records...",
            file_name
        );
        let delete_result = block_on(delete_and_unpin_user_file_records_by_name(
            &file_name,
            &seed_phrase,
        ));
        if delete_result.is_err() {
            eprintln!(
                "[FolderSync] Failed to delete/unpin old records for '{}', but upload succeeded.",
                file_name
            );
        } else {
            println!(
                "[FolderSync] Successfully cleaned up old records for '{}'",
                file_name
            );
        }
    } else {
        eprintln!(
            "[FolderSync] Upload failed for '{}', skipping delete/unpin.",
            file_name
        );
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
            "SELECT 1 FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1",
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
            sqlx::query("UPDATE user_profiles SET source = ? WHERE owner = ? AND file_name = ?")
                .bind(&file_path_str)
                .bind(account_id)
                .bind(file_name)
                .execute(pool)
                .await
        });
        // Also set is_assigned = 1 in sync_folder_files
        let _ = tauri::async_runtime::block_on(async {
            sqlx::query("UPDATE sync_folder_files SET is_assigned = 1 WHERE owner = ? AND file_name = ?")
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

pub async fn insert_file_if_not_exists(pool: &sqlx::SqlitePool, file_path: &Path, owner: &str) {
    let file_name = file_path.file_name().unwrap().to_string_lossy();
    let exists: Option<(String,)> = sqlx::query_as("SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ?")
        .bind(&file_name)
        .bind(owner)
        .fetch_optional(pool)
        .await
        .unwrap();
    if exists.is_none() {
        sqlx::query(
            "INSERT INTO sync_folder_files (
                file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, main_req_hash, selected_validator, total_replicas, block_number, profile_cid, source, miner_ids
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        .execute(pool)
        .await
        .unwrap();
    }
}

#[tauri::command]
pub async fn start_folder_sync_tauri(account_id: String, seed_phrase: String) {
    start_folder_sync(account_id, seed_phrase).await;
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