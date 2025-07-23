use crate::commands::ipfs_commands::{encrypt_and_upload_file, encrypt_and_upload_folder};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use crate::utils::sync::get_private_sync_path;
use crate::utils::file_operations::delete_and_unpin_user_file_records_by_name;
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
use crate::sync_shared::{SYNCING_ACCOUNTS, UPLOAD_SENDER, UPLOADING_FILES, RECENTLY_UPLOADED, SYNC_STATUS, 
    UPLOAD_LOCK, RECENTLY_UPLOADED_FOLDERS, CREATE_BATCH, CREATE_BATCH_TIMER_RUNNING, UploadJob, insert_file_if_not_exists};

pub async fn start_folder_sync(account_id: String, seed_phrase: String) {
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&(account_id.clone(), "private")) {
            println!("[FolderSync] Account {} is already syncing, skipping.", account_id);
            return;
        }
        syncing_accounts.insert((account_id.clone(), "private"));
    }

    if UPLOAD_SENDER.get().is_none() {
        let (tx, mut rx) = mpsc::unbounded_channel::<UploadJob>();
        UPLOAD_SENDER.set(tx).ok();
        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                let path_str = job.file_path.clone();
                {
                    let mut uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[UploadWorker] Path {} is already being uploaded, skipping.", path_str);
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
                    encrypt_and_upload_file(
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

    let startup_account_id = account_id.clone();
    let startup_seed_phrase = seed_phrase.clone();
    tokio::spawn(async move {
        if let Some(pool) = crate::DB_POOL.get() {
            let sync_path = PathBuf::from(get_private_sync_path().await);

            let mut paths = Vec::new();
            collect_paths_recursively(&sync_path, &mut paths);
            let dir_paths: HashSet<String> = paths.iter()
                .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
                .collect();
            let db_paths: Vec<(String, bool)> = sqlx::query_as(
                "SELECT file_name, is_folder FROM sync_folder_files WHERE owner = ? AND type = 'private'"
            )
            .bind(&startup_account_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();

            for (db_path, is_folder) in &db_paths {
                if !dir_paths.contains(db_path) {
                    println!("[Startup] Path deleted from sync folder: {} (is_folder: {})", db_path, is_folder);
                    if delete_and_unpin_user_file_records_by_name(db_path, &startup_seed_phrase, false).await.is_ok() {
                        let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                            .bind(&startup_account_id)
                            .bind(db_path)
                            .execute(pool)
                            .await;
                    }
                }
            }

            let mut new_paths_to_upload = Vec::new();
            for path in &paths {
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

    let sync_path = PathBuf::from(get_private_sync_path().await);
    let watcher_account_id = account_id.clone();
    let watcher_seed_phrase = seed_phrase.clone();
    spawn_watcher_thread(account_id.clone(), seed_phrase.clone());

    let checker_account_id = account_id.clone();
    let checker_seed_phrase = seed_phrase.clone();
    tokio::spawn(async move {
        loop {
            println!("[FolderSync] Periodic check: scanning for unsynced paths...");
            let sync_path_str = get_private_sync_path().await;
            let sync_path = PathBuf::from(&sync_path_str);

            let mut paths_to_check = Vec::new();
            collect_paths_recursively(&sync_path, &mut paths_to_check);

            for path in paths_to_check {
                let path_str = path.to_string_lossy().to_string();
                {
                    let uploading_files = UPLOADING_FILES.lock().unwrap();
                    if uploading_files.contains(&path_str) {
                        println!("[FolderSync] Path {:?} is being uploaded, skipping periodic check.", path);
                        continue;
                    }
                }
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[FolderSync] Path {:?} was recently uploaded, skipping periodic check.", path);
                        continue;
                    }
                }
                is_path_in_profile_db(&path, &checker_account_id).await;
            }

            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

fn spawn_watcher_thread(account_id: String, seed_phrase: String) {
    thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime for watcher");
        let mut current_path = String::new();
        let mut watcher: Option<RecommendedWatcher> = None;

        loop {
            let sync_path_str = rt.block_on(get_private_sync_path());
            if sync_path_str != current_path {
                if let Some(w) = watcher.take() {
                    drop(w);
                    println!("[FolderSync] Stopped watching old path: {}", current_path);
                }

                let (tx, rx) = channel();
                let mut new_watcher: RecommendedWatcher =
                    Watcher::new(tx, notify::Config::default())
                        .expect("[FolderSync] Failed to create watcher");

                new_watcher
                    .watch(Path::new(&sync_path_str), RecursiveMode::Recursive)
                    .expect("[FolderSync] Failed to watch sync directory");

                let watcher_account_id = account_id.clone();
                let watcher_seed_phrase = seed_phrase.clone();

                thread::spawn(move || {
                    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime for watcher handler");
                    for res in rx {
                        match res {
                            Ok(event) => rt.block_on(handle_event(event, &watcher_account_id, &watcher_seed_phrase)),
                            Err(e) => eprintln!("[FolderSync] Watch error: {:?}", e),
                        }
                    }
                });

                println!("[FolderSync] Started watching new private path: {}", sync_path_str);
                current_path = sync_path_str;
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

async fn handle_event(event: Event, account_id: &str, seed_phrase: &str) {
    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Folder) => {
            for path in event.paths.iter() {
                let path_str = path.to_string_lossy().to_string();
                println!("[Watcher][Create] Detected new path: {}", path_str);
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        println!("[Watcher][Create] Skipping recently uploaded: {}", path_str);
                        continue;
                    }
                }
                println!("[Watcher][Create] Adding to batch: {}", path_str);
                CREATE_BATCH.lock().unwrap().push(path.clone());
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
                            println!("[Watcher][Create] Processing batch path: {}", path.to_string_lossy());
                            let mut retries = 20;
                            while retries > 0 && !path.exists() {
                                std::thread::sleep(Duration::from_millis(100));
                                retries -= 1;
                            }
                            if path.is_file() {
                                let mut last_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                let mut stable = false;
                                for _ in 0..10 {
                                    std::thread::sleep(Duration::from_millis(100));
                                    let new_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                                    if new_size == last_size {
                                        stable = true;
                                        break;
                                    }
                                    last_size = new_size;
                                }
                                if stable {
                                    paths.push((path.clone(), false));
                                }
                            } else if path.is_dir() {
                                paths.push((path.clone(), true));
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
                                println!("[Watcher][Create] Enqueuing for upload: {} (is_folder: {})", path.to_string_lossy(), is_folder);
                                sender
                                    .send(UploadJob {
                                        account_id: account_id.clone(),
                                        seed_phrase: seed_phrase.clone(),
                                        file_path: path.to_string_lossy().to_string(),
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
        EventKind::Modify(ModifyKind::Data(_)) => {
            for path in event.paths {
                let path_str = path.to_string_lossy().to_string();
                {
                    let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                    if recently_uploaded.contains(&path_str) {
                        continue;
                    }
                }
                replace_path_and_db_records(&path, account_id, seed_phrase).await;
            }
        }
        EventKind::Modify(ModifyKind::Name(_)) => {
            if event.paths.len() == 2 {
                let old_path = &event.paths[0];
                let new_path = &event.paths[1];
                if let Some(file_name) = old_path.file_name().and_then(|s| s.to_str()) {
                    println!("[Watcher] Path renamed, deleting old records: {}", file_name);
                    let is_folder = old_path.is_dir();
                    let result = delete_and_unpin_user_file_records_by_name(file_name, seed_phrase, false).await;
                    if result.is_ok() {
                        if let Some(pool) = crate::DB_POOL.get() {
                            let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                                .bind(account_id)
                                .bind(file_name)
                                .execute(pool)
                                .await;
                            println!("[Watcher] Successfully deleted old records for '{}'", file_name);
                        }
                    } else {
                        eprintln!("[Watcher] Failed to delete/unpin old records for '{}'", file_name);
                    }
                }
                if new_path.exists() {
                    let path_str = new_path.to_string_lossy().to_string();
                    {
                        let recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
                        if recently_uploaded.contains(&path_str) {
                            println!("[Watcher] Path {} was recently uploaded, skipping.", path_str);
                            return;
                        }
                    }
                    {
                        let uploading_files = UPLOADING_FILES.lock().unwrap();
                        if uploading_files.contains(&path_str) {
                            println!("[Watcher] Path {} is already being uploaded, skipping.", path_str);
                            return;
                        }
                    }
                    if let Some(sender) = UPLOAD_SENDER.get() {
                        sender
                            .send(UploadJob {
                                account_id: account_id.to_string(),
                                seed_phrase: seed_phrase.to_string(),
                                file_path: path_str.clone(),
                                is_folder: new_path.is_dir(),
                            })
                            .unwrap();
                        println!("[Watcher] Enqueued new path for upload: {} (is_folder: {})", path_str, new_path.is_dir());
                    }
                }
            } else {
                for path in event.paths {
                    if !path.exists() {
                        if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                            println!("[Watcher] Path deleted (via rename/move) from sync folder: {}", file_name);
                            let is_folder = path.is_dir();
                            let result = delete_and_unpin_user_file_records_by_name(file_name, seed_phrase, false).await;
                            if result.is_ok() {
                                if let Some(pool) = crate::DB_POOL.get() {
                                    let _ = sqlx::query("DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'")
                                        .bind(account_id)
                                        .bind(file_name)
                                        .execute(pool)
                                        .await;
                                    println!("[Watcher] Successfully deleted records for '{}'", file_name);
                                }
                            } else {
                                eprintln!("[Watcher] Failed to delete/unpin records for '{}'", file_name);
                            }
                        }
                    }
                }
            }
        }
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Folder) => {
            for path in event.paths {
                let file_name = path.file_name().and_then(|s| s.to_str());
                if let Some(file_name) = file_name {
                    println!("[Watcher] Path deleted from sync folder: {} (is_folder: {})", file_name, path.is_dir());
                    let is_folder = path.is_dir();
                    let result = delete_and_unpin_user_file_records_by_name(file_name, seed_phrase, false).await;
                    if result.is_ok() {
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
            return false;
        }
        uploading_files.insert(path_str.clone());
    }

    if is_path_in_profile_db(path, account_id).await {
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
        return false;
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
        encrypt_and_upload_file(
            account_id.to_string(),
            path_str.clone(),
            seed_phrase.to_string(),
            None
        ).await
    };

    match result {
        Ok(res) => {
            println!("Uploaded path: {}", res);
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
            eprintln!("Upload failed: {}", e);
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
            println!("[FolderSync] Path {:?} is already being uploaded, skipping replace.", path);
            return;
        }
        uploading_files.insert(path_str.clone());
    }

    let file_name = match path.file_name().map(|s| s.to_string_lossy().to_string()) {
        Some(name) => name,
        None => {
            eprintln!("[FolderSync] Could not extract name from path: {}", path.display());
            let mut uploading_files = UPLOADING_FILES.lock().unwrap();
            uploading_files.remove(&path_str);
            return;
        }
    };

    let should_upload = if let Some(pool) = crate::DB_POOL.get() {
        let row: Option<(bool,)> = sqlx::query_as(
            "SELECT is_assigned FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        matches!(row, Some((true,)))
    } else {
        false
    };

    if !should_upload {
        println!("[FolderSync] Skipping upload: path '{}' is not assigned or not found in user_profiles.", file_name);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
        return;
    }

    println!("[FolderSync] Replacing path: {}", file_name);
    let upload_result = upload_path(path, account_id, seed_phrase, path.is_dir()).await;

    if upload_result {
        println!("[FolderSync] Upload successful for '{}', now cleaning up old records...", file_name);
        let delete_result = delete_and_unpin_user_file_records_by_name(
            &file_name,
            seed_phrase,
            false,
        ).await;
        if delete_result.is_err() {
            eprintln!("[FolderSync] Failed to delete/unpin old records for '{}', but upload succeeded.", file_name);
        } else {
            println!("[FolderSync] Successfully cleaned up old records for '{}'", file_name);
        }
    } else {
        eprintln!("[FolderSync] Upload failed for '{}', skipping delete/unpin.", file_name);
        let mut uploading_files = UPLOADING_FILES.lock().unwrap();
        uploading_files.remove(&path_str);
    }
}

async fn is_path_in_profile_db(path: &Path, account_id: &str) -> bool {
    let file_name = match path.file_name().and_then(OsStr::to_str) {
        Some(name) => name,
        None => return false,
    };

    let pool = match DB_POOL.get() {
        Some(pool) => pool,
        None => return false,
    };

    let found = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT 1 FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1",
    )
    .bind(account_id)
    .bind(file_name)
    .fetch_optional(pool)
    .await;

    if matches!(found, Ok(Some(_))) {
        let path_str = path.to_string_lossy().to_string();
        let _ = sqlx::query("UPDATE user_profiles SET source = ? WHERE owner = ? AND file_name = ?")
            .bind(&path_str)
            .bind(account_id)
            .bind(file_name)
            .execute(pool)
            .await;
        let _ = sqlx::query("UPDATE sync_folder_files SET is_assigned = 1 WHERE owner = ? AND file_name = ? AND type = 'private'")
            .bind(account_id)
            .bind(file_name)
            .execute(pool)
            .await;
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn start_folder_sync_tauri(account_id: String, seed_phrase: String) {
    start_folder_sync(account_id, seed_phrase).await;
}