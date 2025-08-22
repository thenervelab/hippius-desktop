use crate::utils::sync::get_public_sync_path;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::sleep;
use base64::{encode};
use std::sync::atomic::Ordering;
use std::thread;
use std::path::Path;
use std::os::unix::process::ExitStatusExt;

// Import the new S3 state from sync_shared
pub use crate::sync_shared::{SYNCING_ACCOUNTS, GLOBAL_CANCEL_TOKEN, S3_PUBLIC_SYNC_STATE, RecentItem};

/// Parses a line from the `aws s3 sync` output to create a RecentItem.
fn parse_s3_sync_line(line: &str) -> Option<RecentItem> {
    let mut parts = line.split_whitespace();

    // The first part might be "(dryrun)". If it is, we skip it.
    let first_part = parts.next().unwrap_or("");
    let action_part = if first_part == "(dryrun)" {
        parts.next().unwrap_or("")
    } else {
        first_part
    };
    
    // The action should be "upload:" or "delete:"
    let action = match action_part {
        "upload:" => "uploaded",
        "delete:" => "deleted",
        _ => return None, // Not a line we care about
    };

    // The next part is always the path
    let path_part = parts.next().unwrap_or("");
    if path_part.is_empty() {
        return None;
    }

    let file_name = if action == "deleted" {
        // Input is an S3 URI like "s3://bucket/file.txt"
        path_part.rsplit('/').next().unwrap_or("")
    } else {
        // Input is a local path like "./file.txt" or "/path/to/file.txt"
        Path::new(path_part).file_name().and_then(|s| s.to_str()).unwrap_or("")
    };

    if file_name.is_empty() {
        return None;
    }
    
    Some(RecentItem {
        name: file_name.to_string(),
        scope: "public".to_string(),
        action: action.to_string(),
        kind: "file".to_string(), // Approximation
    })
}

/// Starts the main sync loop for the public folder.
pub async fn start_public_folder_sync(account_id: String, seed_phrase: String) {
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&(account_id.clone(), "public")) {
            println!("[PublicFolderSync] Account {} is already syncing publicly, skipping.", account_id);
            return;
        }
        syncing_accounts.insert((account_id.clone(), "public"));
    }

    let bucket_name = format!("{}-public", account_id);
    let endpoint_url = "https://s3.hippius.com";
    let encoded_seed_phrase = encode(&seed_phrase);

    println!("[PublicFolderSync] Ensuring bucket exists: s3://{}", bucket_name);
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
        println!("[PublicFolderSync] Bucket already exists, proceeding.");
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
                        println!("[PublicFolderSync] Successfully created bucket 's3://{}'.", bucket_name);
                        true
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        // Proceed if bucket already exists/owned
                        if stderr.contains("BucketAlreadyExists") || stderr.contains("BucketAlreadyOwnedByYou") {
                            println!("[PublicFolderSync] Bucket already exists (race condition), proceeding.");
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
                                    println!("[PublicFolderSync] Bucket accessible after failed create, proceeding.");
                                    true
                                }
                                _ => {
                                    eprintln!("[PublicFolderSync] Failed to create bucket, will retry in 30s: {}", stderr);
                                    false
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[PublicFolderSync] Failed to execute 'aws s3 mb' command (will retry in 30s): {}", e);
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

    // Ensure public-read bucket policy is applied so objects are publicly accessible
    // Equivalent to MinIO example via AWS CLI: allow s3:GetObject on bucket/*
    let bucket_policy = format!(
        r#"{{
            "Version": "2012-10-17",
            "Statement": [
                {{
                    "Effect": "Allow",
                    "Principal": "*",
                    "Action": ["s3:GetObject"],
                    "Resource": ["arn:aws:s3:::{bucket}/*"]
                }}
            ]
        }}"#,
        bucket = bucket_name
    );

    match Command::new("aws")
        .env("AWS_PAGER", "")
        .arg("s3api")
        .arg("put-bucket-policy")
        .arg("--bucket")
        .arg(&bucket_name)
        .arg("--policy")
        .arg(&bucket_policy)
        .arg("--endpoint-url")
        .arg(endpoint_url)
        .output()
    {
        Ok(o) if o.status.success() => {
            println!("[PublicFolderSync] Applied public-read bucket policy to '{}'.", bucket_name);
        }
        Ok(o) => {
            eprintln!(
                "[PublicFolderSync] Failed to apply bucket policy (exit {}), stderr: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr)
            );
        }
        Err(e) => {
            eprintln!("[PublicFolderSync] Error executing 'aws s3api put-bucket-policy': {}", e);
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
            println!("[PublicFolderSync] Preflight: AWS CLI can access bucket 's3://{}'", bucket_name);
        }
        Ok(o) => {
            eprintln!("[PublicFolderSync] Preflight: 'aws s3 ls' failed (exit {}) stderr: {}", o.status, String::from_utf8_lossy(&o.stderr));
        }
        Err(e) => {
            eprintln!("[PublicFolderSync] Preflight: failed to execute aws: {}", e);
        }
    }

    loop {
        if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
            println!("[PublicFolderSync] Global cancellation detected, stopping sync for account {}", account_id);
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "public"));
            }
            return;
        }

        let sync_path = match get_public_sync_path().await {
            Ok(path) => path,
            Err(e) => {
                eprintln!("[PublicFolderSync] Failed to get public sync path: {}", e);
                sleep(Duration::from_secs(60)).await;
                continue;
            }
        };

        // --- Step 1: Dry Run to get total file count ---
        println!("[PublicFolderSync] Starting dry run to calculate changes...");
        {
            let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
            state.in_progress = true;
            state.processed_files = 0;
            state.total_files = 0;
            state.current_item = None;
        }

        let s3_destination = format!("s3://{}/", bucket_name);

        let dry_run_output = Command::new("aws")
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

                // Use the CORRECTED parser to count the lines
                stdout.lines()
                    .filter_map(|line| parse_s3_sync_line(line))
                    .count()
            },
            Err(_) => {
                continue;
            }
        };

        println!("[PublicFolderSync] Dry run complete. Found {} changes.", total_changes);
        {
            let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
            state.total_files = total_changes;
        }

        if total_changes == 0 {
            println!("[PublicFolderSync] No changes detected. Waiting for next cycle.");
            {
                let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
                state.in_progress = false;
            }
            sleep(Duration::from_secs(60)).await;
            continue;
        }

        // --- Step 2: Live Parse the real sync ---
        println!("[PublicFolderSync] Syncing {} changes...", total_changes);
        println!(
            "[PublicFolderSync] Executing: aws s3 sync '{}' -> '{}' (endpoint: {}) with --delete",
            &sync_path,
            &s3_destination,
            endpoint_url
        );
        let mut child = Command::new("aws")
            .arg("s3")
            .arg("sync")
            .arg(&sync_path)
            .arg(&s3_destination)
            .arg("--endpoint-url")
            .arg(endpoint_url)
            .arg("--delete")
            .arg("--acl") 
            .arg("public-read") 
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Failed to spawn 'aws s3 sync' command for public sync");

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            thread::spawn(move || {
                for line in reader.lines() {
                    if let Ok(line) = line {
                        println!("[AWS Public Sync][STDOUT] {}", line);
                        if let Some(item) = parse_s3_sync_line(&line) {
                             let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
                             state.processed_files += 1;
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
        
        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            thread::spawn(move || {
                for line in reader.lines() {
                    if let Ok(line) = line {
                        eprintln!("[AWS Public Sync][STDERR] {}", line);
                    }
                }
            });
        }
        
        // Wait for completion, but terminate promptly if global cancellation is requested
        let status = loop {
            if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
                eprintln!("[PublicFolderSync] Cancellation during active sync; killing aws child");
                let _ = child.kill();
                // After kill, try to reap once
                match child.try_wait() {
                    Ok(Some(st)) => break st,
                    _ => break std::process::ExitStatus::from_raw(1),
                }
            }
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                Err(_) => {
                    eprintln!("[PublicFolderSync] Error while waiting for child; assuming failure");
                    break std::process::ExitStatus::from_raw(1);
                }
            }
        };
        
        if status.success() {
             println!("[PublicFolderSync] Sync completed successfully.");
        } else {
            eprintln!("[PublicFolderSync] Sync failed.");
        }

        {
            let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
            state.in_progress = false;
            state.current_item = None;
            if status.success() {
                state.processed_files = state.total_files;
            }
        }

        println!("[PublicFolderSync] Cycle complete. Waiting for 1 minutes before next sync.");
        sleep(Duration::from_secs(60)).await;
    }
}

/// Tauri command to start the public folder sync process.
#[tauri::command]
pub async fn start_public_folder_sync_tauri(_app_handle: AppHandle, account_id: String, seed_phrase: String) {
    // Do NOT spawn here. Let the caller spawn and track this task so it can be aborted on logout.
    start_public_folder_sync(account_id, seed_phrase).await;
}