use crate::commands::ipfs_commands::{upload_file_public_sync, public_upload_folder};
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
pub use crate::sync_shared::{SYNCING_ACCOUNTS, find_top_level_folder, UPLOAD_LOCK, UploadJob, insert_file_if_not_exists, PUBLIC_SYNC_STATUS};
use once_cell::sync::Lazy;

// Module-specific state
pub static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static CREATE_BATCH: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
pub static CREATE_BATCH_TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

pub async fn start_public_folder_sync(account_id: String, seed_phrase: String) {
    loop {
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
        if let Ok(sync_path) = sync_path_result {
            println!("[PublicFolderSync] Public sync path found: {}, starting sync process", sync_path);
            start_sync_process(
                account_id.clone(),
                seed_phrase.clone(),
                sync_path,
                Arc::clone(&cancel_token),
                path_change_tx.clone(),
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
                // Reset sync status on path change
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                *status = SyncStatus::default();
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
    if UPLOAD_SENDER.get().is_none() {
        let (tx, mut rx) = mpsc::unbounded_channel::<UploadJob>();
        UPLOAD_SENDER.set(tx).ok();
        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                let path_str = job.file_path.clone();
                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[PublicUploadWorker] Path {} is already uploading, skipping.", path_str);
                        continue;
                    }
                    uploading_files.insert(path_str.clone());
                }

                let result = if job.is_folder {
                    public_upload_folder(
                        job.account_id.clone(),
                        job.file_path.clone(),
                        job.seed_phrase.clone(),
                    ).await
                } else {
                    upload_file_public_sync(
                        job.account_id.clone(),
                        job.file_path.clone(),
                        job.seed_phrase.clone(),
                    ).await
                };

                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    uploading_files.remove(&path_str);
                }

                if result.is_ok() {
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.insert(path_str.clone());
                    let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                    status.synced_files += 1;
                    println!("[PublicFolderSync] Synced paths: {} / {}", status.synced_files, status.total_files);
                    if status.synced_files >= status.total_files && status.total_files > 0 {
                        status.in_progress = false;
                    }
                    let path_str_clone = path_str.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        recently_uploaded.remove(&path_str_clone);
                    });
                } else {
                    eprintln!("[PublicUploadWorker] Upload failed for {}: {:?}", path_str, result.err());
                }

                tokio::time::sleep(Duration::from_secs(1)).await; // Reduced delay for faster processing
            }
        });
    }

    let startup_account_id = account_id.clone();
    let startup_seed_phrase = seed_phrase.clone();
    let sync_path_cloned = sync_path.clone();
    tokio::spawn(async move {
        if let Some(pool) = crate::DB_POOL.get() {
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

            let dir_paths: HashSet<String> = folder_paths.iter()
                .chain(file_paths.iter())
                .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
                .collect();

            let db_paths: Vec<(String, bool)> = sqlx::query_as(
                "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'public'"
            )
            .bind(&startup_account_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();

            for (db_path, _is_folder) in &db_paths {
                if !dir_paths.contains(db_path) {
                    println!("[PublicStartup] Path deleted from sync folder: {} (is_folder: {})", db_path, _is_folder);
                    let should_delete_folder = true;
                    let delete_result = delete_and_unpin_user_file_records_by_name(&db_path, &startup_seed_phrase, true, should_delete_folder).await;
                    if delete_result.is_ok() {
                        let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'")
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
                        println!("[PublicStartup] New path detected in sync folder: {} (is_folder: {})", file_name, path.is_dir());
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
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                status.total_files = new_paths_to_upload.len();
                status.synced_files = 0;
                status.in_progress = true;
            } else {
                let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                status.in_progress = false;
            }
        }
    });

    spawn_watcher_thread(account_id, seed_phrase, PathBuf::from(sync_path), cancel_token, path_change_tx);
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
        
        // Create a channel for path changes
        let (tx, rx) = std::sync::mpsc::channel();
        
        // Create the watcher with the recommended API
        let mut watcher = match notify::recommended_watcher(move |res| {
            match res {
                Ok(event) => {
                    println!("[Watcher] Raw event: {:?}", event);
                    if let Err(e) = tx.send(event) {
                        eprintln!("[Watcher] Error sending event: {}", e);
                    }
                }
                Err(e) => eprintln!("[Watcher] Error: {}", e),
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[PublicFolderSync] Failed to create watcher: {}", e);
                return;
            }
        };

        // Watch the sync path recursively
        if let Err(e) = watcher.watch(&sync_path, RecursiveMode::Recursive) {
            eprintln!("[PublicFolderSync] Failed to watch path {}: {}", current_path, e);
            return;
        }

        println!("[PublicFolderSync] Started watching public path: {}", current_path);

        // Main event loop
        'outer: loop {
            if cancel_token.load(Ordering::SeqCst) {
                println!("[PublicFolderSync] Stopped watching path: {}", current_path);
                break;
            }

            // Check for path changes
            match rt.block_on(get_public_sync_path()) {
                Ok(latest_path) => {
                    let latest_path = PathBuf::from(latest_path);
                    if latest_path != sync_path {
                        if let Ok(latest_path_str) = latest_path.into_os_string().into_string() {
                            if rt.block_on(path_change_tx.send(latest_path_str.clone())).is_ok() {
                                println!("[PublicFolderSync] Sent path change notification: {}", latest_path_str);
                            } else {
                                eprintln!("[PublicFolderSync] Failed to send path change notification");
                            }
                            break 'outer;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[PublicFolderSync] Failed to get public sync path: {}", e);
                    thread::sleep(Duration::from_secs(5));
                    continue;
                }
            }

            // Process file system events with a timeout
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(event) => {
                    rt.block_on(handle_event(event, &account_id, &seed_phrase, &sync_path));
                    // Process any additional events that came in while we were handling this one
                    while let Ok(event) = rx.try_recv() {
                        rt.block_on(handle_event(event, &account_id, &seed_phrase, &sync_path));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // No events, continue the loop
                    continue;
                }
                Err(e) => {
                    eprintln!("[PublicFolderSync] Error receiving event: {}", e);
                    break 'outer;
                }
            }
        }
        
        // Clean up the watcher
        if let Err(e) = watcher.unwatch(&sync_path) {
            eprintln!("[PublicFolderSync] Error unwatching path: {}", e);
        }
        
        println!("[PublicFolderSync] Watcher thread exiting for account {}", account_id);
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

async fn handle_event(event: Event, account_id: &str, seed_phrase: &str, sync_path: &Path) {
    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            let mut folder_paths = HashSet::new();
            let mut file_paths = HashSet::new();

            for path in event.paths.iter() {
                let path_str = path.to_string_lossy().to_string();
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
                if path.is_dir() {
                    folder_paths.insert(path.clone());
                } else if path.is_file() {
                    file_paths.insert(path.clone());
                }
                println!("[PublicWatcher][Create] Detected new path: {}", path_str);
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
                    println!("[PublicWatcher][Create] Adding to batch: {} (is_folder: {})", path.to_string_lossy(), is_folder);
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
                                println!("[PublicWatcher][Create] Path {} no longer exists, skipping.", path.to_string_lossy());
                            }
                        }
                    }
                    println!("[PublicWatcher][Create] Paths to upload after debounce: {:?}", paths);
                    if !paths.is_empty() {
                        {
                            let mut status = PUBLIC_SYNC_STATUS.lock().unwrap();
                            status.total_files = paths.len();
                            status.synced_files = 0;
                            status.in_progress = true;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            for (path, is_folder) in paths {
                                let path_str = path.to_string_lossy().to_string();
                                println!("[PublicWatcher][Create] Enqueuing for upload: {} (is_folder: {})", path_str, is_folder);
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
            let filtered_paths = event.paths.into_iter().filter(|path| {
                if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                    !file_name.starts_with('.') && !file_name.contains("goutputstream")
                } else {
                    false
                }
            }).collect::<Vec<_>>();
        
            if filtered_paths.is_empty() {
                println!("[PublicWatcher] Skipping event with only temporary or invalid paths.");
                return;
            }        
            for path in filtered_paths {
                let path_str = path.to_string_lossy().to_string();
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

                if path.parent() == Some(sync_path) {
                    if path.is_file() {
                        println!("[PublicWatcher][Modify] Detected modification to top-level file: {}", path_str);
                        replace_path_and_db_records(&path, account_id, seed_phrase).await;
                    } else if path.is_dir() {
                        let folder_name = match path.file_name().and_then(|s| s.to_str()) {
                            Some(name) => name.to_string(),
                            None => {
                                eprintln!("[PublicWatcher][Modify] Could not extract folder name from path: {}", path_str);
                                continue;
                            }
                        };
                        println!("[PublicWatcher][Modify] Detected modification to top-level folder: {}", folder_name);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&folder_name, seed_phrase, true, should_delete_folder).await;
                        if delete_result.is_ok() {
                            if let Some(pool) = crate::DB_POOL.get() {
                                let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'")
                                    .bind(account_id)
                                    .bind(&folder_name)
                                    .execute(pool)
                                    .await;
                                println!("[PublicWatcher][Modify] Successfully deleted old records for folder '{}'", folder_name);
                            }
                        } else {
                            eprintln!("[PublicWatcher][Modify] Failed to delete/unpin old records for folder '{}'", folder_name);
                            continue;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            sender
                                .send(UploadJob {
                                    account_id: account_id.to_string(),
                                    seed_phrase: seed_phrase.to_string(),
                                    file_path: path_str.clone(),
                                    is_folder: true,
                                })
                                .unwrap();
                            println!("[PublicWatcher][Modify] Enqueued folder for upload: {}", path_str);
                        }
                    }
                } else {
                    if let Some(top_level_folder) = find_top_level_folder(&path, sync_path) {
                        let folder_str = top_level_folder.to_string_lossy().to_string();
                        let folder_name = match top_level_folder.file_name().and_then(|s| s.to_str()) {
                            Some(name) => name.to_string(),
                            None => {
                                eprintln!("[PublicWatcher][Modify] Could not extract folder name from path: {}", folder_str);
                                continue;
                            }
                        };
                        println!("[PublicWatcher][Modify] Path {} affects folder {}, re-uploading folder", path_str, folder_str);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&folder_name, seed_phrase, true, should_delete_folder).await;
                        if delete_result.is_ok() {
                            if let Some(pool) = crate::DB_POOL.get() {
                                let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'")
                                    .bind(account_id)
                                    .bind(&folder_name)
                                    .execute(pool)
                                    .await;
                            }
                        } else {
                            eprintln!("[PublicWatcher][Modify] Failed to delete/unpin old records for folder '{}'", folder_name);
                            continue;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            sender
                                .send(UploadJob {
                                    account_id: account_id.to_string(),
                                    seed_phrase: seed_phrase.to_string(),
                                    file_path: folder_str.clone(),
                                    is_folder: true,
                                })
                                .unwrap();
                            println!("[PublicWatcher][Modify] Enqueued folder for upload: {}", folder_str);
                        }
                    } else {
                        println!("[PublicWatcher][Modify] Path {} is not in a top-level folder or file, skipping.", path_str);
                    }
                }
            }
        }
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Folder) => {
            for path in event.paths {
                let path_str = path.to_string_lossy().to_string();
                println!("[PublicWatcher][Remove] Raw event path: {}", path_str);
                
                // Normalize paths for comparison
                let sync_path = sync_path.canonicalize().unwrap_or_else(|_| sync_path.to_path_buf());
                let parent = path.parent().map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()));
                
                // Check if the path is directly in the sync directory
                if let Some(parent) = parent {
                    if parent == sync_path {
                        // This is a top-level file/folder deletion
                        if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                            println!("[PublicWatcher][Remove] Detected deletion of top-level item: {}", path_str);
                            let should_delete_folder = true;
                            match delete_and_unpin_user_file_records_by_name(
                                file_name, 
                                seed_phrase, 
                                true, 
                                should_delete_folder
                            ).await {
                                Ok(count) => {
                                    println!("[PublicWatcher][Remove] Deleted {} records for: {}", count, file_name);
                                    if let Some(pool) = crate::DB_POOL.get() {
                                        let _ = sqlx::query(
                                            "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
                                        )
                                        .bind(account_id)
                                        .bind(file_name)
                                        .execute(pool)
                                        .await;
                                    }
                                },
                                Err(e) => eprintln!("[PublicWatcher][Remove] Error deleting records for {}: {}", file_name, e),
                            }
                        }
                    } else {
                        // This is a nested file/folder deletion - find the top-level folder
                        if let Some(top_level_folder) = find_top_level_folder(&path, &sync_path) {
                            if let Some(folder_name) = top_level_folder.file_name().and_then(|s| s.to_str()) {
                                println!("[PublicWatcher][Remove] Parent folder to re-upload: {}", folder_name);
                                
                                // Mark the folder for re-upload since its contents changed
                                let should_delete_folder = false;
                                if let Ok(_) = delete_and_unpin_user_file_records_by_name(
                                    folder_name, 
                                    seed_phrase, 
                                    true, 
                                    should_delete_folder
                                ).await {
                                    if let Some(pool) = crate::DB_POOL.get() {
                                        let _ = sqlx::query(
                                            "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
                                        )
                                        .bind(account_id)
                                        .bind(folder_name)
                                        .execute(pool)
                                        .await;
                                    }
                                    
                                    // Queue the folder for re-upload
                                    if let Some(sender) = UPLOAD_SENDER.get() {
                                        let _ = sender.send(UploadJob {
                                            account_id: account_id.to_string(),
                                            seed_phrase: seed_phrase.to_string(),
                                            file_path: top_level_folder.to_string_lossy().to_string(),
                                            is_folder: true,
                                        });
                                        println!("[PublicWatcher][Remove] Enqueued folder for re-upload: {}", folder_name);
                                    }
                                }
                            }
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
            println!("[PublicUploadPath] Path {} is already uploading, skipping.", path_str);
            return false;
        }
        uploading_files.insert(path_str.clone());
    }

    let _guard = UPLOAD_LOCK.lock().unwrap();
    let result = if is_folder {
        public_upload_folder(
            account_id.to_string(),
            path_str.clone(),
            seed_phrase.to_string(),
        ).await
    } else {
        upload_file_public_sync(
            account_id.to_string(),
            path_str.clone(),
            seed_phrase.to_string(),
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
                tokio::time::sleep(Duration::from_secs(2)).await;
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

async fn replace_path_and_db_records(path: &Path, account_id: &str, seed_phrase: &str) {
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
    
    // First delete the old records
    println!("[PublicFolderSync] Cleaning up old records for '{}' before upload...", file_name);
    let should_delete_folder = false;
    let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, true, should_delete_folder).await;
    
    if delete_result.is_err() {
        eprintln!("[PublicFolderSync] Failed to delete/unpin old records for '{}', aborting upload.", file_name);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
        return;
    }
    
    println!("[PublicFolderSync] Successfully cleaned up old records for '{}', proceeding with upload...", file_name);
    
    // Then upload the new file
    let upload_result = upload_path(path, account_id, seed_phrase, false).await;

    if upload_result {
        println!("[PublicFolderSync] Upload successful for '{}'", file_name);
    } else {
        eprintln!("[PublicFolderSync] Upload failed for '{}' after deleting old records", file_name);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
    }
}

#[tauri::command]
pub async fn start_public_folder_sync_tauri(account_id: String, seed_phrase: String) {
    start_public_folder_sync(account_id, seed_phrase).await;
}