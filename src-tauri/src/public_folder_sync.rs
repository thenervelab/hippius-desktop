use crate::commands::ipfs_commands::{upload_file_public_sync, public_upload_folder_sync};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use crate::utils::sync::get_public_sync_path;
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
use tauri::AppHandle;
pub use crate::sync_shared::{SYNCING_ACCOUNTS, find_top_level_folder, UPLOAD_LOCK, UploadJob, insert_file_if_not_exists, PUBLIC_SYNC_STATUS, GLOBAL_CANCEL_TOKEN};
use once_cell::sync::Lazy;

// Module-specific state
pub static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static RECENTLY_DELETED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

pub static CREATE_BATCH: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
pub static CREATE_BATCH_TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

pub async fn start_public_folder_sync(app_handle: AppHandle, account_id: String, seed_phrase: String) {
    let mut is_initial_startup = true;
    loop {
        // Check global cancellation token first
        if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
            println!("[PublicFolderSync] Global cancellation detected, stopping sync for account {}", account_id);
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "public"));
            }
            return;
        }
        
        {
            let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
            if syncing_accounts.contains(&(account_id.clone(), "public")) {
                println!("[PublicFolderSync] Account {} is already syncing, skipping.", account_id);
                return;
            }
            syncing_accounts.insert((account_id.clone(), "public"));
        }

        let (path_change_tx, mut path_change_rx) = mpsc::channel::<String>(100);
        let cancel_token = Arc::new(AtomicBool::new(false));

        let sync_path_result = get_public_sync_path().await;
        println!("[PublicFolderSync] Public sync path result: {:?}", sync_path_result);
        if let Ok(sync_path) = sync_path_result {
            println!("[PublicFolderSync] Public sync path found: {}, starting sync process", sync_path);
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
            eprintln!("[PublicFolderSync] Failed to get public sync path: {:?}", sync_path_result.err());
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "public"));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }

        let account_id_clone = account_id.clone();
        let cancel_token_clone = Arc::clone(&cancel_token);
        tokio::spawn(async move {
            if let Some(new_sync_path) = path_change_rx.recv().await {
                println!("[PublicFolderSync] Received path change to: {}. Stopping current sync.", new_sync_path);
                cancel_token_clone.store(true, Ordering::SeqCst);
                {
                    let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                    syncing_accounts.remove(&(account_id_clone, "public"));
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
                    let mut recently_deleted = RECENTLY_DELETED.lock().unwrap();
                    recently_deleted.clear();
                }
                {
                    let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                    *status = SyncStatus::default();
                }
            } else {
                println!("[PublicFolderSync] Path change channel closed, stopping sync for account {}.", account_id_clone);
                cancel_token_clone.store(true, Ordering::SeqCst);
                {
                    let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                    syncing_accounts.remove(&(account_id_clone, "public"));
                }
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                *status = SyncStatus::default();
            }
        });

        // Set to false after the first startup
        is_initial_startup = false;

        while !cancel_token.load(Ordering::SeqCst) && !GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        
        // If global cancellation was triggered, clean up and exit
        if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
            println!("[PublicFolderSync] Global cancellation detected in main loop, cleaning up for account {}", account_id);
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "public"));
            }
            return;
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
                // Check global cancellation before processing each job
                if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
                    println!("[PublicUploadWorker] Global cancellation detected, stopping upload worker");
                    break;
                }
                
                let path_str = job.file_path.clone();
                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PublicUploadWorker] Path {} is already uploading, skipping.", path_str);
                        // Increment processed_files even for skipped uploads
                        let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                        status.processed_files += 1;
                        if status.processed_files >= status.total_files && status.total_files > 0 {
                            status.in_progress = false;
                            println!("[PublicFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
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
                        let is_synced: Option<(i32,)> = match sqlx::query_as(
                            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
                        )
                        .bind(&job.account_id)
                        .bind(file_name)
                        .fetch_optional(pool)
                        .await
                        {
                            Ok(result) => result,
                            Err(e) => {
                                eprintln!("[PublicUploadWorker] DB error while checking sync status for '{}': {}", file_name, e);
                                None
                            }
                        };
                        if is_synced.is_some() {
                            println!("[PublicUploadWorker] Path '{}' already exists in sync DB, marking as successful.", file_name);
                            success = true;
                            break;
                        }
                    }

                    let result = if job.is_folder {
                        public_upload_folder_sync(
                            worker_app_handle.clone(),
                            job.account_id.clone(),
                            job.file_path.clone(),
                            job.seed_phrase.clone()
                        ).await
                    } else {
                        upload_file_public_sync(
                            worker_app_handle.clone(),
                            job.account_id.clone(),
                            job.file_path.clone(),
                            job.seed_phrase.clone(),
                        ).await
                    };

                    if result.is_ok() {
                        success = true;
                        break;
                    } else {
                        last_error = Some(result.err().unwrap());
                        eprintln!("[PublicUploadWorker] Upload attempt {} failed for {}: {:?}", attempt, path_str, last_error);
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }

                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    uploading_files.remove(&path_str);
                }

                {
                    let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                    status.processed_files += 1; // Always increment processed_files
                    if success {
                        status.synced_files += 1;
                        println!("[PublicFolderSync] Synced paths: {} / {} (Processed: {})", status.synced_files, status.total_files, status.processed_files);
                        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        recently_uploaded.insert(path_str.clone());
                    } else {
                        eprintln!("[PublicUploadWorker] Gave up upload after {} attempts for {}: {:?}", MAX_RETRIES, path_str, last_error);
                    }

                    if status.processed_files >= status.total_files && status.total_files > 0 {
                        status.in_progress = false;
                        println!("[PublicFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
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
                    eprintln!("[PublicStartup] DB_POOL not initialized, cannot proceed with sync.");
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
                "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'public'"
            )
            .bind(&startup_account_id)
            .fetch_all(pool)
            .await
            {
                Ok(paths) => paths,
                Err(e) => {
                    eprintln!("[PublicStartup] Failed to fetch sync_folder_files: {}", e);
                    Vec::new()
                }
            };

            // Delete paths that no longer exist
            for (db_path, is_folder) in &db_paths {
                if !dir_paths.contains(db_path) {
                    println!("[PublicStartup] Path deleted from sync folder: {} (is_folder: {})", db_path, is_folder);
                    let should_delete_folder = false;
                    match delete_and_unpin_user_file_records_by_name(db_path, &startup_seed_phrase, true, should_delete_folder).await {
                        Ok(_) => {
                            if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'")
                                .bind(&startup_account_id)
                                .bind(db_path)
                                .execute(pool)
                                .await
                            {
                                eprintln!("[PublicStartup] Failed to delete sync_folder_files record for '{}': {}", db_path, e);
                            } else {
                                println!("[PublicStartup] Successfully deleted sync_folder_files record for '{}'", db_path);
                            }
                        }
                        Err(e) => eprintln!("[PublicStartup] Failed to delete/unpin records for '{}': {}", db_path, e),
                    }
                }
            }

            let mut new_paths_to_upload = Vec::new();
            let mut unique_paths = HashSet::new();
            for path in folder_paths.into_iter().chain(file_paths.into_iter()) {
                let file_name = match path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) {
                    Some(name) => name,
                    None => {
                        eprintln!("[PublicStartup] Could not extract file name from path: {}", path.to_string_lossy());
                        continue;
                    }
                };

                let path_str = path.to_string_lossy().to_string();
                if !unique_paths.insert(path_str.clone()) {
                    println!("[PublicStartup] Duplicate path detected, skipping: {}", path_str);
                    continue;
                }

                // Skip if already in sync DB
                let is_synced: Option<(i32,)> = match sqlx::query_as(
                    "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
                )
                .bind(&startup_account_id)
                .bind(&file_name)
                .fetch_optional(pool)
                .await
                {
                    Ok(result) => result,
                    Err(e) => {
                        eprintln!("[PublicStartup] DB error while checking sync status for '{}': {}", file_name, e);
                        None
                    }
                };

                if is_synced.is_some() {
                    println!("[PublicStartup] Path '{}' is already in sync DB, marking as processed.", file_name);
                    let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                    status.processed_files += 1;
                    status.synced_files += 1;
                    if status.processed_files >= status.total_files && status.total_files > 0 {
                        status.in_progress = false;
                        println!("[PublicFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                    }
                    continue;
                }

                // Skip if recently uploaded or uploading
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PublicStartup] Skipping recently uploaded: {}", path_str);
                        let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                        status.processed_files += 1;
                        status.synced_files += 1;
                        if status.processed_files >= status.total_files && status.total_files > 0 {
                            status.in_progress = false;
                            println!("[PublicFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                        }
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PublicStartup] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }

                println!("[PublicStartup] New path detected in sync folder: {} (is_folder: {})", file_name, path.is_dir());
                if let Some(sender) = UPLOAD_SENDER.get() {
                    if let Err(e) = sender.send(UploadJob {
                        account_id: startup_account_id.clone(),
                        seed_phrase: startup_seed_phrase.clone(),
                        file_path: path_str,
                        is_folder: path.is_dir(),
                    }) {
                        eprintln!("[PublicStartup] Failed to enqueue upload for '{}': {}", file_name, e);
                        // Increment processed_files on enqueue failure
                        let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                        status.processed_files += 1;
                        if status.processed_files >= status.total_files && status.total_files > 0 {
                            status.in_progress = false;
                            println!("[PublicFolderSync] Sync completed. Processed {} out of {} files.", status.processed_files, status.total_files);
                        }
                    } else {
                        new_paths_to_upload.push(path.clone());
                    }
                }
            }

            if !new_paths_to_upload.is_empty() {
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                status.total_files = new_paths_to_upload.len();
                status.synced_files = 0;
                status.processed_files = 0;
                status.in_progress = true;
                println!("[PublicStartup] Set total_files to {} for new paths", status.total_files);
            } else {
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                status.in_progress = false;
                status.total_files = 0;
                status.processed_files = 0;
                status.synced_files = 0;
                println!("[PublicStartup] No new paths to upload, sync complete.");
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
                    eprintln!("[PublicSyncPathChange] DB_POOL not initialized, cannot proceed with sync.");
                    return;
                }
            };

            // Delete all public sync_folder_files records with a single query
            println!("[PublicSyncPathChange] Deleting all public sync_folder_files records for account {}", sync_account_id);
            match sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND type = 'public'")
                .bind(&sync_account_id)
                .execute(pool)
                .await
            {
                Ok(result) => {
                    println!("[PublicSyncPathChange] Successfully deleted {} public sync_folder_files records", result.rows_affected());
                }
                Err(e) => {
                    eprintln!("[PublicSyncPathChange] Failed to delete public sync_folder_files records: {}", e);
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
                        eprintln!("[PublicSyncPathChange] Could not extract file name from path: {}", path.to_string_lossy());
                        continue;
                    }
                };

                // Check if path is already in sync_folder_files (should be empty due to prior deletion, but check for safety)
                let is_synced: Option<(i32,)> = match sqlx::query_as(
                    "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
                )
                .bind(&sync_account_id)
                .bind(&file_name)
                .fetch_optional(pool)
                .await
                {
                    Ok(result) => result,
                    Err(e) => {
                        eprintln!("[PublicSyncPathChange] DB error while checking sync status for '{}': {}", file_name, e);
                        None
                    }
                };

                if is_synced.is_some() {
                    println!("[PublicSyncPathChange] Path '{}' is already in sync DB, skipping.", file_name);
                    continue;
                }

                println!("[PublicSyncPathChange] New path detected in new sync folder: {} (is_folder: {})", file_name, path.is_dir());
                if let Some(sender) = UPLOAD_SENDER.get() {
                    if let Err(e) = sender.send(UploadJob {
                        account_id: sync_account_id.clone(),
                        seed_phrase: sync_seed_phrase.clone(),
                        file_path: path.to_string_lossy().to_string(),
                        is_folder: path.is_dir(),
                    }) {
                        eprintln!("[PublicSyncPathChange] Failed to enqueue upload for '{}': {}", file_name, e);
                    } else {
                        new_paths_to_upload.push(path.clone());
                    }
                }
            }

            if !new_paths_to_upload.is_empty() {
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                status.total_files = new_paths_to_upload.len();
                status.synced_files = 0;
                status.processed_files = 0;
                status.in_progress = true;
            } else {
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
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

        // Clone app_handle for the event handler thread
        let event_handler_app_handle = app_handle.clone();

        loop {
            if cancel_token.load(Ordering::SeqCst) || GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
                if let Some(w) = watcher.take() {
                    drop(w);
                    println!("[PublicFolderSync] Stopped watching path: {}", current_path);
                }
                if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
                    println!("[PublicFolderSync] Watcher thread cancelled due to global cancellation for account {}", account_id);
                } else {
                    println!("[PublicFolderSync] Watcher thread cancelled for account {}", account_id);
                }
                break;
            }

            let latest_sync_path = match rt.block_on(get_public_sync_path()) {
                Ok(path) => PathBuf::from(path),
                Err(e) => {
                    eprintln!("[PublicFolderSync] Failed to get public sync path: {}", e);
                    thread::sleep(Duration::from_secs(5));
                    continue;
                }
            };

            let latest_sync_path_str = latest_sync_path.to_string_lossy().to_string();
            if latest_sync_path_str != current_path {
                if rt.block_on(path_change_tx.send(latest_sync_path_str.clone())).is_ok() {
                    println!("[PublicFolderSync] Sent path change notification: {}", latest_sync_path_str);
                } else {
                    eprintln!("[PublicFolderSync] Failed to send path change notification");
                }
                break;
            }

            println!("[PublicFolderSync] Periodic check: scanning for unsynced paths...");
            let mut paths_to_check = Vec::new();
            collect_paths_recursively(&sync_path, &mut paths_to_check);

            for path in paths_to_check {
                let path_str = path.to_string_lossy().to_string();
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PublicFolderSync] Path {:?} is being uploaded, skipping periodic check.", path);
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
                    .expect("[PublicFolderSync] Failed to create watcher");

                new_watcher
                    .watch(&sync_path, RecursiveMode::Recursive)
                    .expect("[PublicFolderSync] Failed to watch sync directory");

                // Clone all necessary variables for the event handler thread
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
                                Err(e) => eprintln!("[PublicFolderSync] Watch error: {:?}", e),
                            }
                        }
                    }
                });

                println!("[PublicFolderSync] Started watching public path: {}", current_path);
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
    // General filtering for temporary/hidden files and ensuring paths are within the sync directory.
    let paths = event.paths.into_iter()
        .filter(|path| {
            if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                if file_name.starts_with('.') || file_name.contains("goutputstream") {
                    let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                    status.processed_files += 1;
                    if status.processed_files >= status.total_files && status.total_files > 0 {
                        status.in_progress = false;
                        println!("[PublicFolderSync] Filtered path marked as processed: {}", path.display());
                    }
                    return false;
                }
            }
            path.starts_with(sync_path)
        })
        .collect::<Vec<_>>();

    if paths.is_empty() {
        println!("[PublicWatcher] Skipping event with no relevant paths.");
        return;
    }

    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            let mut paths_to_batch = HashSet::new();

            for path in paths {
                let path_str = path.to_string_lossy().to_string();

                // Skip if recently uploaded or already uploading
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PublicWatcher][Create] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PublicWatcher][Create] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }

                // Determine the effective path to re-sync
                let effective_path = if path.parent() == Some(sync_path) {
                    path.clone()
                } else if let Some(top_level) = find_top_level_folder(&path, sync_path) {
                    top_level
                } else {
                    println!("[PublicWatcher][Create] Path {} is not in a top-level folder or file, skipping.", path_str);
                    continue;
                };

                let effective_path_str = effective_path.to_string_lossy().to_string();
                // Check if the effective path is already in the batch to avoid duplicates
                if paths_to_batch.contains(&effective_path) {
                    println!("[PublicWatcher][Create] Effective path {} already in batch, skipping.", effective_path_str);
                    continue;
                }

                if let Some(pool) = crate::DB_POOL.get() {
                    let file_name = match effective_path.file_name().and_then(|s| s.to_str()) {
                        Some(name) => name.to_string(),
                        None => {
                            println!("[PublicWatcher][Create] Could not extract file name from effective path: {}", effective_path.to_string_lossy());
                            continue;
                        }
                    };

                    let is_synced: Option<(String,)> = match sqlx::query_as(
                        "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
                    )
                    .bind(&file_name)
                    .bind(&account_id)
                    .bind("public")
                    .fetch_optional(pool)
                    .await
                    {
                        Ok(result) => result,
                        Err(e) => {
                            eprintln!("[PublicWatcher][Create] DB error while checking sync status for '{}': {}", file_name, e);
                            None
                        }
                    };

                    if let Some(_) = is_synced {
                        println!("[PublicWatcher][Create] Effective path '{}' exists in sync DB, cleaning up before re-sync.", file_name);
                        let should_delete_folder = false;
                        if let Err(e) = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, true, should_delete_folder).await {
                            eprintln!("[PublicWatcher][Create] Warning: Failed to delete/unpin old records for '{}', proceeding with upload anyway. Error: {:?}", file_name, e);
                        } else {
                            println!("[PublicWatcher][Create] Successfully cleaned up old records for '{}'", file_name);
                        }
                    } else {
                        println!("[PublicWatcher][Create] New effective path detected: {}", file_name);
                    }
                } else {
                    eprintln!("[PublicWatcher][Create] DB_POOL not initialized, cannot check sync status.");
                    continue;
                }

                paths_to_batch.insert(effective_path);
            }

            // Add to batch
            if !paths_to_batch.is_empty() {
                {
                    let mut batch = CREATE_BATCH.lock().unwrap();
                    for path in paths_to_batch {
                        println!("[PublicWatcher][Create] Adding to batch: {} (is_folder: {})", path.to_string_lossy(), path.is_dir());
                        batch.push(path);
                    }
                }

                if !CREATE_BATCH_TIMER_RUNNING.swap(true, Ordering::SeqCst) {
                    let account_id = account_id.to_string();
                    let seed_phrase = seed_phrase.to_string();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let mut paths = Vec::new();
                        {
                            let mut batch = CREATE_BATCH.lock().unwrap();
                            for path in batch.drain(..) {
                                println!("[PublicWatcher][Create] Processing batch path: {}", path.to_string_lossy());
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
                                            paths.push((path.clone(), false));
                                        }
                                    } else if path.is_dir() {
                                        paths.push((path.clone(), true));
                                    }
                                } else {
                                    println!("[PublicWatcher][Create] Path {} no longer exists, skipping.", path.to_string_lossy());
                                }
                            }
                        }
                        println!("[PublicWatcher][Create] Paths to upload after debounce: {:?}", paths);
                        if !paths.is_empty() {
                            {
                                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                                status.total_files += paths.len(); 
                                status.in_progress = true;
                            }
                            if let Some(sender) = UPLOAD_SENDER.get() {
                                for (path, is_folder) in paths {
                                    let path_str = path.to_string_lossy().to_string();
                                    println!("[PublicWatcher][Create] Enqueuing for upload: {} (is_folder: {})", path_str, is_folder);
                                    if let Err(e) = sender.send(UploadJob {
                                        account_id: account_id.clone(),
                                        seed_phrase: seed_phrase.clone(),
                                        file_path: path_str,
                                        is_folder,
                                    }) {
                                        eprintln!("[PublicWatcher][Create] Failed to enqueue upload for '{}': {}", path.to_string_lossy(), e);
                                    }
                                }
                            }
                        }
                        CREATE_BATCH_TIMER_RUNNING.store(false, Ordering::SeqCst);
                    });
                }
            }
        }
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::To)) => {
            let mut paths_to_batch = HashSet::new();

            for path in paths {
                let path_str = path.to_string_lossy().to_string();

                // Skip if recently uploaded or already uploading
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PublicWatcher][Modify] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PublicWatcher][Modify] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }

                // Determine the top-level path to re-sync
                let top_level_path = if path.parent() == Some(sync_path) {
                    path.clone()
                } else if let Some(top_level_folder) = find_top_level_folder(&path, sync_path) {
                    top_level_folder
                } else {
                    println!("[PublicWatcher][Modify] Path {} is not in a top-level folder or file, skipping.", path_str);
                    continue;
                };

                let top_level_path_str = top_level_path.to_string_lossy().to_string();
                // Skip if recently uploaded, deleted, or already uploading
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PublicWatcher][Modify] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                    let recently_deleted = RECENTLY_DELETED.lock().unwrap();
                    if recently_deleted.contains(&path_str) {
                        println!("[PublicWatcher][Modify] Skipping recently deleted: {}", path_str);
                        continue;
                    }
                }
                
                if let Some(pool) = crate::DB_POOL.get() {
                    let file_name = top_level_path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();

                    let is_synced: Option<(String,)> = match sqlx::query_as(
                        "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
                    )
                    .bind(&file_name)
                    .bind(&account_id)
                    .bind("public")
                    .fetch_optional(pool)
                    .await
                    {
                        Ok(result) => result,
                        Err(e) => {
                            eprintln!("[PublicWatcher][Modify] DB error while checking sync status for '{}': {}", file_name, e);
                            None
                        }
                    };

                    if is_synced.is_some() {
                        println!("[PublicWatcher][Modify] Path '{}' exists in sync DB, cleaning up before re-sync.", file_name);
                        let should_delete_folder = false;
                        if let Err(e) = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, true, should_delete_folder).await {
                            eprintln!("[PublicWatcher][Modify] Warning: Failed to delete/unpin old records for '{}', proceeding with upload anyway. Error: {:?}", file_name, e);
                        } else {
                             println!("[PublicWatcher][Modify] Successfully cleaned up old records for '{}'", file_name);
                        }
                    }
                } else {
                    eprintln!("[PublicWatcher][Modify] DB_POOL not initialized, cannot check sync status.");
                }

                paths_to_batch.insert(top_level_path);
            }

            // Add to batch and trigger debounced processor
            if !paths_to_batch.is_empty() {
                {
                    let mut batch = CREATE_BATCH.lock().unwrap();
                    for path in paths_to_batch {
                        println!("[PublicWatcher][Modify] Adding to batch: {} (re-sync)", path.to_string_lossy());
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
                                        println!("[PublicWatcher][Debounced] Could not extract file name from path: {}", path.to_string_lossy());
                                        continue;
                                    }
                                };

                                if !path.exists() {
                                    println!("[PublicWatcher][Debounced] Path {} no longer exists, skipping.", path.to_string_lossy());
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

                        println!("[PublicWatcher][Debounced] Paths to upload after debounce: {:?}", final_paths_to_upload);

                        if !final_paths_to_upload.is_empty() {
                            {
                                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                                status.total_files += final_paths_to_upload.len();
                                status.in_progress = true;
                            }
                            if let Some(sender) = UPLOAD_SENDER.get() {
                                for (path, is_folder) in final_paths_to_upload {
                                    let path_str = path.to_string_lossy().to_string();
                                    println!("[PublicWatcher][Debounced] Enqueuing for upload: {} (is_folder: {})", path_str, is_folder);
                                    if let Err(e) = sender.send(UploadJob {
                                        account_id: account_id.clone(),
                                        seed_phrase: seed_phrase.clone(),
                                        file_path: path_str,
                                        is_folder,
                                    }) {
                                        eprintln!("[PublicWatcher][Debounced] Failed to enqueue upload for '{}': {}", path.to_string_lossy(), e);
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
            let mut paths_to_handle = HashSet::new();

            for path in paths {
                let path_str = path.to_string_lossy().to_string();

                let effective_path = if path.parent() == Some(sync_path) {
                    Some((path.clone(), true)) // (path, is_direct)
                } else if let Some(top_level) = find_top_level_folder(&path, sync_path) {
                    Some((top_level, false))
                } else {
                    println!("[PublicWatcher][Remove] Path {} is not in a top-level folder or file, skipping.", path_str);
                    None
                };

                if let Some(eff) = effective_path {
                    paths_to_handle.insert(eff);
                }
            }

            for (effective_path, is_direct) in paths_to_handle {
                let file_name = effective_path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()).unwrap_or_default();

                if file_name.is_empty() {
                        continue;
                    }

                println!("[PublicWatcher][Remove] Handling removal for effective path: {} (is_direct: {})", file_name, is_direct);
                {
                    let recently_deleted = RECENTLY_DELETED.lock().unwrap();
                    let effective_path_str = effective_path.to_string_lossy().to_string();
                    if recently_deleted.contains(&effective_path_str) {
                        println!("[PublicWatcher][Remove] Skipping recently deleted effective path: {}", effective_path_str);
                        continue;
                    }
                }
                let should_delete_folder = false;
                let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, true, should_delete_folder).await;

                if delete_result.is_ok() {
                    println!("[PublicWatcher][Remove] Successfully deleted records for '{}'", file_name);
                } else {
                    eprintln!("[PublicWatcher][Remove] Failed to delete/unpin records for '{}': {:?}", file_name, delete_result.err());
                }

                if !is_direct {
                    // For internal removal, re-upload the updated folder
                    let effective_path_str = effective_path.to_string_lossy().to_string();
                    {
                        let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        if recently_uploaded.contains(&effective_path_str) {
                            println!("[PublicWatcher][Remove] Skipping recently uploaded effective path: {}", effective_path_str);
                            continue;
                        }
                    }
                    {
                        let uploading_files = UPLOADING_FILES.lock().unwrap();
                        if uploading_files.contains(&effective_path_str) {
                            println!("[PublicWatcher][Remove] Effective path {} is already being uploaded, skipping.", effective_path_str);
                            continue;
                        }
                    }

                    if let Some(sender) = UPLOAD_SENDER.get() {
                        if let Err(e) = sender.send(UploadJob {
                            account_id: account_id.to_string(),
                            seed_phrase: seed_phrase.to_string(),
                            file_path: effective_path_str.clone(),
                            is_folder: true,
                        }) {
                            eprintln!("[PublicWatcher][Remove] Failed to enqueue re-upload for '{}': {}", effective_path_str, e);
                        } else {
                            println!("[PublicWatcher][Remove] Enqueued re-upload for updated folder: {}", effective_path_str);
                            let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                            status.total_files += 1;
                            status.in_progress = true;
                        }
                    }
                }
            }
        }
        EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Both)) => {
            // For rename events, we also only care about direct children.
            let filtered_paths = paths.into_iter()
                .filter(|path| path.parent().map(|p| p == sync_path).unwrap_or(false))
                .collect::<Vec<_>>();
            
            if filtered_paths.is_empty() {
                return;
            }
    
            for path in filtered_paths {
                let path_str = path.to_string_lossy().to_string();
                // Skip if recently uploaded, deleted, or already uploading
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[PublicWatcher][Modify] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                    let recently_deleted = RECENTLY_DELETED.lock().unwrap();
                    if recently_deleted.contains(&path_str) {
                        println!("[PublicWatcher][Modify] Skipping recently deleted: {}", path_str);
                        continue;
                    }
                }
                
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PublicWatcher][Rename] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }

                let file_name = match path.file_name().and_then(|s| s.to_str()) {
                    Some(name) => name.to_string(),
                    None => {
                        eprintln!("[PublicWatcher][Rename] Could not extract file name from path: {}", path_str);
                        continue;
                    }
                };

                if path.parent() == Some(sync_path) {
                    if path.is_file() {
                        println!("[PublicWatcher][Rename] Detected rename of top-level file: {}", path_str);
                        replace_path_and_db_records(app_handle.clone(), &path, account_id, seed_phrase).await;
                    } else if path.is_dir() {
                        println!("[PublicWatcher][Rename] Detected rename of top-level folder: {}", file_name);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, true, should_delete_folder).await;
                        if delete_result.is_ok() {
                            println!("[PublicWatcher][Rename] Successfully deleted old records for folder '{}'", file_name);
                        } else {
                            eprintln!("[PublicWatcher][Rename] Failed to delete/unpin old records for folder '{}'", file_name);
                            continue;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            if let Err(e) = sender.send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: path_str.clone(),
                                is_folder: true,
                            }) {
                                eprintln!("[PublicWatcher][Rename] Failed to enqueue upload for '{}': {}", path_str, e);
                            } else {
                                println!("[PublicWatcher][Rename] Enqueued folder for upload: {}", path_str);
                            }
                        }
                    }
                } else {
                    if let Some(top_level_folder) = find_top_level_folder(&path, sync_path) {
                        let folder_str = top_level_folder.to_string_lossy().to_string();
                        let folder_name = match top_level_folder.file_name().and_then(|s| s.to_str()) {
                            Some(name) => name.to_string(),
                            None => {
                                eprintln!("[PublicWatcher][Rename] Could not extract folder name from path: {}", folder_str);
                                continue;
                            }
                        };
                        println!("[PublicWatcher][Rename] Path {} affects folder {}, re-uploading folder", path_str, folder_str);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&folder_name, seed_phrase, true, should_delete_folder).await;
                        if delete_result.is_ok() {
                            println!("[PublicWatcher][Rename] Successfully deleted old records for folder '{}'", folder_name);
                        } else {
                            eprintln!("[PublicWatcher][Rename] Failed to delete/unpin old records for folder '{}'", folder_name);
                            continue;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            if let Err(e) = sender.send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: folder_str.clone(),
                                is_folder: true,
                            }) {
                                eprintln!("[PublicWatcher][Rename] Failed to enqueue upload for '{}': {}", folder_str, e);
                            } else {
                                println!("[PublicWatcher][Rename] Enqueued folder for upload: {}", folder_str);
                            }
                        }
                    } else {
                        println!("[PublicWatcher][Rename] Path {} is not in a top-level folder or file, skipping.", path_str);
                    }
                }
            }
        }
        _ => {
            println!("[PublicWatcher] Unhandled event kind: {:?}", event.kind);
        }
    }
}

async fn upload_path(app_handle: AppHandle, path: &Path, account_id: &str, seed_phrase: &str, is_folder: bool) -> bool {
    let path_str = path.to_string_lossy().to_string();
    {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        if uploading_files.contains(&path_str) {
            println!("[PublicUploadPath] Path {} is already uploading, skipping.", path_str);
            return false;
        }
        uploading_files.insert(path_str.clone());
    }

    let _guard = UPLOAD_LOCK.lock().unwrap();
    let result = if is_folder {
        public_upload_folder_sync(
            app_handle,
            account_id.to_string(),
            path.to_str().unwrap().to_string(),
            seed_phrase.to_string()
        ).await
    } else {
        upload_file_public_sync(
            app_handle,
            account_id.to_string(),
            path.to_str().unwrap().to_string(),
            seed_phrase.to_string()
        ).await
    };

    match result {
        Ok(res) => {
            println!("[PublicUploadPath] Successfully uploaded path: {}", res);
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
                insert_file_if_not_exists(pool, path, account_id, true, is_folder).await;
            }
            true
        }
        Err(e) => {
            eprintln!("[PublicUploadPath] Upload failed for {}: {}", path_str, e);
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&path_str);
            false
        }
    }
}

async fn replace_path_and_db_records(app_handle: AppHandle, path: &Path, account_id: &str, seed_phrase: &str) {
    let path_str = path.to_string_lossy().to_string();
    {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        if uploading_files.contains(&path_str) {
            println!("[PublicFolderSync] Path {:?} is already being uploaded, skipping replace.", path);
            return;
        }
        uploading_files.insert(path_str.clone());
    }

    let file_name = match path.file_name().map(|s| s.to_string_lossy().to_string()) {
        Some(name) => name,
        None => {
            eprintln!("[PublicFolderSync] Could not extract name from path: {}", path.display());
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
        println!("[PublicFolderSync] File {} is still being written, skipping.", path_str);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
        return;
    }

    println!("[PublicFolderSync] Replacing file: {}", file_name);
    
    // First attempt to delete the old records, but continue regardless of result
    println!("[PublicFolderSync] Attempting to clean up old records for '{}' before upload...", file_name);
    let should_delete_folder = false;
    let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, true, should_delete_folder).await;
    
    if delete_result.is_err() {
        eprintln!("[PublicFolderSync] Warning: Failed to delete/unpin old records for '{}', proceeding with upload anyway.", file_name);
    } else {
        println!("[PublicFolderSync] Successfully cleaned up old records for '{}'", file_name);
    }
    
    // Proceed with upload regardless of delete result
    let upload_result = upload_path(app_handle, path, account_id, seed_phrase, false).await;

    if upload_result {
        println!("[PublicFolderSync] Upload successful for '{}'", file_name);
    } else {
        eprintln!("[PublicFolderSync] Upload failed for '{}'", file_name);
    }
    
    // Always remove from uploading_files when done
    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
    uploading_files.remove(&path_str);
}

#[tauri::command]
pub async fn start_public_folder_sync_tauri(app_handle: AppHandle, account_id: String, seed_phrase: String) {
    start_public_folder_sync(app_handle, account_id, seed_phrase).await;
}