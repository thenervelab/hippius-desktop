#![allow(unused_imports)]
use crate::utils::sync::get_private_sync_path;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::sleep;
use std::sync::atomic::Ordering;
use std::thread;
use crate::utils::fs_watcher::{FsWatcher, FsEvent};
use tokio::sync::mpsc;
pub use crate::sync_shared::{SYNCING_ACCOUNTS, GLOBAL_CANCEL_TOKEN, S3_PRIVATE_SYNC_STATE, BucketItem, insert_bucket_item_if_absent, delete_bucket_item_by_name};
use crate::constants::folder_sync::SyncStatusResponse;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(windows)]
use std::os::windows::process::ExitStatusExt;
use crate::sync_shared::MAX_RECENT_ITEMS;
use crate::sync_shared::parse_s3_sync_line;
use serde_json::json;
use tauri::{Emitter, Manager};
use crate::DB_POOL;
use chrono;
use std::env;
use log::error;
use crate::commands::node::get_aws_binary_path;
use sp_core::sr25519;
use sp_core::Pair;
use sp_core::crypto::Ss58Codec;
use crate::commands::syncing::{decrypt_phrase, load_encryption_key};
use sqlx::SqlitePool;
use crate::sync_shared::RecentItem;
use crate::sync_shared::{update_uploaded_file, folder_size};

async fn handle_fs_events(
    mut rx: mpsc::UnboundedReceiver<FsEvent>,
    pool: SqlitePool,
    owner: String,
    bucket_name: String,
    app_handle: AppHandle,
) {    
    // Buffer to collect events and process them in batches
    let mut batch = Vec::new();
    let batch_timeout = tokio::time::sleep(Duration::from_millis(100));
    tokio::pin!(batch_timeout);
    
    loop {
        tokio::select! {
            // Handle new events
            Some(event) = rx.recv() => {
                batch.push(event);
                println!("[privateFolderSync] Received FS event, batch size: {}", batch.len());
                
                // Process immediately when we get events, don't wait for timeout
                if !batch.is_empty() {
                    process_batch(&batch, &pool, &owner, &bucket_name, &app_handle).await;
                    batch.clear();
                    batch_timeout.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(100));
                }
            }
            // Process batch after timeout (fallback)
            _ = &mut batch_timeout => {
                if !batch.is_empty() {
                    process_batch(&batch, &pool, &owner, &bucket_name, &app_handle).await;
                    batch.clear();
                }
                batch_timeout.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(100));
            }
        }
    }
}

pub async fn start_private_folder_sync(app_handle: AppHandle, account_id: String, _seed_phrase: String) {
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&(account_id.clone(), "private")) {
            println!("[PrivateFolderSync] Account {} is already syncing, skipping.", account_id);
            return;
        }
        syncing_accounts.insert((account_id.clone(), "private"));
    }

    // Get sub-account from database
    let sub_account = loop {
        match DB_POOL.get() {
            Some(pool) => {
                match sqlx::query_as::<_, (String,)>(r#"
                    SELECT sub_account_seed_phrase 
                    FROM sub_accounts 
                    WHERE account_id = ? 
                    LIMIT 1
                    "#)
                    .bind(&account_id)
                    .fetch_optional(pool)
                    .await
                {
                    Ok(Some((sub_account_seed_phrase,))) => {
                        // Try to decrypt if we have a key, otherwise use as-is
                        let maybe_key = load_encryption_key(pool).await;
                        let phrase = if let Some(key) = &maybe_key {
                            decrypt_phrase(&sub_account_seed_phrase, key).unwrap_or_else(|| sub_account_seed_phrase.clone())
                        } else {
                            sub_account_seed_phrase
                        };
                        // Convert seed phrase to SS58 address
                        if let Ok((pair, _)) = sr25519::Pair::from_phrase(&phrase, None) {
                            let ss58 = pair.public().to_ss58check();
                            break ss58;
                        } else {
                            eprintln!("[PrivateFolderSync] Failed to convert seed phrase to SS58 address");
                            tokio::time::sleep(Duration::from_secs(15)).await;
                        }
                    },
                    Ok(None) => {
                        println!("[PrivateFolderSync] No sub-account found for account {}, waiting 15 seconds...", account_id);
                        tokio::time::sleep(Duration::from_secs(15)).await;
                    }
                    Err(e) => {
                        eprintln!("[PrivateFolderSync] Error querying sub-accounts: {}", e);
                        tokio::time::sleep(Duration::from_secs(15)).await;
                    }
                }
            }
            None => {
                eprintln!("[PrivateFolderSync] Database pool not available, waiting 15 seconds...");
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        }
    };

    let sync_path = match get_private_sync_path().await {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[PrivateFolderSync] Failed to get private sync path: {}", e);
            sleep(Duration::from_secs(60)).await;
            return;
        }
    };
    
    // Create a unique identifier from the sync path
    let path_hash = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        sync_path.hash(&mut hasher);
        format!("{:x}", hasher.finish())[..8].to_string() // First 8 chars of hash
    };
    
    let bucket_name = format!("{}-private-{}", sub_account, path_hash);

    let endpoint_url = "https://s3.hippius.com";
   
    // Dynamically get the AWS binary path
    let aws_binary_path = match get_aws_binary_path().await {
        Ok(path) => {
            println!("[PrivateFolderSync] Found AWS binary at: {}", path.display());
            path
        }
        Err(e) => {
            eprintln!("[PrivateFolderSync] Failed to get AWS binary path: {}, falling back to system PATH", e);
            // Fall back to checking system PATH with which crate
            if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                println!("[PrivateFolderSync] Found AWS in system PATH at: {}", path.display());
                path
            } else {
                eprintln!("[PrivateFolderSync] AWS CLI not found in system PATH or custom location");
                return; // Exit if no AWS CLI is found
            }
        }
    };

    // Construct dynamic PATH with OS-appropriate separator
    let path_separator = if cfg!(windows) { ";" } else { ":" };
    let dynamic_path = format!(
        "{}{}{}",
        aws_binary_path.parent().unwrap().to_string_lossy(),
        path_separator,
        env::var("PATH").unwrap_or_default()
    );

    // --- Bucket creation and preflight checks ---
    println!("[PrivateFolderSync] Ensuring bucket exists: s3://{}", bucket_name);
    let mut exists_cmd = Command::new(&aws_binary_path);
    exists_cmd
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3")
        .arg("ls")
        .arg(format!("s3://{}", bucket_name))
        .arg("--endpoint-url")
        .arg(endpoint_url);

    // Add Windows-specific flags to suppress terminal window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        exists_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let exists_output = exists_cmd.output();

    let bucket_exists = match exists_output {
        Ok(ref o) if o.status.success() => true,
        _ => false,
    };

    if bucket_exists {
        println!("[PrivateFolderSync] Bucket already exists, proceeding.");
    } else {
        loop {
            let mut mb_cmd = Command::new(&aws_binary_path);
            mb_cmd
                .env("AWS_PAGER", "")
                .env("PATH", &dynamic_path)
                .arg("s3")
                .arg("mb")
                .arg(format!("s3://{}", bucket_name))
                .arg("--endpoint-url")
                .arg(endpoint_url);
            
            // Add Windows-specific flags to suppress terminal window
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                mb_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            
            let mb_output = mb_cmd.output();
            
            let proceed = match mb_output {
                Ok(output) => {
                    if output.status.success() {
                        println!("[PrivateFolderSync] Successfully created bucket 's3://{}'.", bucket_name);
                        true
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if stderr.contains("BucketAlreadyExists") || stderr.contains("BucketAlreadyOwnedByYou") {
                            println!("[PrivateFolderSync] Bucket already exists (race condition), proceeding.");
                            true
                        } else {
                            let mut verify_cmd = Command::new(&aws_binary_path);
                            verify_cmd
                                .env("AWS_PAGER", "")
                                .env("PATH", &dynamic_path)
                                .arg("s3")
                                .arg("ls")
                                .arg(format!("s3://{}", bucket_name))
                                .arg("--endpoint-url")
                                .arg(endpoint_url);
                            
                            // Add Windows-specific flags to suppress terminal window
                            #[cfg(target_os = "windows")]
                            {
                                use std::os::windows::process::CommandExt;
                                verify_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                            }
                            
                            match verify_cmd.output() {
                                Ok(v) if v.status.success() => {
                                    println!("[PrivateFolderSync] Bucket accessible after failed create, proceeding.");
                                    true
                                }
                                _ => {
                                    eprintln!("[PrivateFolderSync] Failed to create bucket, will retry in 15s: {}", stderr);
                                    false
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[PrivateFolderSync] Failed to execute 'aws s3 mb' command (will retry in 15s): {}", e);
                    let mut verify_cmd = Command::new(&aws_binary_path);
                    verify_cmd
                        .env("AWS_PAGER", "")
                        .env("PATH", &dynamic_path)
                        .arg("s3")
                        .arg("ls")
                        .arg(format!("s3://{}", bucket_name))
                        .arg("--endpoint-url")
                        .arg(endpoint_url);
                    
                    // Add Windows-specific flags to suppress terminal window
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        verify_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                    }
                    
                    let verify = verify_cmd.output();
                    matches!(verify, Ok(v) if v.status.success())
                }
            };

            if proceed {
                break;
            } else {
                thread::sleep(Duration::from_secs(15));
                continue;
            }
        }
    }

    let mut ls_cmd = Command::new(&aws_binary_path);
    ls_cmd
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3")
        .arg("ls")
        .arg(format!("s3://{}", bucket_name))
        .arg("--endpoint-url")
        .arg(endpoint_url);
    
    // Add Windows-specific flags to suppress terminal window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        ls_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    
    match ls_cmd.output() {
        Ok(o) if o.status.success() => {
            println!("[PrivateFolderSync] Preflight: AWS CLI can access bucket 's3://{}'", bucket_name);
        }
        Ok(o) => {
            eprintln!("[PrivateFolderSync] Preflight: 'aws s3 ls' failed (exit {}) stderr: {}", 
                     o.status, String::from_utf8_lossy(&o.stderr));
        }
        Err(e) => {
            eprintln!("[PrivateFolderSync] Preflight: failed to execute aws: {}", e);
        }
    }
    let sync_path = match get_private_sync_path().await {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[PrivateFolderSync] Failed to get private sync path: {}", e);
            sleep(Duration::from_secs(60)).await;
            return;
        }
    };

    // Create directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(&sync_path) {
        eprintln!("[PrivateFolderSync] Failed to create sync directory: {}", e);
        return;
    }

    // Set up file system watcher
    let (tx, rx) = mpsc::unbounded_channel();
    let _watcher = match FsWatcher::new(&sync_path, tx) {
        Ok(watcher) => watcher,
        Err(e) => {
            eprintln!("[PrivateFolderSync] Failed to create file system watcher: {}", e);
            return;
        }
    };

    let pool = match DB_POOL.get() {
        Some(p) => p.clone(),
        None => {
            eprintln!("[PrivateFolderSync] Database pool not available");
            return;
        }
    };
    
    // Clone values for the async task
    let pool_clone = pool.clone();
    let owner_clone = account_id.clone();
    let bucket_name_clone = bucket_name.clone();
    let app_handle_clone = app_handle.clone();
    
    tokio::spawn(async move {
        handle_fs_events(rx, pool_clone, owner_clone, bucket_name_clone, app_handle_clone).await
    });

    loop {
        if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
            println!("[PrivateFolderSync] Global cancellation detected, stopping sync for account {}", account_id);
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "private"));
            }
            return;
        }

        let s3_destination = format!("s3://{}/", bucket_name);
        let bucket_name_clone = bucket_name.clone();

        println!("[PrivateFolderSync] Starting dry run to calculate changes...");
        let mut dry_run_cmd = Command::new(&aws_binary_path);
        dry_run_cmd
            .env("AWS_PAGER", "")
            .env("PATH", &dynamic_path)
            .arg("s3")
            .arg("sync")
            .arg(&sync_path)
            .arg(&s3_destination)
            .arg("--endpoint-url")
            .arg(endpoint_url)
            .arg("--delete")
            .arg("--dryrun")
            .arg("--exclude")
            .arg("*.DS_Store")
            .arg("--exclude")
            .arg("Thumbs.db")
            .arg("--exclude")
            .arg("*.tmp")
            .arg("--exclude")
            .arg(".git/*");
        
        // Add Windows-specific flags to suppress terminal window
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            dry_run_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        
        let dry_run_output = dry_run_cmd.output();
        
        let total_changes = match dry_run_output {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout.lines()
                    .filter_map(|line| parse_s3_sync_line(line, "private"))
                    .count()
            },
            Err(e) => {
                eprintln!("[PrivateFolderSync] Dry run command failed: {}", e);
                continue;
            }
        };

        if total_changes == 0 {
            println!("[PrivateFolderSync] No changes detected. Waiting for next cycle.");
            {
                let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
                state.in_progress = false;
            }
            sleep(Duration::from_secs(60)).await;
            continue;
        }

        {
            let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
            state.in_progress = true;
            state.processed_files = 0;
            state.uploading_items.retain(|_| false); // Clear all uploading items
            state.total_files = total_changes;
        }

        let mut sync_cmd = Command::new(&aws_binary_path);
        sync_cmd
            .env("AWS_PAGER", "")
            .env("PATH", &dynamic_path)
            .arg("s3")
            .arg("sync")
            .arg(&sync_path)
            .arg(&s3_destination)
            .arg("--endpoint-url")
            .arg(endpoint_url)
            .arg("--delete")
            .arg("--no-progress")
            .arg("--exclude")
            .arg("*.DS_Store")
            .arg("--exclude")
            .arg("Thumbs.db")
            .arg("--exclude")
            .arg("*.tmp")
            .arg("--exclude")
            .arg(".git/*")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        
        // Add Windows-specific flags to suppress terminal window
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            sync_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        
        let mut child = sync_cmd
            .spawn()
            .expect("Failed to spawn 'aws s3 sync' command");
        
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            let account_id_clone = account_id.clone();
            let sync_path_str = sync_path.clone();
            thread::spawn(move || {
                for line in reader.lines() {
                    if let Ok(line) = line {
                        println!("[AWS Sync] {}", line);
                        if let Some(mut item) = parse_s3_sync_line(&line, "private") {
                            // Update processed files count
                            {
                                let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
                                state.processed_files = (state.processed_files + 1).min(state.total_files);
                                // Update or add the item in uploading_items
                                if let Some(existing_idx) = state.uploading_items.iter().position(|i| i.path == item.path) {
                                    state.uploading_items[existing_idx] = item.clone();
                                } else {
                                    state.uploading_items.push(item.clone());
                                }
                            }
                            
                            // If this is an upload completion, update the state
                            if item.scope == "private" && item.action == "uploaded" {
                                if let Some(updated_item) = update_uploaded_file("private", &item.path) {
                                    item = updated_item;
                                }
                            }

                            if let Some(pool) = DB_POOL.get() {
                                let pool = pool.clone();
                                let owner = account_id_clone.clone();
                                let sync_root = std::path::PathBuf::from(&sync_path_str);

                                if item.action == "uploaded" {
                                    let abs_path = std::path::PathBuf::from(&item.path);
                                    if let Ok(rel_path) = abs_path.strip_prefix(&sync_root) {
                                        if let Some(first_component) = rel_path.components().next() {
                                            let name = first_component.as_os_str().to_string_lossy().to_string();
                                            let is_folder = abs_path.is_dir() || rel_path.components().count() > 1;
                                            let bucket_item = BucketItem {
                                                path: name.clone(),
                                                size: if is_folder { 0 } else { abs_path.metadata().map(|m| m.len()).unwrap_or(0) },
                                                last_modified: String::new(),
                                                is_folder,
                                                storage_class: "Standard".to_string(),
                                                ipfs_hash: "pending".to_string(),
                                                bucket_name: bucket_name_clone.clone(),
                                            };

                                            tauri::async_runtime::spawn(async move {
                                                if let Err(e) = insert_bucket_item_if_absent(&pool, &owner, "private", &bucket_item).await {
                                                    eprintln!("[PrivateFolderSync] Failed to insert bucket item '{}': {}", name, e);
                                                }
                                                
                                                if !is_folder {
                                                    let file_hash = ""; // Compute if needed
                                                    if let Err(e) = sqlx::query(
                                                        "INSERT OR REPLACE INTO file_paths (file_name, file_hash, timestamp, path) VALUES (?, ?, ?, ?)"
                                                    )
                                                    .bind(&name)
                                                    .bind(file_hash)
                                                    .bind(chrono::Utc::now().timestamp())
                                                    .bind(&abs_path.to_string_lossy())
                                                    .execute(&pool)
                                                    .await {
                                                        eprintln!("[PrivateFolderSync] Failed to insert into file_paths '{}': {}", name, e);
                                                    }
                                                }
                                            });
                                        }
                                    }
                                } else if item.action == "deleted" {
                                    if let Some(key) = item.path.splitn(4, '/').nth(3) {
                                        if !key.is_empty() && !key.contains('/') {
                                            let name = key.to_string();
                                            tauri::async_runtime::spawn(async move {
                                                if let Err(e) = delete_bucket_item_by_name(&pool, &owner, "private", &name).await {
                                                    eprintln!("[PrivateFolderSync] Failed to delete bucket item '{}': {}", name, e);
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }

        let status = loop {
            if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
                eprintln!("[PrivateFolderSync] Cancellation during active sync; killing aws child");
                let _ = child.kill();
                match child.try_wait() {
                    Ok(Some(st)) => break st,
                    _ => {
                        #[cfg(unix)]
                        { break std::process::ExitStatus::from_raw(1); }
                        #[cfg(windows)]
                        { break std::process::ExitStatus::from_raw(1); }
                    }
                }
            }
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                Err(_) => {
                    eprintln!("[PrivateFolderSync] Error while waiting for child; assuming failure");
                    #[cfg(unix)]
                    { break std::process::ExitStatus::from_raw(1); }
                    #[cfg(windows)]
                    { break std::process::ExitStatus::from_raw(1); }
                }
            }
        };

        {
            let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
            state.in_progress = false;
            if status.success() {
                state.processed_files = state.total_files;
                // Clear all uploading items on successful sync
                state.uploading_items.retain(|_| false);
            }
        }

        {
            let state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
            let payload = json!({
                "scope": "private",
                "account_id": account_id,
                "success": status.success(),
                "total_files": state.total_files,
                "processed_files": state.processed_files,
            });
            println!("[PrivateFolderSync] Emitting sync_completed event: {}", payload);
            if let Err(e) = app_handle.emit("sync_completed", payload) {
                eprintln!("[PrivateFolderSync] Failed to emit sync_completed event: {}", e);
            }
        }

        println!("[PrivateFolderSync] Waiting for 1 minutes before next sync.");
        sleep(Duration::from_secs(60)).await;
    }
}

#[tauri::command]
pub async fn start_private_folder_sync_tauri(app_handle: AppHandle, account_id: String, seed_phrase: String) {
    start_private_folder_sync(app_handle, account_id, seed_phrase).await;
}

async fn process_batch(
    events: &[FsEvent],
    pool: &SqlitePool,
    owner: &str,
    bucket_name: &str,
    app_handle: &AppHandle, // Add app_handle parameter
) {
    let mut new_files = 0;
    let mut recent_items = Vec::new();
    let mut bucket_items = Vec::new();
    let mut file_paths = Vec::new();
    
    // First pass: collect all the data we need
    for event in events {
        match event {
            FsEvent::Create(path, is_dir) => {
                let file_name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(name) => name.to_string(),
                    None => continue,
                };
                
                let size = if *is_dir {
                    folder_size(&path)
                } else {
                    std::fs::metadata(path).ok().map(|m| m.len()).unwrap_or(0)
                };
                
                let bucket_item = BucketItem {
                    path: file_name.clone(),
                    size,
                    last_modified: chrono::Utc::now().to_rfc3339(),
                    is_folder: *is_dir,
                    storage_class: "STANDARD".to_string(),
                    ipfs_hash: "".to_string(),
                    bucket_name: bucket_name.to_string(),
                };
                
                bucket_items.push(bucket_item);
                
                if !is_dir {
                    new_files += 1;
                    file_paths.push((file_name.clone(), path.clone()));
                }
                
                // For directories, mark as detected
                if *is_dir {
                    let recent_item = RecentItem {
                        name: file_name.clone(),
                        scope: "private".to_string(),
                        action: "uploading".to_string(),
                        kind: "folder".to_string(),
                        path: path.to_string_lossy().to_string(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    };
                    recent_items.push(recent_item);
                } else {
                    // For files, only add to uploading state, not to recent items yet
                    let upload_item = RecentItem {
                        name: file_name.clone(),
                        scope: "private".to_string(),
                        action: "uploading".to_string(),
                        kind: "file".to_string(),
                        path: path.to_string_lossy().to_string(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    };
                    
                    // Add to uploading state only, not to recent items yet
                    let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
                    // Check if this file is already in the uploading list
                    if !state.uploading_items.iter().any(|item| item.path == upload_item.path) {
                        state.uploading_items.push(upload_item);
                    }
                }
            },
            FsEvent::Remove(path, is_dir) => {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    println!("[PrivateFolderSync] Successfully deleted '{}' from database", file_name);
                        
                    let recent_item = RecentItem {
                        name: file_name.to_string(),
                        scope: "private".to_string(),
                        action: "deleted".to_string(),
                        kind: if *is_dir { "folder" } else { "file" }.to_string(),
                        path: path.to_string_lossy().to_string(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    };

                    // Add to recent items
                    recent_items.push(recent_item.clone());

                    // Update uploading items in sync state if this is a file
                    if !*is_dir {
                        let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
                        // Remove any existing entry for this path and add the new one
                        state.uploading_items.retain(|item| item.path != recent_item.path);
                        state.uploading_items.push(recent_item);
                    }
                }
            }
        }
    }
    
    // Batch insert all new bucket items that are in the root directory
    if !bucket_items.is_empty() {
        // Get the sync path to determine the root directory
        let sync_path = match get_private_sync_path().await {
            Ok(path) => path,
            Err(e) => {
                error!("[privateFolderSync] Failed to get private sync path: {}", e);
                return;
            }
        };
        
        for item in bucket_items {
            // Get the full path of the item
            let item_path = std::path::Path::new(&item.path);
            
            // Check if the item is directly in the root directory
            let parent = match item_path.parent() {
                Some(parent) => parent,
                None => continue, // Skip if no parent (shouldn't happen)
            };
            
            // Only process items that are directly in the root directory
            let sync_path_buf = std::path::Path::new(&sync_path);
            if parent == sync_path_buf {
                if let Err(e) = insert_bucket_item_if_absent(pool, owner, "private", &item).await {
                    error!("[privateFolderSync] Failed to insert item: {}", e);
                } else {
                    println!("[privateFolderSync] Inserted root bucket item: {}", item.path);
                }
            } else {
                println!("[privateFolderSync] Skipping non-root item: {}", item.path);
            }
        }
    }
    
    // Update file paths
    for (file_name, path) in file_paths {
        if let Err(e) = sqlx::query(
            "INSERT OR REPLACE INTO file_paths (file_name, file_hash, timestamp, path) VALUES (?, ?, ?, ?)"
        )
        .bind(&file_name)
        .bind("") // Empty file_hash for now
        .bind(chrono::Utc::now().timestamp())
        .bind(path.to_string_lossy().to_string())
        .execute(pool)
        .await {
            error!("[PrivateFolderSync] Failed to update file_paths for '{}': {}", file_name, e);
        } else {
            println!("[PrivateFolderSync] Updated file_paths for: {}", file_name);
        }
    }

    // Update the state in one go
    let should_emit = {
        let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
        let mut changed = false;
        
        // Update total files count if we have new files
        if new_files > 0 {
            state.total_files = state.total_files.saturating_add(new_files);
            changed = true;
            println!("[privateFolderSync] Added {} new files to total", new_files);
        }
        
        // Add recent items
        for item in recent_items {
            // Only add if not already in the recent items with the same action
            if !state.recent_items.iter().any(|i| i.path == item.path && i.action == item.action) {
                state.recent_items.push_front(item.clone());
                changed = true;
                println!("[privateFolderSync] Added recent item: {}", item.name);
                
                // Trim the list if it gets too long
                while state.recent_items.len() > MAX_RECENT_ITEMS {
                    state.recent_items.pop_back();
                }
            }
        }
        
        changed
    };
    
    // Only emit the event if there were actual changes
    if should_emit {
        // Get the current state for the event
        let status = {
            let state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
            crate::constants::folder_sync::SyncStatusResponse {
                synced_files: state.processed_files,
                total_files: state.total_files,
                in_progress: state.in_progress,
                percent: if state.total_files > 0 {
                    ((state.processed_files as f32 / state.total_files as f32) * 100.0).min(100.0)
                } else {
                    0.0
                },
            }
        };
        
        // Emit the sync status update
        let _ = app_handle.emit("sync-status-update", &status);
        
        // Also emit an activity update
        let activity = crate::sync_shared::get_sync_activity(owner.to_string(), Some(50));
        let _ = app_handle.emit("sync-activity-update", &activity);
        
        println!("[privateFolderSync] Emitted status and activity updates");
    }
}