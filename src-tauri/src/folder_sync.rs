use crate::commands::ipfs_commands::{encrypt_and_upload_file_sync, encrypt_and_upload_folder_sync};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use crate::utils::sync::get_private_sync_path;
use crate::utils::file_operations::{delete_and_unpin_user_file_records_and_dir_by_name, delete_and_unpin_user_file_records_by_name};
use crate::DB_POOL;
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind}, Event, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use once_cell::sync::{Lazy, OnceCell};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio::sync::mpsc;
use std::sync::atomic::{AtomicBool, Ordering};
use crate::sync_shared::{SYNCING_ACCOUNTS, UPLOADING_FILES, RECENTLY_UPLOADED, SYNC_STATUS, 
    UPLOAD_LOCK, RECENTLY_UPLOADED_FOLDERS, CREATE_BATCH, CREATE_BATCH_TIMER_RUNNING, UploadJob, insert_file_if_not_exists};

pub static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();

pub async fn start_folder_sync(account_id: String, seed_phrase: String) {
    loop {
        // Check if the account is already syncing
        {
            let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
            if syncing_accounts.contains(&(account_id.clone(), "private")) {
                println!("[PrivateFolderSync] Account {} is already syncing, skipping.", account_id);
                return;
            }
            syncing_accounts.insert((account_id.clone(), "private"));
        }

        // Create a channel to receive path change notifications
        let (path_change_tx, mut path_change_rx) = mpsc::channel::<String>(100);
        let cancel_token = Arc::new(AtomicBool::new(false));

        // Get initial sync path and start sync process
        let sync_path_result = get_private_sync_path().await;
        if let Ok(sync_path) = sync_path_result {
            println!("[PrivateFolderSync] Private sync path found: {}, starting sync process", sync_path);
            start_sync_process(
                account_id.clone(),
                seed_phrase.clone(),
                sync_path,
                Arc::clone(&cancel_token),
                path_change_tx.clone(),
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

        // Wait for a path change or cancellation in a separate task
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
            } else {
                // Channel closed or error, clean up and exit
                println!("[PrivateFolderSync] Path change channel closed, stopping sync for account {}.", account_id_clone);
                cancel_token_clone.store(true, Ordering::SeqCst);
                {
                    let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                    syncing_accounts.remove(&(account_id_clone, "private"));
                }
            }
        });

        // Wait for cancellation to ensure the loop doesn't proceed until the current sync stops
        while !cancel_token.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

async fn start_sync_process(
    account_id: String,
    seed_phrase: String,
    sync_path: String,
    cancel_token: Arc<AtomicBool>,
    path_change_tx: mpsc::Sender<String>,
) {
    // Initialize upload queue if not already set
    if UPLOAD_SENDER.get().is_none() {
        let (tx, mut rx) = mpsc::unbounded_channel::<UploadJob>();
        UPLOAD_SENDER.set(tx).ok();
        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                let path_str = job.file_path.clone();
                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[UploadWorker] Path {} is already uploading, skipping.", path_str);
                        continue;
                    }
                    uploading_files.insert(path_str.clone());
                }

                let _result = if job.is_folder {
                    encrypt_and_upload_folder_sync(
                        job.account_id.clone(),
                        job.file_path.clone(),
                        job.seed_phrase.clone(),
                        None,
                    ).await
                } else {
                    encrypt_and_upload_file_sync(
                        job.account_id.clone(),
                        job.file_path.clone(),
                        job.seed_phrase.clone(),
                        None
                    ).await
                };

                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    uploading_files.remove(&path_str);
                }
                {
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.insert(path_str.clone());
                }

                {
                    let mut status = SYNC_STATUS.lock().unwrap();
                    status.synced_files += 1;
                    println!("[DEBUG] Synced paths: {} / {}", status.synced_files, status.total_files);
                    if status.synced_files == status.total_files {
                        status.in_progress = false;
                    }
                }

                let path_str_clone = path_str.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.remove(&path_str_clone);
                });

                tokio::time::sleep(Duration::from_secs(6)).await;
            }
        });
    }

    // Perform startup check
    let startup_account_id = account_id.clone();
    let startup_seed_phrase = seed_phrase.clone();
    let sync_path_cloned = sync_path.clone();
    tokio::spawn(async move {
        if let Some(pool) = crate::DB_POOL.get() {
            let sync_path = PathBuf::from(&sync_path);

            let mut paths = Vec::new();
            collect_paths_recursively(&sync_path, &mut paths);
            let mut folder_paths = HashSet::new();

            let mut file_paths = Vec::new();

            // Categorize paths into folders and files, excluding files inside folders
            for path in paths {
                if path.is_dir() {
                    folder_paths.insert(path.clone());
                } else if !folder_paths.iter().any(|folder| path.starts_with(folder)) {
                    file_paths.push(path);
                }
            }

            let dir_paths: HashSet<String> = folder_paths.iter()
                .chain(file_paths.iter())
                .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
                .collect();

            let db_paths: Vec<(String, bool)> = sqlx::query_as(
                "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'private'"
            )
            .bind(&startup_account_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();

            for (db_path, _is_folder) in &db_paths {
                if !dir_paths.contains(db_path) {
                    println!("[Startup] Path deleted from sync folder: {} (is_folder: {})", db_path, _is_folder);
                    if delete_and_unpin_user_file_records_and_dir_by_name(db_path, &startup_seed_phrase, false).await.is_ok() {
                        let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                            .bind(&startup_account_id)
                            .bind(db_path)
                            .execute(pool)
                            .await;
                    }
                }
            }

            let mut new_paths_to_upload = Vec::new();
            for path in folder_paths.into_iter().chain(file_paths.into_iter()) {
                let file_name = path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
                if let Some(file_name) = file_name {
                    if !db_paths.iter().any(|(name, _)| name == &file_name) {
                        println!("[Startup] New path detected in sync folder: {} (is_folder: {})", file_name, path.is_dir());
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            sender
                                .send(UploadJob {
                                    account_id: startup_account_id.clone(),
                                    seed_phrase: startup_seed_phrase.clone(),
                                    file_path: path.to_string_lossy().to_string(),
                                    is_folder: path.is_dir(),
                                })
                                .unwrap();
                        }
                        new_paths_to_upload.push(path.clone());
                    }
                }
            }

            if !new_paths_to_upload.is_empty() {
                let mut status = SYNC_STATUS.lock().unwrap();
                status.total_files = new_paths_to_upload.len();
                status.synced_files = 0;
                status.in_progress = true;
            }
        }
    });

    // Start watcher thread
    let sync_path = PathBuf::from(sync_path_cloned);
    spawn_watcher_thread(account_id, seed_phrase, sync_path, cancel_token, path_change_tx);
}

fn spawn_watcher_thread(
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

        loop {
            if cancel_token.load(Ordering::SeqCst) {
                if let Some(w) = watcher.take() {
                    drop(w);
                    println!("[PrivateFolderSync] Stopped watching path: {}", current_path);
                }
                println!("[PrivateFolderSync] Watcher thread cancelled for account {}", account_id);
                break;
            }

            // Check for sync path changes
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
                // Notify start_folder_sync of path change
                if rt.block_on(path_change_tx.send(latest_sync_path_str.clone())).is_ok() {
                    println!("[PrivateFolderSync] Sent path change notification: {}", latest_sync_path_str);
                } else {
                    eprintln!("[PrivateFolderSync] Failed to send path change notification");
                }
                break; // Exit to let start_folder_sync restart
            }

            // Periodic check for unsynced paths
            println!("[PrivateFolderSync] Periodic check: scanning for unsynced paths...");
            let sync_path = PathBuf::from(&current_path);
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
                        println!("[PrivateFolderSync] Path {:?} was recently uploaded, skipping periodic check.", path);
                        continue;
                    }
                }

            }

            // Initialize or update watcher
            if watcher.is_none() && sync_path.exists() {
                let (tx, rx) = channel();
                let mut new_watcher: RecommendedWatcher = Watcher::new(tx, notify::Config::default())
                    .expect("[PrivateFolderSync] Failed to create watcher");

                new_watcher
                    .watch(&sync_path, RecursiveMode::Recursive)
                    .expect("[PrivateFolderSync] Failed to watch sync directory");

                let _watcher_account_id = account_id.clone();
                let _watcher_seed_phrase = seed_phrase.clone();
                let _sync_path = sync_path.clone();

                thread::spawn(move || {
                    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime for watcher handler");
                    for res in rx {
                        match res {
                            Ok(event) => rt.block_on(handle_event(event, &_watcher_account_id, &_watcher_seed_phrase, &_sync_path)),
                            Err(e) => eprintln!("[PrivateFolderSync] Watch error: {:?}", e),
                        }
                    }
                });

                println!("[PrivateFolderSync] Started watching private path: {}", current_path);
                watcher = Some(new_watcher);
            }

            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn collect_paths_recursively(dir: &Path, paths: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            paths.push(path.clone());
            if path.is_dir() {
                collect_paths_recursively(&path, paths);
            }
        }
    }
}

fn find_top_level_folder(path: &Path, sync_path: &Path) -> Option<PathBuf> {
    let mut current = path;
    while let Some(parent) = current.parent() {
        if parent == sync_path {
            return Some(current.to_path_buf());
        }
        current = parent;
    }
    None
}

async fn handle_event(event: Event, account_id: &str, seed_phrase: &str, sync_path: &Path) {
    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            let mut folder_paths = HashSet::new();
            let mut file_paths = HashSet::new();

            // Categorize paths into folders and files
            for path in event.paths.iter() {
                let path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[Watcher][Create] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[Watcher][Create] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }
                if path.is_dir() {
                    folder_paths.insert(path.clone());
                } else if path.is_file() {
                    file_paths.insert(path.clone());
                }
                println!("[Watcher][Create] Detected new path: {}", path_str);
            }

            // Filter out files that are inside any folder (including those in the same event)
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

            // Add filtered paths to batch
            {
                let mut batch = CREATE_BATCH.lock().unwrap();
                for (path, is_folder) in &filtered_paths {
                    println!("[Watcher][Create] Adding to batch: {} (is_folder: {})", path.to_string_lossy(), is_folder);
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
                            println!("[Watcher][Create] Processing batch path: {}", path.to_string_lossy());
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
                                        // Double-check if the file is inside a folder already processed
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
                                println!("[Watcher][Create] Path {} no longer exists, skipping.", path.to_string_lossy());
                            }
                        }
                    }
                    println!("[Watcher][Create] Paths to upload after debounce: {:?}", paths);
                    if !paths.is_empty() {
                        {
                            let mut status = SYNC_STATUS.lock().unwrap();
                            status.total_files = paths.len();
                            status.synced_files = 0;
                            status.in_progress = true;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            for (path, is_folder) in paths {
                                let path_str = path.to_string_lossy().to_string();
                                println!("[Watcher][Create] Enqueuing for upload: {} (is_folder: {})", path_str, is_folder);
                                sender
                                    .send(UploadJob {
                                        account_id: account_id.clone(),
                                        seed_phrase: seed_phrase.clone(),
                                        file_path: path_str,
                                        is_folder,
                                    })
                                    .unwrap();
                            }
                        }
                    }
                    CREATE_BATCH_TIMER_RUNNING.store(false, Ordering::SeqCst);
                });
            }
        }
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Name(_)) => {
            for path in event.paths {
                let path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[Watcher][Modify] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                }
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[Watcher][Modify] Path {} is already being uploaded, skipping.", path_str);
                        continue;
                    }
                }

                // Find the top-level folder in the sync directory
                let target_folder = if path.is_dir() && path.parent() == Some(sync_path) {
                    // If the modified path is a top-level folder, target it directly
                    Some(path.to_path_buf())
                } else {
                    // Otherwise, find the top-level folder containing the modified path
                    find_top_level_folder(&path, sync_path)
                };

                if let Some(top_level_folder) = target_folder {
                    let folder_str = top_level_folder.to_string_lossy().to_string();
                    let folder_name = match top_level_folder.file_name().and_then(|s| s.to_str()) {
                        Some(name) => name.to_string(),
                        None => {
                            eprintln!("[Watcher][Modify] Could not extract folder name from path: {}", folder_str);
                            continue;
                        }
                    };

                    println!("[Watcher][Modify] Path {} affects folder {}, re-uploading folder", path_str, folder_str);

                    // Delete existing folder records
                    let delete_result = delete_and_unpin_user_file_records_by_name(&folder_name, seed_phrase, false).await;
                    if delete_result.is_ok() {
                        if let Some(pool) = crate::DB_POOL.get() {
                            let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                                .bind(account_id)
                                .bind(&folder_name)
                                .execute(pool)
                                .await;
                            println!("[Watcher][Modify] Successfully deleted old records for folder '{}'", folder_name);
                        }
                    } else {
                        eprintln!("[Watcher][Modify] Failed to delete/unpin old records for folder '{}'", folder_name);
                        continue;
                    }

                    // Enqueue the folder for upload
                    if let Some(sender) = UPLOAD_SENDER.get() {
                        sender
                            .send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: folder_str.clone(),
                                is_folder: true,
                            })
                            .unwrap();
                        println!("[Watcher][Modify] Enqueued folder for upload: {}", folder_str);
                    }
                } else if path.parent() == Some(sync_path) && path.is_file() {
                    // Handle modifications to top-level files directly in the sync directory
                    replace_path_and_db_records(&path, account_id, seed_phrase).await;
                } else {
                    println!("[Watcher][Modify] Path {} is not in a top-level folder or file, skipping.", path_str);
                }
            }
        }
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Folder) => {
            for path in event.paths {
                let file_name = path.file_name().and_then(|s| s.to_str());
                if let Some(file_name) = file_name {
                    println!("[Watcher] Path deleted from sync folder: {} (is_folder: {})", file_name, path.is_dir());
                    let _is_folder = path.is_dir();
                    let _result = delete_and_unpin_user_file_records_and_dir_by_name(file_name, seed_phrase, false).await;
                    if _result.is_ok() {
                        if let Some(pool) = crate::DB_POOL.get() {
                            let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                                .bind(account_id)
                                .bind(file_name)
                                .execute(pool)
                                .await;
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

async fn upload_path(path: &Path, account_id: &str, seed_phrase: &str, is_folder: bool) -> bool {
    let path_str = path.to_string_lossy().to_string();
    {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        if uploading_files.contains(&path_str) {
            println!("[upload_path] Path {} is already uploading, skipping.", path_str);
            return false;
        }
        uploading_files.insert(path_str.clone());
    }

    let _guard = UPLOAD_LOCK.lock().unwrap();
    let _result = if is_folder {
        encrypt_and_upload_folder_sync(
            account_id.to_string(),
            path_str.clone(),
            seed_phrase.to_string(),
            None,
        ).await
    } else {
        encrypt_and_upload_file_sync(
            account_id.to_string(),
            path_str.clone(),
            seed_phrase.to_string(),
            None
        ).await
    };

    match _result {
        Ok(res) => {
            println!("[upload_path] Successfully uploaded path: {}", res);
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&path_str);
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            recently_uploaded.insert(path_str.clone());
            let path_str_clone = path_str.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                recently_uploaded.remove(&path_str_clone);
            });
            if let Some(pool) = crate::DB_POOL.get() {
                insert_file_if_not_exists(pool, path, account_id, false, is_folder).await;
            }
            true
        }
        Err(e) => {
            eprintln!("[upload_path] Upload failed for {}: {}", path_str, e);
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&path_str);
            false
        }
    }
}

async fn replace_path_and_db_records(path: &Path, account_id: &str, seed_phrase: &str) {
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

    println!("[PrivateFolderSync] Replacing file: {}", file_name);
    let upload_result = upload_path(path, account_id, seed_phrase, false).await;

    if upload_result {
        println!("[PrivateFolderSync] Upload successful for '{}', now cleaning up old records...", file_name);
        let _delete_result = delete_and_unpin_user_file_records_by_name(
            &file_name,
            seed_phrase,
            false,
        ).await;
        if _delete_result.is_err() {
            eprintln!("[PrivateFolderSync] Failed to delete/unpin old records for '{}', but upload succeeded.", file_name);
        } else {
            println!("[PrivateFolderSync] Successfully cleaned up old records for '{}'", file_name);
        }
    } else {
        eprintln!("[PrivateFolderSync] Upload failed for '{}', skipping delete/unpin.", file_name);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
    }
}

#[tauri::command]
pub async fn start_folder_sync_tauri(account_id: String, seed_phrase: String) {
    start_folder_sync(account_id, seed_phrase).await;
}

