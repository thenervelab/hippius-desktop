use crate::commands::ipfs_commands::{upload_file_public, public_upload_folder};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use crate::utils::sync::get_public_sync_path;
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
use crate::sync_shared::{SYNCING_ACCOUNTS, UPLOAD_SENDER, UPLOADING_FILES, RECENTLY_UPLOADED, SYNC_STATUS, 
    UPLOAD_LOCK, RECENTLY_UPLOADED_FOLDERS, CREATE_BATCH, CREATE_BATCH_TIMER_RUNNING, UploadJob, insert_file_if_not_exists, collect_files_and_folders_recursively};


pub async fn start_public_folder_sync(account_id: String, seed_phrase: String) {
    println!("started sycn");
    // Check if this account is already syncing publicly
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&(account_id.clone(), "public")) {
            println!(
                "[FolderSync] Account {} is already syncing publicly, skipping.",
                account_id
            );
            return;
        }
        syncing_accounts.insert((account_id.clone(), "public"));
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


                let result = if job.is_folder {
                    // BEFORE uploading folder, add all files inside to recently uploaded to prevent race condition
                    let folder_path = std::path::Path::new(&job.file_path);
                    let mut files_in_folder = Vec::new();
                    collect_files_recursively(folder_path, &mut files_in_folder);
                    
                    {
                        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        for file_path in &files_in_folder {
                            let file_path_str = file_path.to_string_lossy().to_string();
                            recently_uploaded.insert(file_path_str.clone());
                            println!("[UploadWorker] Pre-emptively added file to recently uploaded (before folder upload): {}", file_path_str);
                        }
                    }
                    
                    // Also add the folder itself to recently uploaded folders
                    {
                        let mut recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
                        recently_uploaded_folders.insert(job.file_path.clone());
                    }
                    
                    // Now upload the entire folder
                    let result = public_upload_folder(
                        job.account_id.clone(),
                        job.file_path.clone(),
                        job.seed_phrase.clone(),
                    )
                    .await;
                    
                    // If folder upload failed, remove files from recently uploaded
                    if result.is_err() {
                        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        for file_path in files_in_folder {
                            let file_path_str = file_path.to_string_lossy().to_string();
                            recently_uploaded.remove(&file_path_str);
                            println!("[UploadWorker] Removed file from recently uploaded due to folder upload failure: {}", file_path_str);
                        }
                        
                        let mut recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
                        recently_uploaded_folders.remove(&job.file_path);
                    }
                    
                    result
                } else {
                    // Upload individual file
                    upload_file_public(
                        job.account_id.clone(),
                        job.file_path.clone(),
                        job.seed_phrase.clone(),
                    )
                    .await
                };

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

                // Remove from recently uploaded after 30 seconds
                let file_path_str_clone = file_path_str.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    recently_uploaded.remove(&file_path_str_clone);
                });

                tokio::time::sleep(Duration::from_secs(6)).await;
            }
        });
    }

    if let Some(pool) = crate::DB_POOL.get() {
        println!("getting sync path ");
        let sync_path = PathBuf::from(&get_public_sync_path().await);
        println!("got synced path ");
        let mut items = Vec::new();
        collect_files_and_folders_recursively(&sync_path, &mut items);
        let dir_items: HashSet<String> = items.iter()
            .filter_map(|p: &PathBuf| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
            .collect();
    
        // Fetch both files and folders from the database
        let db_items: Vec<(String, bool)> = sqlx::query_as::<_, (String, bool)>(
            "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'public'"
        )
        .bind(&account_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let db_folders: HashSet<String> = db_items.iter().filter(|(_, is_folder)| *is_folder).map(|(n, _)| n.clone()).collect();
        let db_files: HashSet<String> = db_items.iter().filter(|(_, is_folder)| !*is_folder).map(|(n, _)| n.clone()).collect();
    
        // Handle deleted items (in DB, not in folder)
        for (db_item, is_folder) in &db_items {
            if !dir_items.contains(db_item) {
                println!("[Startup] public Item deleted from sync folder: {}", db_item);
                let result = delete_and_unpin_user_file_records_by_name(db_item, &seed_phrase, true).await;
                if result.is_ok() {
                    let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'")
                        .bind(&account_id)
                        .bind(db_item)
                        .execute(pool)
                        .await;
                }
            }
        }
    
        // Handle new items (in folder, not in DB)
        let mut new_files_to_upload = Vec::new();
        let mut folders_to_upload = Vec::new();
    
        for item_path in &items {
            let file_name = item_path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
            if let Some(file_name) = file_name {
                let is_folder = item_path.is_dir();
                if is_folder {
                    if !db_folders.contains(&file_name) {
                        println!("[Startup] New folder detected in sync folder: {}", file_name);
                        folders_to_upload.push(item_path.clone());
                    }
                } else {
                    // Check if file is inside any folder being uploaded or already in DB
                    let file_path_str = item_path.to_string_lossy().to_string();
                    let skip = folders_to_upload.iter().any(|folder_path| {
                        file_path_str.starts_with(&folder_path.to_string_lossy().to_string()) && file_path_str != folder_path.to_string_lossy().to_string()
                    }) || db_folders.iter().any(|folder_name| {
                        let folder_abs = sync_path.join(folder_name);
                        file_path_str.starts_with(&folder_abs.to_string_lossy().to_string()) && file_path_str != folder_abs.to_string_lossy().to_string()
                    });
                    if skip {
                        println!("[Startup] Skipping file inside folder being uploaded or already in DB: {}", file_path_str);
                        continue;
                    }
                    if !db_files.contains(&file_name) {
                        println!("[Startup] New file detected in sync folder: {}", file_name);
                        new_files_to_upload.push(item_path.clone());
                    }
                }
            }
        }
    
        // Enqueue folders first
        if let Some(sender) = UPLOAD_SENDER.get() {
            for folder_path in &folders_to_upload {
                sender
                    .send(UploadJob {
                        account_id: account_id.clone(),
                        seed_phrase: seed_phrase.clone(),
                        file_path: folder_path.to_string_lossy().to_string(),
                        is_folder: true,
                    })
                    .unwrap();
            }
            // Then enqueue individual files
            for file_path in &new_files_to_upload {
                sender
                    .send(UploadJob {
                        account_id: account_id.clone(),
                        seed_phrase: seed_phrase.clone(),
                        file_path: file_path.to_string_lossy().to_string(),
                        is_folder: false,
                    })
                    .unwrap();
            }
        }
    
        // Set sync status for startup new items
        if !new_files_to_upload.is_empty() || !folders_to_upload.is_empty() {
            let mut status = SYNC_STATUS.lock().unwrap();
            status.total_files = new_files_to_upload.len() + folders_to_upload.len();
            status.synced_files = 0;
            status.in_progress = true;
        }
    }

    let sync_path = PathBuf::from(&get_public_sync_path().await);
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
            let sync_path_str = tauri::async_runtime::block_on(get_public_sync_path());
            let sync_path = PathBuf::from(&sync_path_str);

            // Recursively collect all files in sync_path
            let mut files_to_check = Vec::new();
            collect_files_recursively(&sync_path, &mut files_to_check);

            // Fetch all folder paths from DB (is_folder = true)
            let db_folders: HashSet<String> = if let Some(pool) = crate::DB_POOL.get() {
                let db_items: Vec<(String, bool)> = tauri::async_runtime::block_on(async {
                    sqlx::query_as::<_, (String, bool)>(
                        "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'public'"
                    )
                    .bind(&checker_account_id)
                    .fetch_all(pool)
                    .await
                    .unwrap_or_default()
                });
                db_items.iter().filter(|(_, is_folder)| *is_folder).map(|(n, _)| n.clone()).collect()
            } else {
                HashSet::new()
            };
            let recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();

            for file_path in files_to_check {
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
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) {
                        println!("[FolderSync] File {:?} was recently uploaded, skipping periodic check.", file_path);
                        continue;
                    }
                }
                // Skip if file is inside any folder in DB or recently uploaded folders
                let skip = db_folders.iter().any(|folder_name| {
                    let folder_abs = sync_path.join(folder_name);
                    file_path_str.starts_with(&folder_abs.to_string_lossy().to_string()) && file_path_str != folder_abs.to_string_lossy().to_string()
                }) || recently_uploaded_folders.iter().any(|folder_path| {
                    file_path_str.starts_with(folder_path) && file_path_str != *folder_path
                });
                if skip {
                    println!("[FolderSync] Skipping file in periodic check, already in DB or inside uploading folder: {}", file_path_str);
                    continue;
                }
                // Check if file or folder is in DB
                let file_name = file_path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
                if let Some(file_name) = file_name {
                    let is_folder = file_path.is_dir();
                    let already_in_db = if let Some(pool) = crate::DB_POOL.get() {
                        let exists: Option<(String,)> = tauri::async_runtime::block_on(async {
                            sqlx::query_as(
                                "SELECT file_name FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' AND is_folder = ? LIMIT 1"
                            )
                            .bind(&checker_account_id)
                            .bind(&file_name)
                            .bind(is_folder)
                            .fetch_optional(pool)
                            .await
                        }).unwrap_or(None);
                        exists.is_some()
                    } else {
                        false
                    };
                    if !already_in_db {
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            sender
                                .send(UploadJob {
                                    account_id: checker_account_id.clone(),
                                    seed_phrase: seed_phrase.clone(),
                                    file_path: file_path_str.clone(),
                                    is_folder,
                                })
                                .unwrap();
                            println!("[FolderSync] Periodic check enqueued {} for upload: {}", 
                                     if is_folder { "folder" } else { "file" }, file_path_str);
                        }
                    } else {
                        println!("[FolderSync] Skipping {} in periodic check, already in DB: {}", 
                                 if is_folder { "folder" } else { "file" }, file_path_str);
                    }
                }
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
            let sync_path_str = tauri::async_runtime::block_on(get_public_sync_path());

            if sync_path_str != current_path {
                // Path changed, stop old watcher if exists
                if let Some(w) = watcher.take() {
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

// Helper: Check if a file is inside any folder in a set
fn is_inside_any_folder(file_path: &str, folders: &std::collections::HashSet<String>) -> bool {
    folders.iter().any(|folder| {
        file_path.starts_with(folder)
            && file_path != folder // not the folder itself
    })
}

fn handle_event(event: Event, account_id: &str, seed_phrase: &str) {
    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            // Add all paths to the batch
            for path in event.paths.iter() {
                let file_path_str = path.to_string_lossy().to_string();
                println!("[Watcher][Create] Detected new path: {}", file_path_str);

                // Skip if file or folder was recently uploaded
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    let recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) || recently_uploaded_folders.contains(&file_path_str) {
                        println!("[Watcher][Create] Skipping recently uploaded: {}", file_path_str);
                        continue;
                    }
                    // Check if the path is inside a recently uploaded folder
                    if is_inside_any_folder(&file_path_str, &recently_uploaded_folders) {
                        println!("[Watcher][Create] Skipping file inside recently uploaded folder: {}", file_path_str);
                        continue;
                    }
                }
                // Skip if file or folder is already being uploaded
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&file_path_str) {
                        println!("[Watcher][Create] Skipping, already uploading: {}", file_path_str);
                        continue;
                    }
                }
                // Check if folder is already in DB
                let file_name = path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
                if let Some(file_name) = file_name {
                    let is_folder = path.is_dir();
                    let already_in_db = if let Some(pool) = crate::DB_POOL.get() {
                        let exists: Option<(String,)> = tauri::async_runtime::block_on(async {
                            sqlx::query_as(
                                "SELECT file_name FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' AND is_folder = ? LIMIT 1"
                            )
                            .bind(account_id)
                            .bind(&file_name)
                            .bind(is_folder)
                            .fetch_optional(pool)
                            .await
                        }).unwrap_or(None);
                        exists.is_some()
                    } else {
                        false
                    };
                    if already_in_db {
                        println!("[Watcher][Create] Skipping {} already in DB: {}", 
                                 if is_folder { "folder" } else { "file" }, file_path_str);
                        continue;
                    }
                }
                // Check if file is inside any folder being uploaded in this batch
                {
                    let batch = CREATE_BATCH.lock().unwrap();
                    if path.is_file() && batch.iter().any(|p| p.is_dir() && file_path_str.starts_with(&p.to_string_lossy().to_string())) {
                        println!("[Watcher][Create] Skipping file inside folder being uploaded in batch: {}", file_path_str);
                        continue;
                    }
                }
                println!("[Watcher][Create] Adding to batch: {}", file_path_str);
                CREATE_BATCH.lock().unwrap().push(path.clone());
            }

            // Start debounce timer if not already running
            if !CREATE_BATCH_TIMER_RUNNING.swap(true, Ordering::SeqCst) {
                let account_id = account_id.to_string();
                let seed_phrase = seed_phrase.to_string();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(200));
                    let mut files = Vec::new();
                    let mut folders_to_upload = Vec::new();
                    {
                        let mut batch = CREATE_BATCH.lock().unwrap();
                        for path in batch.drain(..) {
                            println!("[Watcher][Create] Processing batch path: {}", path.to_string_lossy());

                            // Wait up to 2 seconds for the file/folder to appear and stabilize
                            let mut retries = 20;
                            while retries > 0 && !path.exists() {
                                std::thread::sleep(std::time::Duration::from_millis(100));
                                retries -= 1;
                            }

                            if !path.exists() {
                                println!("[Watcher][Create] Path no longer exists after waiting: {}", path.to_string_lossy());
                                continue;
                            }

                            if path.is_dir() {
                                // Check if folder is already in DB
                                let folder_name = path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
                                if let Some(folder_name) = folder_name {
                                    let already_in_db = if let Some(pool) = crate::DB_POOL.get() {
                                        let exists: Option<(String,)> = tauri::async_runtime::block_on(async {
                                            sqlx::query_as(
                                                "SELECT file_name FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' AND is_folder = 1 LIMIT 1"
                                            )
                                            .bind(&account_id)
                                            .bind(&folder_name)
                                            .bind("public")
                                            .fetch_optional(pool)
                                            .await
                                        }).unwrap_or(None);
                                        exists.is_some()
                                    } else {
                                        false
                                    };

                                    if already_in_db {
                                        println!("[Watcher][Create] Folder {} already in DB, skipping", folder_name);
                                        continue;
                                    }

                                    folders_to_upload.push(path.clone());
                                    println!("[Watcher][Create] Folder detected, will upload as single unit: {}", path.to_string_lossy());
                                }
                            } else if path.is_file() {
                                // Check if file is inside a folder being uploaded
                                let file_path_str = path.to_string_lossy().to_string();
                                if folders_to_upload.iter().any(|folder_path| {
                                    file_path_str.starts_with(&folder_path.to_string_lossy().to_string()) && file_path_str != folder_path.to_string_lossy().to_string()
                                }) {
                                    println!("[Watcher][Create] Skipping file inside folder being uploaded: {}", file_path_str);
                                    continue;
                                }

                                // Optionally, wait for file size to stabilize
                                let mut last_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                let mut stable = false;
                                for _ in 0..10 {
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    let new_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                    if new_size == last_size {
                                        stable = true;
                                        break;
                                    }
                                    last_size = new_size;
                                }
                                if stable {
                                    files.push(path.clone());
                                } else {
                                    println!("[Watcher][Create] File did not stabilize in time: {}", path.to_string_lossy());
                                }
                            } else {
                                println!("[Watcher][Create] Path is neither file nor dir after waiting: {}", path.to_string_lossy());
                            }
                        }
                    }

                    let total_items = files.len() + folders_to_upload.len();
                    println!("[Watcher][Create] Files to upload after debounce: {:?}", files);
                    println!("[Watcher][Create] Folders to upload after debounce: {:?}", folders_to_upload);

                    if total_items > 0 {
                        // Set sync status for the batch
                        {
                            let mut status = SYNC_STATUS.lock().unwrap();
                            status.total_files = total_items;
                            status.synced_files = 0;
                            status.in_progress = true;
                        }

                        // Enqueue folders for upload
                        if let Some(sender) = UPLOAD_SENDER.get() {
                            for folder_path in folders_to_upload {
                                let folder_name = folder_path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
                                if let Some(folder_name) = folder_name {
                                    println!("[Watcher][Create] Enqueuing folder for upload: {}", folder_path.to_string_lossy());
                                    sender
                                        .send(UploadJob {
                                            account_id: account_id.clone(),
                                            seed_phrase: seed_phrase.clone(),
                                            file_path: folder_path.to_string_lossy().to_string(),
                                            is_folder: true,
                                        })
                                        .unwrap();
                                }
                            }

                            // Enqueue individual files for upload
                            for file_path in files {
                                let file_path_str = file_path.to_string_lossy().to_string();
                                let file_name = file_path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string());
                                if let Some(file_name) = file_name {
                                    // Check DB before enqueue
                                    let already_in_db = if let Some(pool) = crate::DB_POOL.get() {
                                        let exists: Option<(String,)> = tauri::async_runtime::block_on(async {
                                            sqlx::query_as(
                                                "SELECT file_name FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
                                            )
                                            .bind(&account_id)
                                            .bind(&file_name)
                                            .bind("public")
                                            .fetch_optional(pool)
                                            .await
                                        }).unwrap_or(None);
                                        exists.is_some()
                                    } else {
                                        false
                                    };

                                    if !already_in_db {
                                        println!("[Watcher][Create] Enqueuing file for upload: {}", file_path_str);
                                        sender
                                            .send(UploadJob {
                                                account_id: account_id.clone(),
                                                seed_phrase: seed_phrase.clone(),
                                                file_path: file_path_str,
                                                is_folder: false,
                                            })
                                            .unwrap();
                                    } else {
                                        println!("[Watcher][Create] File {} already in DB, skipping", file_name);
                                    }
                                }
                            }
                        }
                    }
                    CREATE_BATCH_TIMER_RUNNING.store(false, Ordering::SeqCst);
                });
            }
        }
        EventKind::Modify(ModifyKind::Data(_)) => {
            for path in event.paths {
                let file_path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&file_path_str) {
                        continue;
                    }
                }
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
                    let result = tauri::async_runtime::block_on(delete_and_unpin_user_file_records_by_name(file_name, seed_phrase, false));
                    if result.is_ok() {
                        if let Some(pool) = crate::DB_POOL.get() {
                            let _ = tauri::async_runtime::block_on(async {
                                sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'")
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
                    {
                        let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        if recently_uploaded.contains(&file_path_str) {
                            println!("[Watcher] File {} was recently uploaded, skipping.", file_path_str);
                            return;
                        }
                    }
                    {
                        let uploading_files = UPLOADING_FILES.lock().unwrap();
                        if uploading_files.contains(&file_path_str) {
                            println!("[Watcher] File {} is already being uploaded, skipping.", file_path_str);
                            return;
                        }
                    }
                    if let Some(sender) = UPLOAD_SENDER.get() {
                        sender
                            .send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: file_path_str.clone(),
                                is_folder: false,
                            })
                            .unwrap();
                        println!("[Watcher] Enqueued new file for upload: {}", file_path_str);
                    }
                }
            } else {
                for path in event.paths {
                    if !path.exists() {
                        if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                            println!("[Watcher] File deleted (via rename/move) from sync folder: {}", file_name);
                            let result = tauri::async_runtime::block_on(delete_and_unpin_user_file_records_by_name(file_name, seed_phrase, false));
                            if result.is_ok() {
                                if let Some(pool) = crate::DB_POOL.get() {
                                    let _ = tauri::async_runtime::block_on(async {
                                        sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'")
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
                    println!("[Watcher] public File deleted from sync folder: {}", file_name);
                    let result = tauri::async_runtime::block_on(delete_and_unpin_user_file_records_by_name(file_name, seed_phrase, false));
                    if result.is_ok() {
                        if let Some(pool) = crate::DB_POOL.get() {
                            let _ = tauri::async_runtime::block_on(async {
                                sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = 'public'")
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
    if is_file_in_synced_db(path, account_id) {
        // Remove from uploading set
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&file_path_str);
        return false;
    }

    // Acquire the lock before uploading
    let _guard = UPLOAD_LOCK.lock().unwrap();

    let file_path = path.to_string_lossy().to_string();

    // Call the async upload command in a blocking way
    let result = block_on(upload_file_public(
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

            // Remove from recently uploaded set after 30 seconds
            let file_path_str_clone = file_path_str.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(30));
                let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                recently_uploaded.remove(&file_path_str_clone);
            });
            
            // Insert into DB if not exists
            if let Some(pool) = crate::DB_POOL.get() {
                insert_file_if_not_exists(pool, path, account_id, true, false);
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
            false
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

fn is_file_in_synced_db(file_path: &Path, account_id: &str) -> bool {
    let file_name = match file_path.file_name().and_then(OsStr::to_str) {
        Some(name) => name,
        None => return false,
    };

    let pool = match DB_POOL.get() {
        Some(pool) => pool,
        None => return false,
    };

    tauri::async_runtime::block_on(async {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1",
        )
        .bind(account_id)
        .bind(file_name)
        .fetch_optional(pool)
        .await
    }).map(|r| r.is_some()).unwrap_or(false)
}

#[tauri::command]
pub async fn start_public_folder_sync_tauri(account_id: String, seed_phrase: String) {
    start_public_folder_sync(account_id, seed_phrase).await;
}
