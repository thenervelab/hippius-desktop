use crate::utils::sync::get_private_sync_path;
use std::process::{Command, Stdio}; // Add Stdio
use std::io::{BufRead, BufReader}; // Add BufRead and BufReader
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::sleep;
use base64::{encode};
use std::sync::atomic::Ordering;
use std::thread; // Add thread
pub use crate::sync_shared::{SYNCING_ACCOUNTS, GLOBAL_CANCEL_TOKEN, S3_PRIVATE_SYNC_STATE, RecentItem}; // Update imports
use std::path::Path;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(windows)]
use std::os::windows::process::ExitStatusExt;
use crate::sync_shared::parse_s3_sync_line;


pub async fn start_private_folder_sync(account_id: String, seed_phrase: String) {
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

    // --- Bucket creation and preflight checks (No changes needed here) ---
    println!("[PrivateFolderSync] Ensuring bucket exists: s3://{}", bucket_name);
    let exists_output = Command::new("aws")
        .env("AWS_PAGER", "")
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
        // Retry creating or verifying the bucket every 30 seconds until success
        loop {
            let mb_output = Command::new("aws")
                .env("AWS_PAGER", "")
                .arg("s3")
                .arg("mb")
                .arg(format!("s3://{}", bucket_name))
                .arg("--endpoint-url")
                .arg(endpoint_url)
                .output();

            let proceed = match mb_output {
                Ok(output) => {
                    if output.status.success() {
                        println!(
                            "[PrivateFolderSync] Successfully created bucket 's3://{}'.",
                            bucket_name
                        );
                        true
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        // Proceed if bucket already exists/owned
                        if stderr.contains("BucketAlreadyExists")
                            || stderr.contains("BucketAlreadyOwnedByYou")
                        {
                            println!(
                                "[PrivateFolderSync] Bucket already exists (race condition), proceeding."
                            );
                            true
                        } else {
                            // Try a follow-up access check; if accessible, proceed
                            let verify = Command::new("aws")
                                .env("AWS_PAGER", "")
                                .arg("s3")
                                .arg("ls")
                                .arg(format!("s3://{}", bucket_name))
                                .arg("--endpoint-url")
                                .arg(endpoint_url)
                                .output();

                            match verify {
                                Ok(v) if v.status.success() => {
                                    println!(
                                        "[PrivateFolderSync] Bucket accessible after failed create, proceeding."
                                    );
                                    true
                                }
                                _ => {
                                    eprintln!(
                                        "[PrivateFolderSync] Failed to create bucket, will retry in 30s: {}",
                                        stderr
                                    );
                                    false
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[PrivateFolderSync] Failed to execute 'aws s3 mb' command (will retry in 30s): {}",
                        e
                    );
                    // Try a follow-up access check; if accessible, proceed
                    let verify = Command::new("aws")
                        .env("AWS_PAGER", "")
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
                // Wait 30 seconds before retrying
                thread::sleep(Duration::from_secs(30));
                continue;
            }
        }
    }

    match Command::new("aws")
        .env("AWS_PAGER", "")
        .arg("s3")
        .arg("ls")
        .arg(format!("s3://{}", bucket_name))
        .arg("--endpoint-url")
        .arg(endpoint_url)
        .output()
    {
        Ok(o) if o.status.success() => {
            println!(
                "[PrivateFolderSync] Preflight: AWS CLI can access bucket 's3://{}'",
                bucket_name
            );
        }
        Ok(o) => {
            eprintln!(
                "[PrivateFolderSync] Preflight: 'aws s3 ls' failed (exit {}) stderr: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr)
            );
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
        
        // Sync the contents of the local folder directly to the bucket root (no extra top-level prefix)
        let s3_destination = format!("s3://{}/", bucket_name);

        // --- Step 1: Dry Run to get total file count ---
        println!("[PrivateFolderSync] Starting dry run to calculate changes...");
        
        
        let dry_run_output = Command::new("aws")
            .env("AWS_PAGER", "")
            .arg("s3")
            .arg("sync")
            .arg(&sync_path)
            .arg(&s3_destination)
            .arg("--endpoint-url")
            .arg(endpoint_url)
            .arg("--delete")
            .arg("--dryrun")
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
        
        let mut child = Command::new("aws")
            .env("AWS_PAGER", "")
            .arg("s3")
            .arg("sync")
            .arg(&sync_path)
            .arg(&s3_destination)
            .arg("--endpoint-url")
            .arg(endpoint_url)
            .arg("--delete")
            .arg("--no-progress") 
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Failed to spawn 'aws s3 sync' command");

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
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
                             state.recent_items.push_front(item);
                             if state.recent_items.len() > 50 {
                                 state.recent_items.pop_back();
                             }
                        }
                    }
                }
            });
        }
        
        // Wait for completion, but terminate promptly if global cancellation is requested
        let status = loop {
            if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
                eprintln!("[PrivateFolderSync] Cancellation during active sync; killing aws child");
                let _ = child.kill();
                // After kill, try to reap once
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
        
        if status.success() {
             println!("[PrivateFolderSync] Sync completed successfully.");
        } else {
            eprintln!("[PrivateFolderSync] Sync failed.");
        }

        {
            let mut state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
            state.in_progress = false;
            state.current_item = None;
            if status.success() {
                state.processed_files = state.total_files;
            }
        }

        println!("[PrivateFolderSync] Waiting for 1 minutes before next sync.");
        sleep(Duration::from_secs(60)).await;
    }
}


#[tauri::command]
pub async fn start_private_folder_sync_tauri(_app_handle: AppHandle, account_id: String, seed_phrase: String) {
    // Do NOT spawn here. Let the caller spawn and track this task so it can be aborted on logout.
    start_private_folder_sync(account_id, seed_phrase).await;
}