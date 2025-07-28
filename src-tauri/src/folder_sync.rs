use crate::commands::ipfs_commands::{encrypt_and_upload_file_sync, encrypt_and_upload_folder};
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

// Module-specific state
pub static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static CREATE_BATCH: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
pub static CREATE_BATCH_TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

pub async fn start_folder_sync(account_id: String, seed_phrase: String) {
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
                // Reset sync status on path change
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                *status = SyncStatus::default();
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
                        println!("[PrivateUploadWorker] Path {} is already uploading, skipping.", path_str);
                        continue;
                    }
                    uploading_files.insert(path_str.clone());
                }

                let result = if job.is_folder {
                    encrypt_and_upload_folder(
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
                        None,
                    ).await
                };

                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    uploading_files.remove(&path_str);
                }

                if result.is_ok() {
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.insert(path_str.clone());
                    let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                    status.synced_files += 1;
                    println!("[PrivateFolderSync] Synced paths: {} / {}", status.synced_files, status.total_files);
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
                    eprintln!("[PrivateUploadWorker] Upload failed for {}: {:?}", path_str, result.err());
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
                "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'private'"
            )
            .bind(&startup_account_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();

            for (db_path, _is_folder) in &db_paths {
                if !dir_paths.contains(db_path) {
                    println!("[PrivateStartup] Path deleted from sync folder: {} (is_folder: {})", db_path, _is_folder);
                    let should_delete_folder = true;
                    let delete_result = delete_and_unpin_user_file_records_by_name(&db_path, &startup_seed_phrase, false, should_delete_folder).await;
                    if delete_result.is_ok() {
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
                        println!("[PrivateStartup] New path detected in sync folder: {} (is_folder: {})", file_name, path.is_dir());
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
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
                status.total_files = new_paths_to_upload.len();
                status.synced_files = 0;
                status.in_progress = true;
            } else {
                let mut status = PRIVATE_SYNC_STATUS.lock().unwrap();
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
                        println!("[PrivateFolderSync] Path {:?} was recently uploaded, skipping periodic check.", path);
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

async fn handle_event(event: Event, account_id: &str, seed_phrase: &str, sync_path: &Path) {
    let filtered_paths = event.paths.into_iter().filter(|path| {
        if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
            !file_name.starts_with('.') && !file_name.contains("goutputstream")
        } else {
            false
        }
    }).collect::<Vec<_>>();

    if filtered_paths.is_empty() {
        println!("[PrivateWatcher] Skipping event with only temporary or invalid paths.");
        return;
    }

    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            let mut folder_paths = HashSet::new();
            let mut file_paths = HashSet::new();

            for path in filtered_paths.iter() {
                let path_str = path.to_string_lossy().to_string();
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
                            status.total_files = paths.len();
                            status.synced_files = 0;
                            status.in_progress = true;
                        }
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            for (path, is_folder) in paths {
                                let path_str = path.to_string_lossy().to_string();
                                println!("[PrivateWatcher][Create] Enqueuing for upload: {} (is_folder: {})", path_str, is_folder);
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
            for path in filtered_paths {
                let path_str = path.to_string_lossy().to_string();
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

                if path.parent() == Some(sync_path) {
                    if path.is_file() {
                        println!("[PrivateWatcher][Modify] Detected modification to top-level file: {}", path_str);
                        replace_path_and_db_records(&path, account_id, seed_phrase).await;
                    } else if path.is_dir() {
                        let folder_name = match path.file_name().and_then(|s| s.to_str()) {
                            Some(name) => name.to_string(),
                            None => {
                                eprintln!("[PrivateWatcher][Modify] Could not extract folder name from path: {}", path_str);
                                continue;
                            }
                        };
                        println!("[PrivateWatcher][Modify] Detected modification to top-level folder: {}", folder_name);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&folder_name, seed_phrase, false, should_delete_folder).await;
                        if delete_result.is_ok() {
                            if let Some(pool) = crate::DB_POOL.get() {
                                let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                                    .bind(account_id)
                                    .bind(&folder_name)
                                    .execute(pool)
                                    .await;
                                println!("[PrivateWatcher][Modify] Successfully deleted old records for folder '{}'", folder_name);
                            }
                        } else {
                            eprintln!("[PrivateWatcher][Modify] Failed to delete/unpin old records for folder '{}'", folder_name);
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
                            println!("[PrivateWatcher][Modify] Enqueued folder for upload: {}", path_str);
                        }
                    }
                } else {
                    if let Some(top_level_folder) = find_top_level_folder(&path, sync_path) {
                        let folder_str = top_level_folder.to_string_lossy().to_string();
                        let folder_name = match top_level_folder.file_name().and_then(|s| s.to_str()) {
                            Some(name) => name.to_string(),
                            None => {
                                eprintln!("[PrivateWatcher][Modify] Could not extract folder name from path: {}", folder_str);
                                continue;
                            }
                        };
                        println!("[PrivateWatcher][Modify] Path {} affects folder {}, re-uploading folder", path_str, folder_str);
                        let should_delete_folder = false;
                        let delete_result = delete_and_unpin_user_file_records_by_name(&folder_name, seed_phrase, false, should_delete_folder).await;
                        if delete_result.is_ok() {
                            if let Some(pool) = crate::DB_POOL.get() {
                                let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                                    .bind(account_id)
                                    .bind(&folder_name)
                                    .execute(pool)
                                    .await;
                                println!("[PrivateWatcher][Modify] Successfully deleted old records for folder '{}'", folder_name);
                            }
                        } else {
                            eprintln!("[PrivateWatcher][Modify] Failed to delete/unpin old records for folder '{}'", folder_name);
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
                            println!("[PrivateWatcher][Modify] Enqueued folder for upload: {}", folder_str);
                        }
                    } else {
                        println!("[PrivateWatcher][Modify] Path {} is not in a top-level folder or file, skipping.", path_str);
                    }
                }
            }
        }
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Folder) => {
            for path in filtered_paths {
                let file_name = path.file_name().and_then(|s| s.to_str());
                if let Some(file_name) = file_name {
                    println!("[PrivateWatcher] Path deleted from sync folder: {} (is_folder: {})", file_name, path.is_dir());
                    let should_delete_folder = true;
                    let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, false, should_delete_folder).await;
                    if delete_result.is_ok() {
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
            println!("[PrivateUploadPath] Path {} is already uploading, skipping.", path_str);
            return false;
        }
        uploading_files.insert(path_str.clone());
    }

    let _guard = UPLOAD_LOCK.lock().unwrap();
    let result = if is_folder {
        encrypt_and_upload_folder(
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
            None,
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
            eprintln!("[PrivateUploadPath] Upload failed for {}: {}", path_str, e);
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
    
    // First delete the old records
    println!("[PrivateFolderSync] Cleaning up old records for '{}' before upload...", file_name);
    let should_delete_folder = false;
    let delete_result = delete_and_unpin_user_file_records_by_name(&file_name, seed_phrase, false, should_delete_folder).await;
    
    if delete_result.is_err() {
        eprintln!("[PrivateFolderSync] Failed to delete/unpin old records for '{}', aborting upload.", file_name);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
        return;
    }
    
    println!("[PrivateFolderSync] Successfully cleaned up old records for '{}', proceeding with upload...", file_name);
    
    // Then upload the new file
    let upload_result = upload_path(path, account_id, seed_phrase, false).await;

    if upload_result {
        println!("[PrivateFolderSync] Upload successful for '{}'", file_name);
    } else {
        eprintln!("[PrivateFolderSync] Upload failed for '{}' after deleting old records", file_name);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
    }
}

#[tauri::command]
pub async fn start_folder_sync_tauri(account_id: String, seed_phrase: String) {
    start_folder_sync(account_id, seed_phrase).await;
}