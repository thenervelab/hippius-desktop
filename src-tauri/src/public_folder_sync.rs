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

    let bucket_name = format!("{}-public", account_id); // Public bucket
    let endpoint_url = "https://s3.hippius.com";
    let encoded_seed_phrase = encode(&seed_phrase);

    // --- Bucket creation and preflight checks (No changes needed here) ---
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
        let mb_output = Command::new("aws")
            .env("AWS_PAGER", "")
            .arg("s3")
            .arg("mb")
            .arg(format!("s3://{}", bucket_name))
            .arg("--endpoint-url")
            .arg(endpoint_url)
            .output();

        match mb_output {
            Ok(output) => {
                if output.status.success() {
                    println!("[PublicFolderSync] Successfully created bucket 's3://{}'.", bucket_name);
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    // Proceed if bucket already exists/owned
                    if stderr.contains("BucketAlreadyExists") || stderr.contains("BucketAlreadyOwnedByYou") {
                        println!("[PublicFolderSync] Bucket already exists (race condition), proceeding.");
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
                            }
                            _ => {
                                eprintln!("[PublicFolderSync] Failed to create bucket: {}", stderr);
                                {
                                    let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                                    syncing_accounts.remove(&(account_id.clone(), "public"));
                                }
                                return;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("[PublicFolderSync] Failed to execute 'aws s3 mb' command: {}", e);
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
                        println!("[PublicFolderSync] Bucket accessible after 'mb' exec error, proceeding.");
                    }
                    _ => {
                        {
                            let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                            syncing_accounts.remove(&(account_id.clone(), "public"));
                        }
                        return;
                    }
                }
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
            println!("[PublicFolderSync] Preflight: AWS CLI can access bucket 's3://{}'", bucket_name);
        }
        Ok(o) => {
            eprintln!(
                "[PublicFolderSync] Preflight: 'aws s3 ls' failed (exit {}) stderr: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr)
            );
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

        // --- MODIFICATION START ---
        // Get the name of the folder we are syncing
        let sync_folder_name = Path::new(&sync_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if sync_folder_name.is_empty() {
            eprintln!("[PublicFolderSync] Could not determine sync folder name from path: {}", sync_path);
            sleep(Duration::from_secs(60)).await;
            continue;
        }
        // Construct the destination URI to include the folder name
        let s3_destination = format!("s3://{}/{}/", bucket_name, sync_folder_name);
        // --- MODIFICATION END ---


        let dry_run_output = Command::new("aws")
            // .current_dir(&sync_path) // No longer needed
            .arg("s3")
            .arg("sync")
            .arg(&sync_path) // Use the full path as the source
            .arg(&s3_destination) // Use the new destination
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
             &s3_destination, // Use the new destination for logging
             endpoint_url
         );
        let mut child = Command::new("aws")
            // .current_dir(&sync_path) // No longer needed
            .arg("s3")
            .arg("sync")
            .arg(&sync_path) // Use the full path as the source
            .arg(&s3_destination) // Use the new destination
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
        
        let status = child.wait().expect("'aws s3 sync' command failed to run");
        
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

        println!("[PublicFolderSync] Cycle complete. Waiting for 5 minutes before next sync.");
        sleep(Duration::from_secs(60)).await;
    }
}

/// Tauri command to start the public folder sync process.
#[tauri::command]
pub async fn start_public_folder_sync_tauri(_app_handle: AppHandle, account_id: String, seed_phrase: String) {
    tokio::spawn(start_public_folder_sync(account_id, seed_phrase));
}