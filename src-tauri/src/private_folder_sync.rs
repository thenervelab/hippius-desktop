use crate::utils::sync::get_private_sync_path;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::sleep;
use base64::{encode};
use std::sync::atomic::Ordering;
use std::thread;
pub use crate::sync_shared::{SYNCING_ACCOUNTS, GLOBAL_CANCEL_TOKEN, S3_PRIVATE_SYNC_STATE,  BucketItem, insert_bucket_item_if_absent,  delete_bucket_item_by_name};
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
use crate::commands::node::get_aws_binary_path;

pub async fn start_private_folder_sync(app_handle: AppHandle, account_id: String, seed_phrase: String) {
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&(account_id.clone(), "private")) {
            println!("[PrivateFolderSync] Account {} is already syncing, skipping.", account_id);
            return;
        }
        syncing_accounts.insert((account_id.clone(), "private"));
    }

    let bucket_name = format!("{}-private", account_id);
    let endpoint_url = "https://s3.hippius.com";
    let encoded_seed_phrase = encode(&seed_phrase);

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
    let exists_output = Command::new(&aws_binary_path)
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3")
        .arg("ls")
        .arg(format!("s3://{}", bucket_name))
        .arg("--endpoint-url")
        .arg(endpoint_url)
        .output();

    let bucket_exists = match exists_output {
        Ok(ref o) if o.status.success() => true,
        _ => false,
    };

    if bucket_exists {
        println!("[PrivateFolderSync] Bucket already exists, proceeding.");
    } else {
        loop {
            let mb_output = Command::new(&aws_binary_path)
                .env("AWS_PAGER", "")
                .env("PATH", &dynamic_path)
                .arg("s3")
                .arg("mb")
                .arg(format!("s3://{}", bucket_name))
                .arg("--endpoint-url")
                .arg(endpoint_url)
                .output();

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
                            let verify = Command::new(&aws_binary_path)
                                .env("AWS_PAGER", "")
                                .env("PATH", &dynamic_path)
                                .arg("s3")
                                .arg("ls")
                                .arg(format!("s3://{}", bucket_name))
                                .arg("--endpoint-url")
                                .arg(endpoint_url)
                                .output();

                            match verify {
                                Ok(v) if v.status.success() => {
                                    println!("[PrivateFolderSync] Bucket accessible after failed create, proceeding.");
                                    true
                                }
                                _ => {
                                    eprintln!("[PrivateFolderSync] Failed to create bucket, will retry in 30s: {}", stderr);
                                    false
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[PrivateFolderSync] Failed to execute 'aws s3 mb' command (will retry in 30s): {}", e);
                    let verify = Command::new(&aws_binary_path)
                        .env("AWS_PAGER", "")
                        .env("PATH", &dynamic_path)
                        .arg("s3")
                        .arg("ls")
                        .arg(format!("s3://{}", bucket_name))
                        .arg("--endpoint-url")
                        .arg(endpoint_url)
                        .output();
                    matches!(verify, Ok(v) if v.status.success())
                }
            };

            if proceed {
                break;
            } else {
                thread::sleep(Duration::from_secs(30));
                continue;
            }
        }
    }

    match Command::new(&aws_binary_path)
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3")
        .arg("ls")
        .arg(format!("s3://{}", bucket_name))
        .arg("--endpoint-url")
        .arg(endpoint_url)
        .output()
    {
        Ok(o) if o.status.success() => {
            println!("[PrivateFolderSync] Preflight: AWS CLI can access bucket 's3://{}'", bucket_name);
        }
        Ok(o) => {
            eprintln!("[PrivateFolderSync] Preflight: 'aws s3 ls' failed (exit {}) stderr: {}", o.status, String::from_utf8_lossy(&o.stderr));
        }
        Err(e) => {
            eprintln!("[PrivateFolderSync] Preflight: failed to execute aws: {}", e);
        }
    }

    loop {
        if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
            println!("[PrivateFolderSync] Global cancellation detected, stopping sync for account {}", account_id);
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "private"));
            }
            return;
        }

        let sync_path = match get_private_sync_path().await {
            Ok(path) => path,
            Err(e) => {
                eprintln!("[PrivateFolderSync] Failed to get private sync path: {}", e);
                sleep(Duration::from_secs(60)).await;
                continue;
            }
        };

        let s3_destination = format!("s3://{}/", bucket_name);

        println!("[PrivateFolderSync] Starting dry run to calculate changes...");
        let dry_run_output = Command::new(&aws_binary_path)
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
            .arg(".git/*")
            .output();

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
            state.total_files = total_changes;
            state.current_item = None;
        }

        let mut child = Command::new(&aws_binary_path)
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
            .stderr(Stdio::piped())
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
                        if let Some(item) = parse_s3_sync_line(&line, "private") {
                            let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
                            state.processed_files += 1;
                            if state.processed_files > state.total_files {
                                state.processed_files = state.total_files;
                            }
                            state.current_item = Some(item.clone());
                            
                            if item.scope == "private" && item.action == "uploaded" {
                                if !state.recent_items.iter().any(|i| i.path == item.path && i.action == item.action) {
                                    state.recent_items.push_front(item.clone());
                                    if state.recent_items.len() > MAX_RECENT_ITEMS {
                                        state.recent_items.pop_back();
                                    }
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
            state.current_item = None;
            if status.success() {
                state.processed_files = state.total_files;
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