use crate::commands::ipfs_commands::{encrypt_and_upload_file_sync, encrypt_and_upload_folder_sync};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use crate::utils::sync::get_private_sync_path;
use crate::utils::file_operations::delete_and_unpin_user_file_records_by_name;
use crate::DB_POOL;
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind}, Event, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use once_cell::sync::OnceCell;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio::sync::mpsc;
use std::sync::atomic::{AtomicBool, Ordering};
pub use crate::sync_shared::{SYNCING_ACCOUNTS, find_top_level_folder, UPLOAD_LOCK, UploadJob, insert_file_if_not_exists, PRIVATE_SYNC_STATUS};
use once_cell::sync::Lazy;
use tauri::AppHandle;

// Module-specific state
pub static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static CREATE_BATCH: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
pub static CREATE_BATCH_TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

pub async fn start_folder_sync(app_handle: AppHandle, account_id: String, seed_phrase: String) {
    let mut is_initial_startup = true;
    loop {
        {
            let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
            if syncing_accounts.contains(&(account_id.clone(), "private")) {
                println!("[PrivateFolderSync] Account {} is already syncing, skipping.", account_id);
                return;
            }
            syncing_accounts.insert((account_id.clone(), "private"));
        }

        let (path_change_tx, mut path_change_rx) = mpsc::channel::<String>(100);
        let cancel_token = Arc::new(AtomicBool::new(false));

        let sync_path_result = get_private_sync_path().await;
        println!("[PrivateFolderSync] private sync path result: {:?}", sync_path_result);
        if let Ok(sync_path) = sync_path_result {
            println!("[PrivateFolderSync] private sync path found: {}, starting sync process", sync_path);
            start_sync_process(
                app_handle.clone(),
                account_id.clone(),
                seed_phrase.clone(),
                sync_path,
                Arc::clone(&cancel_token),
                path_change_tx.clone(),
                is_initial_startup,
            ).await;
        } else {
            eprintln!("[PrivateFolderSync] Failed to get private sync path: {:?}", sync_path_result.err());
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "private"));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }

        let account_id_clone = account_id.clone();
        let cancel_token_clone = Arc::clone(&cancel_token);
        tokio::spawn(async move {
            if let Some(new_sync_path) = path_change_rx.recv().await {
                println!("[PrivateFolderSync] Received path change to: {}. Stopping current sync.", new_sync_path);
                cancel_token_clone.store(true, Ordering::SeqCst);
                {
                    let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                    syncing_accounts.remove(&(account_id_clone, "private"));
                }
                // Clear pending upload jobs and reset state
                if let Some(sender) = UPLOAD_SENDER.get() {
                    drop(sender); // Close the sender to clear the channel
                    UPLOAD_SENDER.set(mpsc::unbounded_channel().0).ok();
                }
                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    uploading_files.clear();
                }
                {
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.clear();
                }
                {
                    let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                    *status = SyncStatus::default();
                }
            } else {
                println!("[PrivateFolderSync] Path change channel closed, stopping sync for account {}.", account_id_clone);
                cancel_token_clone.store(true, Ordering::SeqCst);
                {
                    let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                    syncing_accounts.remove(&(account_id_clone, "private"));
                }
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                *status = SyncStatus::default();
            }
        });

        // Set to false after the first startup
        is_initial_startup = false;

        while !cancel_token.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

async fn start_sync_process(
    app_handle: AppHandle,
    account_id: String,
    seed_phrase: String,
    sync_path: String,
    cancel_token: Arc<AtomicBool>,
    path_change_tx: mpsc::Sender<String>,
    is_initial_startup: bool,
) {
    // Clone app_handle for the worker thread
    let worker_app_handle = app_handle.clone();

    if UPLOAD_SENDER.get().is_none() {
        let (tx, mut rx) = mpsc::unbounded_channel::<UploadJob>();
        UPLOAD_SENDER.set(tx).ok();
        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                let path_str = job.file_path.clone();
                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PrivateUploadWorker] Path {} is already uploading, skipping.", path_str);
                        // Increment processed_files even for skipped uploads
                        let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                        status.processed_files += 1;
                        if status.processed_files >= status.total_files && status.total_files > 0 {
                            status.in_progress = false;
                            println!("[PrivateFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                        }
                        continue;
                    }
                    uploading_files.insert(path_str.clone());
                }

                // Retry logic for failed uploads
                const MAX_RETRIES: usize = 3;
                let mut success = false;
                let mut last_error = None;
                for attempt in 1..=MAX_RETRIES {
                    // Check if file/folder already exists in DB to avoid unnecessary uploads
                    if let Some(pool) = crate::DB_POOL.get() {
                        let file_name = Path::new(&job.file_path)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("");
                        let is_synced: Option<(String,)> = match sqlx::query_as::<_, (String,)>(
                            "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = 'private'"
                        )
                        .bind(&file_name)
                        .bind(&job.account_id)
                        .fetch_optional(pool)
                        .await
                        {
                            Ok(result) => result,
                            Err(e) => {
                                eprintln!("[PrivateUploadWorker] DB error while checking sync status for '{}': {}", file_name, e);
                                None
                            }
                        };
                            
                         
                        if is_synced.is_some() {
                            println!("[PrivateUploadWorker] Path '{}' already exists in sync DB, marking as successful.", file_name);
                            success = true;
                            break;
                        }
                    }

                    let result = if job.is_folder {
                        encrypt_and_upload_folder_sync(
                            worker_app_handle.clone(),
                            job.account_id.clone(),
                            job.file_path.clone(),
                            job.seed_phrase.clone(),
                            None
                        ).await
                    } else {
                        encrypt_and_upload_file_sync(
                            worker_app_handle.clone(),
                            job.account_id.clone(),
                            job.file_path.clone(),
                            job.seed_phrase.clone(),
                            None
                        ).await
                    };

                    if result.is_ok() {
                        success = true;
                        break;
                    } else {
                        last_error = Some(result.err().unwrap());
                        eprintln!("[PrivateUploadWorker] Upload attempt {} failed for {}: {:?}", attempt, path_str, last_error);
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }

                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    uploading_files.remove(&path_str);
                }

                {
                    let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                    status.processed_files += 1; // Always increment processed_files
                    if success {
                        status.synced_files += 1;
                        println!("[PrivateFolderSync] Synced paths: {} / {} (Processed: {})", status.synced_files, status.total_files, status.processed_files);
                        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        recently_uploaded.insert(path_str.clone());
                    } else {
                        eprintln!("[PrivateUploadWorker] Gave up upload after {} attempts for {}: {:?}", MAX_RETRIES, path_str, last_error);
                    }

                    if status.processed_files >= status.total_files && status.total_files > 0 {
                        status.in_progress = false;
                        println!("[PrivateFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                    }
                }

                if success {
                    let path_str_clone = path_str.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(300)).await;
                        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        recently_uploaded.remove(&path_str_clone);
                    });
                }
            }
        });
    }

    if is_initial_startup {
        let startup_account_id = account_id.clone();
        let startup_seed_phrase = seed_phrase.clone();
        let sync_path_cloned = sync_path.clone();
        tokio::spawn(async move {
            let pool = match crate::DB_POOL.get() {
                Some(pool) => pool,
                None => {
                    eprintln!("[PrivateStartup] DB_POOL not initialized, cannot proceed with sync.");
                    return;
                }
            };

            let sync_path_buf = PathBuf::from(&sync_path_cloned);
            let mut paths = Vec::new();
            collect_paths_recursively(&sync_path_buf, &mut paths);
            let mut folder_paths = HashSet::new();
            let mut file_paths = Vec::new();

            for path in paths {
                if path.is_dir() {
                    folder_paths.insert(path.clone());
                } else if !folder_paths.iter().any(|folder| path.starts_with(folder) && path != *folder) {
                    file_paths.push(path);
                }
            }

            let dir_paths: HashSet<String> = folder_paths
                .iter()
                .chain(file_paths.iter())
                .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
                .collect();

            // Fetch all paths from sync_folder_files
            let db_paths: Vec<(String, bool)> = match sqlx::query_as(
                "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'private'"
            )
            .bind(&startup_account_id)
            .fetch_all(pool)
            .await
            {
                Ok(paths) => paths,
                Err(e) => {
                    eprintln!("[PrivateStartup] Failed to fetch sync_folder_files: {}", e);
                    Vec::new()
                }
            };

            // Delete paths that no longer exist
            for (db_path, is_folder) in &db_paths {
                if !dir_paths.contains(db_path) {
                    println!("[PrivateStartup] Path deleted from sync folder: {} (is_folder: {})", db_path, is_folder);
                    let should_delete_folder = false;
                    match delete_and_unpin_user_file_records_by_name(db_path, &startup_seed_phrase, false, should_delete_folder).await {
                        Ok(_) => {
                            if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                                .bind(&startup_account_id)
                                .bind(db_path)
                                .execute(pool)
                                .await
                            {
                                eprintln!("[PrivateStartup] Failed to delete sync_folder_files record for '{}': {}", db_path, e);
                            } else {
                                println!("[PrivateStartup] Successfully deleted sync_folder_files record for '{}'", db_path);
                            }
                        }
                        Err(e) => eprintln!("[PrivateStartup] Failed to delete/unpin records for '{}': {}", db_path, e),
                    }
                }
            }

            let mut new_paths_to_upload = Vec::new();
            let mut unique_paths = HashSet::new();
            for path in folder_paths.into_iter().chain(file_paths.into_iter()) {
                let file_name = match path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) {
                    Some(name) => name,
                    None => {
                        eprintln!("[PrivateStartup] Could not extract file name from path: {}", path.to_string_lossy());
                        continue;
                    }
                };

                let path_str = path.to_string_lossy().to_string();
                if !unique_paths.insert(path_str.clone()) {
                    println!("[PrivateStartup] Duplicate path detected, skipping: {}", path_str);
                    continue;
                }

                // Skip if already in sync DB
                println!("just checking {:?} for account {}", file_name, startup_account_id);
                let is_synced: Option<(String,)> = match sqlx::query_as(
                    "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
                )
                .bind(&file_name)
                .bind(&startup_account_id)
                .bind("private")
                .fetch_optional(pool)
                .await
                {
                    Ok(result) => result,
                    Err(e) => {
                        eprintln!("[PrivateStartup] DB error while checking sync status for '{}': {}", file_name, e);
                        None
                    }
                };
                
               
                if is_synced.is_some() {
                    println!("[PrivateStartup] Path '{}' is already in sync DB, marking as processed.", file_name);
                    let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                    status.processed_files += 1;
                    status.synced_files += 1;
                    if status.processed_files >= status.total_files && status.total_files > 0 {
                        status.in_progress = false;
                        println!("[PrivateFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                    }
                    continue;
                }

                // Skip if recently uploaded or uploading
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PrivateStartup] Skipping recently uploaded: {}", path_str);
                        let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                        status.processed_files += 1;
                        status.synced_files += 1;
                        if status.processed_files >= status.total_files && status.total_files > 0 {
                            status.in_progress = false;
                            println!("[PrivateFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                        }
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PrivateStartup] Path {} is already uploading, skipping.", path_str);
                        continue;
                    }
                }

                println!("[PrivateStartup] New path detected in sync folder: {} (is_folder: {})", file_name, path.is_dir());
                if let Some(sender) = UPLOAD_SENDER.get() {
                    if let Err(e) = sender.send(UploadJob {
                        account_id: startup_account_id.clone(),
                        seed_phrase: startup_seed_phrase.clone(),
                        file_path: path_str,
                        is_folder: path.is_dir(),
                    }) {
                        eprintln!("[PrivateStartup] Failed to enqueue upload for '{}': {}", file_name, e);
                        // Increment processed_files on enqueue failure
                        let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                        status.processed_files += 1;
                        if status.processed_files >= status.total_files && status.total_files > 0 {
                            status.in_progress = false;
                            println!("[PrivateFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                        }
                    } else {
                        new_paths_to_upload.push(path.clone());
                    }
                }
            }

            if !new_paths_to_upload.is_empty() {
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                status.total_files = new_paths_to_upload.len();
                status.synced_files = 0;
                status.processed_files = 0;
                status.in_progress = true;
                println!("[PrivateStartup] Set total_files to {} for new paths", status.total_files);
            } else {
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                status.in_progress = false;
                status.total_files = 0;
                status.processed_files = 0;
                status.synced_files = 0;
                println!("[PrivateStartup] No new paths to upload, sync complete.");
            }
        });
    }
    else {
        // Handle sync path change: clean up sync_folder_files and upload new files/folders
        let sync_account_id = account_id.clone();
        let sync_seed_phrase = seed_phrase.clone();
        let sync_path_cloned = sync_path.clone();
        tokio::spawn(async move {
            let pool = match crate::DB_POOL.get() {
                Some(pool) => pool,
                None => {
                    eprintln!("[PrivateSyncPathChange] DB_POOL not initialized, cannot proceed with sync.");
                    return;
                }
            };

            // Delete all private sync_folder_files records with a single query
            println!("[PrivateSyncPathChange] Deleting all private sync_folder_files records for account {}", sync_account_id);
            match sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND type = 'private'")
                .bind(&sync_account_id)
                .execute(pool)
                .await
            {
                Ok(result) => {
                    println!("[PrivateSyncPathChange] Successfully deleted {} private sync_folder_files records", result.rows_affected());
                }
                Err(e) => {
                    eprintln!("[PrivateSyncPathChange] Failed to delete private sync_folder_files records: {}", e);
                }
            }

            // Scan new sync path for files/folders to upload
            let sync_path_buf = PathBuf::from(&sync_path_cloned);
            let mut paths = Vec::new();
            collect_paths_recursively(&sync_path_buf, &mut paths);
            let mut folder_paths = HashSet::new();
            let mut file_paths = Vec::new();

            for path in paths {
                if path.is_dir() {
                    folder_paths.insert(path.clone());
                } else if !folder_paths.iter().any(|folder| path.starts_with(folder)) {
                    file_paths.push(path);
                }
            }

            let mut new_paths_to_upload = Vec::new();
            for path in folder_paths.into_iter().chain(file_paths.into_iter()) {
                let file_name = match path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) {
                    Some(name) => name,
                    None => {
                        eprintln!("[PrivateSyncPathChange] Could not extract file name from path: {}", path.to_string_lossy());
                        continue;
                    }
                };

                let is_synced: Option<(String,)> = match sqlx::query_as(
                    "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
                )
                .bind(&file_name)
                .bind(&sync_account_id)
                .bind("private")
                .fetch_optional(pool)
                .await
                {
                    Ok(result) => result,
                    Err(e) => {
                        eprintln!(
                            "[PrivateSyncPathChange] DB error while checking sync status for '{}': {}",
                            file_name, e
                        );
                        None
                    }
                };

                if is_synced.is_some() {
                    println!("[PrivateSyncPathChange] Path '{}' is already in sync DB, skipping.", file_name);
                    continue;
                }

                println!("[PrivateSyncPathChange] New path detected in new sync folder: {} (is_folder: {})", file_name, path.is_dir());
                if let Some(sender) = UPLOAD_SENDER.get() {
                    if let Err(e) = sender.send(UploadJob {
                        account_id: sync_account_id.clone(),
                        seed_phrase: sync_seed_phrase.clone(),
                        file_path: path.to_string_lossy().to_string(),
                        is_folder: path.is_dir(),
                    }) {
                        eprintln!("[PrivateSyncPathChange] Failed to enqueue upload for '{}': {}", file_name, e);
                    } else {
                        new_paths_to_upload.push(path.clone());
                    }
                }
            }

            if !new_paths_to_upload.is_empty() {
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                status.total_files = new_paths_to_upload.len();
                status.synced_files = 0;
                status.processed_files = 0;
                status.in_progress = true;
            } else {
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                status.in_progress = false;
            }
        });
    }
    let app_handle_clone = app_handle.clone();
    spawn_watcher_thread(app_handle_clone, account_id, seed_phrase, PathBuf::from(sync_path), cancel_token, path_change_tx);
}

fn spawn_watcher_thread(
    app_handle: AppHandle,
    account_id: String,
    seed_phrase: String,
    sync_path: PathBuf,
    cancel_token: Arc<AtomicBool>,
    path_change_tx: mpsc::Sender<String>,
) {
    thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime for watcher");
        let current_path = sync_path.to_string_lossy().to_string();
        let mut watcher: Option<RecommendedWatcher> = None;

        // Create a separate clone of app_handle for the event handler thread
        let event_handler_app_handle = app_handle.clone();

        loop {
            if cancel_token.load(Ordering::SeqCst) {
                if let Some(w) = watcher.take() {
                    drop(w);
                    println!("[PrivateFolderSync] Stopped watching path: {}", current_path);
                }
                println!("[PrivateFolderSync] Watcher thread cancelled for account {}", account_id);
                break;
            }

            let latest_sync_path = match rt.block_on(get_private_sync_path()) {
                Ok(path) => PathBuf::from(path),
                Err(e) => {
                    eprintln!("[PrivateFolderSync] Failed to get private sync path: {}", e);
                    thread::sleep(Duration::from_secs(5));
                    continue;
                }
            };

            let latest_sync_path_str = latest_sync_path.to_string_lossy().to_string();
            if latest_sync_path_str != current_path {
                if rt.block_on(path_change_tx.send(latest_sync_path_str.clone())).is_ok() {
                    println!("[PrivateFolderSync] Sent path change notification: {}", latest_sync_path_str);
                } else {
                    eprintln!("[PrivateFolderSync] Failed to send path change notification");
                }
                break;
            }

            println!("[PrivateFolderSync] Periodic check: scanning for unsynced paths...");
            let mut paths_to_check = Vec::new();
            collect_paths_recursively(&sync_path, &mut paths_to_check);

            for path in paths_to_check {
                let path_str = path.to_string_lossy().to_string();
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PrivateFolderSync] Path {:?} is being uploaded, skipping periodic check.", path);
                        continue;
                    }
                }
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        continue;
                    }
                }
            }

            if watcher.is_none() && sync_path.exists() {
                let (tx, rx) = channel();
                let mut new_watcher: RecommendedWatcher = Watcher::new(tx, notify::Config::default())
                    .expect("[PrivateFolderSync] Failed to create watcher");

                new_watcher
                    .watch(&sync_path, RecursiveMode::Recursive)
                    .expect("[PrivateFolderSync] Failed to watch sync directory");

                // Clone all variables needed in the event handler
                let event_account_id = account_id.clone();
                let event_seed_phrase = seed_phrase.clone();
                let event_sync_path = sync_path.clone();

                thread::spawn({
                    let app_handle = event_handler_app_handle.clone();
                    move || {
                        let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime for watcher handler");
                        for res in rx {
                            match res {
                                Ok(event) => rt.block_on(handle_event(
                                    event, 
                                    &event_account_id, 
                                    &event_seed_phrase, 
                                    &event_sync_path, 
                                    app_handle.clone()
                                )),
                                Err(e) => eprintln!("[PrivateFolderSync] Watch error: {:?}", e),
                            }
                        }
                    }
                });

                println!("[PrivateFolderSync] Started watching private path: {}", current_path);
                watcher = Some(new_watcher);
            }

            thread::sleep(Duration::from_secs(2));
        }
    });
}

fn collect_paths_recursively(dir: &Path, paths: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if name.starts_with('.') {
                    continue; // Skip hidden files and directories
                }
            }
            // Only add direct children of the sync directory
            if path.parent().map(|p| p == dir).unwrap_or(false) {
                paths.push(path.clone());
                // Don't recurse into directories - we only want top-level items
            }
        }
    }
}

async fn handle_event(event: Event, account_id: &str, seed_phrase: &str, sync_path: &Path, app_handle: AppHandle) {
    let filtered_paths = event.paths.into_iter()
    .filter(|path| {
        // First filter out temp files
        if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
            if file_name.starts_with('.') || file_name.contains("goutputstream") {
                // Mark filtered files as processed
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                status.processed_files += 1;
                if status.processed_files >= status.total_files && status.total_files > 0 {
                    status.in_progress = false;
                    println!("[PrivateFolderSync] Filtered path marked as processed: {}", path.display());
                }
                return false;
            }
        }
        
        // Then check if it's a direct child of the sync directory
        path.parent().map(|p| p == sync_path).unwrap_or(false)
        // path.starts_with(sync_path)
    })
    .collect::<Vec<_>>();

    if filtered_paths.is_empty() {
        println!("[PrivateWatcher] Skipping event with only temporary or invalid paths.");
        return;
    }

    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            let mut folder_paths = HashSet::new();
            let mut file_paths = HashSet::new();
            println!("[PrivateWatcher][Create] Detected new paths: {:?}", filtered_paths);

            // Check sync_folder_files database for each path
            if let Some(pool) = crate::DB_POOL.get() {
                for path in filtered_paths.iter() {
                    let path_str = path.to_string_lossy().to_string();
                    let file_name = match path.file_name().and_then(|s| s.to_str()) {
                        Some(name) => name.to_string(),
                        None => {
                            println!("[PrivateWatcher][Create] Could not extract file name from path: {}", path_str);
                            continue;
                        }
                    };

                    let is_synced: Option<(String,)> = match sqlx::query_as(
                        "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
                    )
                    .bind(&file_name)
                    .bind(&account_id)
                    .bind("private")
                    .fetch_optional(pool)
                    .await
                    {
                        Ok(result) => result,
                        Err(e) => {
                            eprintln!("[PublicWatcher][Create] DB error while checking sync status for '{}': {}", file_name, e);
                            None
                        }
                    };

                    if is_synced.is_some() {
                        println!("[PrivateWatcher][Create] Path '{}' is already in sync DB, skipping.", file_name);
                        continue;
                    }

                    // Additional checks for recently uploaded or uploading files
                    {
                        let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        if recently_uploaded.contains(&path_str) {
                            println!("[PrivateWatcher][Create] Skipping recently uploaded: {}", path_str);
                            continue;
                        }
                    }
                    {
                        let uploading_files = UPLOADING_FILES.lock().unwrap();
                        if uploading_files.contains(&path_str) {
                            println!("[PrivateWatcher][Create] Path {} is already being uploaded, skipping.", path_str);
                            continue;
                        }
                    }

                    if path.is_dir() {
                        folder_paths.insert(path.clone());
                    } else if path.is_file() {
                        file_paths.insert(path.clone());
                    }
                    println!("[PrivateWatcher][Create] Detected new path: {}", path_str);
                }

                let filtered_paths: Vec<(PathBuf, bool)> = folder_paths.clone()
                    .into_iter()
                    .map(|path| (path, true))
                    .chain(
                        file_paths.into_iter().filter(|file_path| {
                            !folder_paths.iter().any(|folder_path| {
                                file_path.starts_with(folder_path) && file_path != folder_path
                            })
                        }).map(|path| (path, false))
                    )
                    .collect();

                {
                    let mut batch = CREATE_BATCH.lock().unwrap();
                    for (path, is_folder) in &filtered_paths {
                        println!("[PrivateWatcher][Create] Adding to batch: {} (is_folder: {})", path.to_string_lossy(), is_folder);
                        batch.push(path.clone());
                    }
                }

                if !CREATE_BATCH_TIMER_RUNNING.swap(true, Ordering::SeqCst) {
                    let account_id = account_id.to_string();
                    let seed_phrase = seed_phrase.to_string();
                    let sync_path = sync_path.to_path_buf();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let mut paths = Vec::new();
                        {
                            let mut batch = CREATE_BATCH.lock().unwrap();
                            for path in batch.drain(..) {
                                println!("[PrivateWatcher][Create] Processing batch path: {}", path.to_string_lossy());
                                let mut retries = 20;
                                while retries > 0 && !path.exists() {
                                    std::thread::sleep(Duration::from_millis(100));
                                    retries -= 1;
                                }
                                if path.exists() {
                                    if path.is_file() {
                                        let mut last_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                        let stable = (0..10).all(|_| {
                                            std::thread::sleep(Duration::from_millis(100));
                                            let new_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                            let is_stable = new_size == last_size;
                                            last_size = new_size;
                                            is_stable
                                        });
                                        if stable {
                                            let is_inside_folder = paths.iter().any(|(p, is_folder)| {
                                                *is_folder && path.starts_with(p) && path != *p
                                            });
                                            if !is_inside_folder {
                                                paths.push((path.clone(), false));
                                            }
                                        }
                                    } else if path.is_dir() {
                                        paths.push((path.clone(), true));
                                    }
                                } else {
                                    println!("[PrivateWatcher][Create] Path {} no longer exists, skipping.", path.to_string_lossy());
                                }
                            }
                        }
                        println!("[PrivateWatcher][Create] Paths to upload after debounce: {:?}", paths);
                        if !paths.is_empty() {
                            {
                                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                                status.total_files += paths.len(); 
                                // status.synced_files = 0;
                                status.in_progress = true;
                            }
                            if let Some(sender) = UPLOAD_SENDER.get() {
                                for (path, is_folder) in paths {
                                    let path_str = path.to_string_lossy().to_string();
                                    println!("[PrivateWatcher][Create] Enqueuing for upload: {} (is_folder: {})", path_str, is_folder);
                                    if let Err(e) = sender.send(UploadJob {
                                        account_id: account_id.clone(),
                                        seed_phrase: seed_phrase.clone(),
                                        file_path: path_str,
                                        is_folder,
                                    }) {
                                        eprintln!("[PrivateWatcher][Create] Failed to enqueue upload for '{}': {}", path.to_string_lossy(), e);
                                    }
                                }
                            }
                        }
                        CREATE_BATCH_TIMER_RUNNING.store(false, Ordering::SeqCst);
                    });
                }
            } else {
                eprintln!("[PrivateWatcher][Create] DB_POOL not initialized, cannot check sync status.");
            }
        }
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::To)) => {
            let mut paths_to_batch = HashSet::new();

            for path in filtered_paths {
                let path_str = path.to_string_lossy().to_string();
                let file_name = match path.file_name().and_then(|s| s.to_str()) {
                    Some(name) => name.to_string(),
                    None => {
                        println!("[PrivateWatcher][Modify] Could not extract file name from path: {}", path_str);
                        continue;
                    }
                };

                // Skip if recently uploaded or already uploading
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PrivateWatcher][Modify] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PrivateWatcher][Modify] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }

                // Determine the top-level path to re-sync
                let top_level_path = if path.parent() == Some(sync_path) {
                    path.clone()
                } else if let Some(top_level_folder) = find_top_level_folder(&path, sync_path) {
                    top_level_folder
                } else {
                    println!("[PrivateWatcher][Modify] Path {} is not in a top-level folder or file, skipping.", path_str);
                    continue;
                };

                // Skip if top-level path is recently uploaded
                let top_level_path_str = top_level_path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&top_level_path_str) {
                        println!("[PrivateWatcher][Modify] Skipping recently uploaded top-level path: {}", top_level_path_str);
                        continue;
                    }
                }

                // Check if path is already in sync_folder_files
                if let Some(pool) = crate::DB_POOL.get() {

                    let is_synced: Option<(String,)> = match sqlx::query_as(
                        "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
                    )
                    .bind(&file_name)
                    .bind(&account_id)
                    .bind("private")
                    .fetch_optional(pool)
                    .await
                    {
                        Ok(result) => result,
                        Err(e) => {
                            eprintln!("[PrivateWatcher][Modify] DB error while checking sync status for '{}': {}", file_name, e);
                            None
                        }
                    };
                    
                    if is_synced.is_some() {
                        // Path exists in sync DB, delete old records before re-uploading
                        println!("[PrivateWatcher][Modify] Path '{}' exists in sync DB, cleaning up before re-sync.", file_name);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, false, should_delete_folder).await;
                        if delete_result.is_err() {
                            eprintln!("[PrivateWatcher][Modify] Warning: Failed to delete/unpin old records for '{}', proceeding with upload anyway.", file_name);
                        } else {
                            println!("[PrivateWatcher][Modify] Successfully cleaned up old records for '{}'", file_name);
                        }
                    }
                } else {
                    eprintln!("[PrivateWatcher][Modify] DB_POOL not initialized, cannot check sync status.");
                }

                paths_to_batch.insert(top_level_path);
            }

            // Add to batch and trigger debounced processor
            if !paths_to_batch.is_empty() {
                {
                    let mut batch = CREATE_BATCH.lock().unwrap();
                    for path in paths_to_batch {
                        println!("[PrivateWatcher][Modify] Adding to batch: {} (re-sync)", path.to_string_lossy());
                        batch.push(path);
                    }
                }

                if !CREATE_BATCH_TIMER_RUNNING.swap(true, Ordering::SeqCst) {
                    let account_id = account_id.to_string();
                    let seed_phrase = seed_phrase.to_string();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let paths_to_process: Vec<PathBuf>;
                        {
                            let mut batch = CREATE_BATCH.lock().unwrap();
                            paths_to_process = batch.drain(..).collect();
                        }

                        let mut final_paths_to_upload = Vec::new();
                        let mut unique_paths = HashSet::new();

                        for path in paths_to_process {
                            if unique_paths.insert(path.clone()) {
                                let file_name = match path.file_name().and_then(|s| s.to_str()) {
                                    Some(name) => name.to_string(),
                                    None => {
                                        println!("[PrivateWatcher][Debounced] Could not extract file name from path: {}", path.to_string_lossy());
                                        continue;
                                    }
                                };

                                if !path.exists() {
                                    println!("[PrivateWatcher][Debounced] Path {} no longer exists, skipping.", path.to_string_lossy());
                                    continue;
                                }

                                if path.is_file() {
                                    let mut last_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                    let stable = (0..10).all(|_| {
                                        std::thread::sleep(Duration::from_millis(100));
                                        let new_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                        let is_stable = new_size == last_size;
                                        last_size = new_size;
                                        is_stable
                                    });
                                    if stable {
                                        final_paths_to_upload.push((path.clone(), false));
                                    }
                                } else if path.is_dir() {
                                    final_paths_to_upload.push((path.clone(), true));
                                }
                            }
                        }

                        println!("[PrivateWatcher][Debounced] Paths to upload after debounce: {:?}", final_paths_to_upload);

                        if !final_paths_to_upload.is_empty() {
                            {
                                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                                status.total_files += final_paths_to_upload.len();
                                // status.synced_files = 0;
                                status.in_progress = true;
                            }
                            if let Some(sender) = UPLOAD_SENDER.get() {
                                for (path, is_folder) in final_paths_to_upload {
                                    let path_str = path.to_string_lossy().to_string();
                                    println!("[PrivateWatcher][Debounced] Enqueuing for upload: {} (is_folder: {})", path_str, is_folder);
                                    if let Err(e) = sender.send(UploadJob {
                                        account_id: account_id.clone(),
                                        seed_phrase: seed_phrase.clone(),
                                        file_path: path_str,
                                        is_folder,
                                    }) {
                                        eprintln!("[PrivateWatcher][Debounced] Failed to enqueue upload for '{}': {}", path.to_string_lossy(), e);
                                    }
                                }
                            }
                        }
                        CREATE_BATCH_TIMER_RUNNING.store(false, Ordering::SeqCst);
                    });
                }
            }
        }
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Folder) | EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::From)) => {
            for path in filtered_paths {
                let file_name = path.file_name().and_then(|s| s.to_str());
                if let Some(file_name) = file_name {
                    println!("[PrivateWatcher][Remove] Path deleted from sync folder: {} (is_folder: {})", file_name, path.is_dir());
                    let should_delete_folder = false;
                    let delete_result = delete_and_unpin_user_file_records_by_name(file_name, seed_phrase, false, should_delete_folder).await;
                    if delete_result.is_ok() {
                        println!("[PrivateWatcher][Remove] Successfully deleted records for '{}'", file_name);
                    } else {
                        eprintln!("[PrivateWatcher][Remove] Failed to delete/unpin records for '{}': {:?}", file_name, delete_result.err());
                    }
                }
            }
        }
        EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Both)) => {
            for path in filtered_paths {
                let path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PrivateWatcher][Rename] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PrivateWatcher][Rename] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }

                let file_name = match path.file_name().and_then(|s| s.to_str()) {
                    Some(name) => name.to_string(),
                    None => {
                        eprintln!("[PrivateWatcher][Rename] Could not extract file name from path: {}", path_str);
                        continue;
                    }
                };

                if path.parent() == Some(sync_path) {
                    if path.is_file() {
                        println!("[PrivateWatcher][Rename] Detected rename of top-level file: {}", path_str);
                        replace_path_and_db_records(&path, account_id, seed_phrase, app_handle.clone()).await;
                    } else if path.is_dir() {
                        println!("[PrivateWatcher][Rename] Detected rename of top-level folder: {}", file_name);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, false, should_delete_folder).await;
                        if delete_result.is_ok() {
                            println!("[PrivateWatcher][Rename] Successfully deleted old records for folder '{}'", file_name);
                        } else {
                            eprintln!("[PrivateWatcher][Rename] Failed to delete/unpin old records for folder '{}'", file_name);
                            continue;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            if let Err(e) = sender.send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: path_str.clone(),
                                is_folder: true,
                            }) {
                                eprintln!("[PrivateWatcher][Rename] Failed to enqueue upload for '{}': {}", path_str, e);
                            } else {
                                println!("[PrivateWatcher][Rename] Enqueued folder for upload: {}", path_str);
                            }
                        }
                    }
                } else {
                    if let Some(top_level_folder) = find_top_level_folder(&path, sync_path) {
                        let folder_str = top_level_folder.to_string_lossy().to_string();
                        let folder_name = match top_level_folder.file_name().and_then(|s| s.to_str()) {
                            Some(name) => name.to_string(),
                            None => {
                                eprintln!("[PrivateWatcher][Rename] Could not extract folder name from path: {}", folder_str);
                                continue;
                            }
                        };
                        println!("[PrivateWatcher][Rename] Path {} affects folder {}, re-uploading folder", path_str, folder_str);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&folder_name, seed_phrase, false, should_delete_folder).await;
                        if delete_result.is_ok() {
                            println!("[PrivateWatcher][Rename] Successfully deleted old records for folder '{}'", folder_name);
                        } else {
                            eprintln!("[PrivateWatcher][Rename] Failed to delete/unpin old records for folder '{}'", folder_name);
                            continue;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            if let Err(e) = sender.send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: folder_str.clone(),
                                is_folder: true,
                            }) {
                                eprintln!("[PrivateWatcher][Rename] Failed to enqueue upload for '{}': {}", folder_str, e);
                            } else {
                                println!("[PrivateWatcher][Rename] Enqueued folder for upload: {}", folder_str);
                            }
                        }
                    } else {
                        println!("[PrivateWatcher][Rename] Path {} is not in a top-level folder or file, skipping.", path_str);
                    }
                }
            }
        }
        _ => {
            println!("[PrivateWatcher] Unhandled event kind: {:?}", event.kind);
        }
    }
}

async fn upload_path(path: &Path, account_id: &str, seed_phrase: &str, is_folder: bool, app_handle: AppHandle) -> bool {
    let path_str = path.to_string_lossy().to_string();
    {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        if uploading_files.contains(&path_str) {
            println!("[PrivateUploadPath] Path {} is already uploading, skipping.", path_str);
            return false;
        }
        uploading_files.insert(path_str.clone());
    }

    let _guard = UPLOAD_LOCK.lock().unwrap();
    let result = if is_folder {
        encrypt_and_upload_folder_sync(
            app_handle,
            account_id.to_string(),
            path.to_str().unwrap().to_string(),
            seed_phrase.to_string(),
            None
        ).await
    } else {
        encrypt_and_upload_file_sync(
            app_handle,
            account_id.to_string(),
            path.to_str().unwrap().to_string(),
            seed_phrase.to_string(),
            None
        ).await
    };

    match result {
        Ok(res) => {
            println!("[PrivateUploadPath] Successfully uploaded path: {}", res);
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&path_str);
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            recently_uploaded.insert(path_str.clone());
            let path_str_clone = path_str.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(300)).await;
                let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                recently_uploaded.remove(&path_str_clone);
            });
            if let Some(pool) = crate::DB_POOL.get() {
                insert_file_if_not_exists(pool, path, account_id, false, is_folder).await;
            }
            true
        }
        Err(e) => {
            eprintln!("[PrivateUploadPath] Upload failed for {}: {}", path_str, e);
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&path_str);
            false
        }
    }
}

async fn replace_path_and_db_records(path: &Path, account_id: &str, seed_phrase: &str, app_handle: AppHandle) {
    let path_str = path.to_string_lossy().to_string();
    {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        if uploading_files.contains(&path_str) {
            println!("[PrivateFolderSync] Path {:?} is already being uploaded, skipping replace.", path);
            return;
        }
        uploading_files.insert(path_str.clone());
    }

    let file_name = match path.file_name().map(|s| s.to_string_lossy().to_string()) {
        Some(name) => name,
        None => {
            eprintln!("[PrivateFolderSync] Could not extract name from path: {}", path.display());
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&path_str);
            return;
        }
    };

    let mut last_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let stable = (0..10).all(|_| {
        std::thread::sleep(Duration::from_millis(100));
        let new_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let is_stable = new_size == last_size;
        last_size = new_size;
        is_stable
    });

    if !stable {
        println!("[PrivateFolderSync] File {} is still being written, skipping.", path_str);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
        return;
    }

    println!("[PrivateFolderSync] Replacing file: {}", file_name);
    
    // First attempt to delete the old records, but continue regardless of result
    println!("[PrivateFolderSync] Attempting to clean up old records for '{}' before upload...", file_name);
    let should_delete_folder = false;
    let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, false, should_delete_folder).await;
    
    if delete_result.is_err() {
        eprintln!("[PrivateFolderSync] Warning: Failed to delete/unpin old records for '{}', proceeding with upload anyway.", file_name);
    } else {
        println!("[PrivateFolderSync] Successfully cleaned up old records for '{}'", file_name);
    }
    
    // Proceed with upload regardless of delete result
    let upload_result = upload_path(path, account_id, seed_phrase, false, app_handle).await;

    if upload_result {
        println!("[PrivateFolderSync] Upload successful for '{}'", file_name);
    } else {
        eprintln!("[PrivateFolderSync] Upload failed for '{}'", file_name);
    }
    
    // Always remove from uploading_files when done
    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
    uploading_files.remove(&path_str);
}

#[tauri::command]
pub async fn start_folder_sync_tauri(app_handle: AppHandle, account_id: String, seed_phrase: String) {
    start_folder_sync(app_handle, account_id, seed_phrase).await;
}