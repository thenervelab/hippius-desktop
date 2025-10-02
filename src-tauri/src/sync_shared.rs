use crate::constants::folder_sync::SyncStatusResponse;
use crate::sync_engine::{MANIFEST_FOLDER, MANIFEST_ROOT};
use crate::user_profile_sync::UserProfileFileWithType;
use crate::utils::file_operations::calculate_local_size;
use crate::utils::s3_client::make_s3_client;
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use aws_sdk_s3::error::SdkError;
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Wry};

/// Gets the bucket name and path hash for a given account ID and scope ("public" or "private")
/// Returns a tuple of (bucket_name, path_hash)
pub fn get_bucket_name(
    account_id: &str,
    scope: &str,
    sync_path: &Path,
) -> Result<(String, String), String> {
    // Compute path hash
    let path_hash = {
        let mut hasher = DefaultHasher::new();
        sync_path.hash(&mut hasher);
        format!("{:x}", hasher.finish())[..8].to_string()
    };

    // Validate scope
    if scope != "public" && scope != "private" {
        return Err("Invalid scope. Must be 'public' or 'private'.".to_string());
    }

    // Format the bucket name
    let bucket_name = format!("{}-{}", account_id, scope);

    Ok((bucket_name, path_hash))
}

pub static SYNCING_ACCOUNTS: Lazy<Arc<Mutex<HashSet<(String, &'static str)>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub static GLOBAL_CANCEL_TOKEN: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

pub const MAX_RECENT_ITEMS: usize = 100;

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RecentItem {
    pub name: String,
    pub scope: String,
    pub action: String,
    pub kind: String,
    pub path: String,
    pub timestamp: i64,
}

impl RecentItem {
    pub fn to_user_profile_file(&self, account_id: &str) -> UserProfileFileWithType {
        // Calculate file size from local path if available
        let file_size = if !self.path.is_empty() {
            let path = Path::new(&self.path);
            if path.exists() {
                calculate_local_size(path).unwrap_or(0) as i64
            } else {
                0
            }
        } else {
            0
        };

        let is_deleted = self.action == "deleted" || self.action == "remove";
        UserProfileFileWithType {
            owner: account_id.to_string(),
            cid: "".to_string(),       // Not available in RecentItem
            file_hash: "".to_string(), // Not available in RecentItem
            file_name: self.name.clone(),
            file_size_in_bytes: file_size,
            is_assigned: false,                 // Default value
            last_charged_at: 0,                 // Default value
            main_req_hash: "s3".to_string(),    // Indicates this came from S3 sync
            selected_validator: "".to_string(), // Not available
            total_replicas: 1,                  // Default value
            block_number: 0,                    // Not available
            profile_cid: "".to_string(),        // Not available
            source: self.path.clone(),
            miner_ids: None,                   // Not available
            created_at: self.timestamp / 1000, // Convert ms to seconds
            is_folder: self.kind == "folder",
            type_: self.scope.clone(),
            deleted: is_deleted,
        }
    }
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct S3SyncState {
    pub in_progress: bool,
    pub total_files: usize,
    pub processed_files: usize,
    pub uploading_items: Vec<RecentItem>, // Track multiple uploading files
    pub recent_items: VecDeque<RecentItem>, // Stores the last N items
}

// --- Create separate state holders for Private and Public ---
pub static S3_PRIVATE_SYNC_STATE: Lazy<Arc<Mutex<S3SyncState>>> =
    Lazy::new(|| Arc::new(Mutex::new(S3SyncState::default())));

pub static S3_PUBLIC_SYNC_STATE: Lazy<Arc<Mutex<S3SyncState>>> =
    Lazy::new(|| Arc::new(Mutex::new(S3SyncState::default())));

#[derive(serde::Serialize, Clone, Debug)]
pub struct SyncActivityResponse {
    pub recent: Vec<UserProfileFileWithType>,
    pub uploading: Vec<UserProfileFileWithType>,
}

// --- Update Tauri Commands to Aggregate Data ---
#[tauri::command]
#[allow(dead_code)]
pub fn get_sync_status() -> SyncStatusResponse {
    let private_state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
    let public_state = S3_PUBLIC_SYNC_STATE.lock().unwrap();

    let total_files = private_state.total_files + public_state.total_files;
    let processed_files = private_state.processed_files + public_state.processed_files;
    let in_progress = private_state.in_progress || public_state.in_progress;

    // Synced files should never exceed total_files
    let synced_files = processed_files.min(total_files);

    let percent = if total_files > 0 {
        ((synced_files as f32 / total_files as f32) * 100.0).min(100.0)
    } else if in_progress {
        0.0 // In progress but total not yet calculated
    } else {
        0.0 // Not in progress and nothing to do
    };
    SyncStatusResponse {
        synced_files,
        total_files,
        in_progress,
        percent,
    }
}

#[tauri::command]
pub async fn get_sync_activity(
    app: tauri::AppHandle,
    account_id: String,
    limit: Option<usize>,
) -> SyncActivityResponse {
    let limit = limit.unwrap_or(100);

    // Collect all the data we need while holding the locks
    let (recent, uploading, should_check_public, should_check_private) = {
        let p_state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
        let pub_state = S3_PUBLIC_SYNC_STATE.lock().unwrap();

        // Combine and sort recent items
        let mut recent: Vec<RecentItem> = p_state
            .recent_items
            .iter()
            .chain(pub_state.recent_items.iter())
            .cloned()
            .collect();

        // Sort by timestamp (newest first)
        recent.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        recent.truncate(limit);

        // Get currently uploading items from both states
        let mut uploading = Vec::new();
        uploading.extend(p_state.uploading_items.iter().cloned());
        uploading.extend(pub_state.uploading_items.iter().cloned());

        // Determine if we need to check sync completion
        let should_check_public = (pub_state.uploading_items.is_empty()
            && !pub_state.recent_items.is_empty())
            || (pub_state.uploading_items.is_empty() && pub_state.recent_items.is_empty());
        let should_check_private = (p_state.uploading_items.is_empty()
            && !p_state.recent_items.is_empty())
            || (p_state.uploading_items.is_empty() && p_state.recent_items.is_empty());

        (recent, uploading, should_check_public, should_check_private)
    };

    // Now we can safely await without holding the locks
    if should_check_public {
        match crate::utils::sync::is_sync_completed("public").await {
            Ok(false) => {
                // Mark sync as completed
                if let Err(e) = crate::utils::sync::mark_first_run_complete("public").await {
                    eprintln!("Failed to mark sync as completed: {}", e);
                }
                if let Err(e) = app
                    .emit("sync_completed", serde_json::json!({"type": "public"}))
                    .map_err(|e| e.to_string())
                {
                    eprintln!("Failed to emit sync_completed event: {}", e);
                }
                println!(
                    "[Sync] public Sync completed with {} recent items inside get sync activity",
                    recent.len()
                );
            }
            Ok(true) => {
                // Sync already marked as completed, do nothing
            }
            Err(_e) => {
                //
            }
        }
    }

    if should_check_private {
        match crate::utils::sync::is_sync_completed("private").await {
            Ok(false) => {
                // Mark sync as completed
                if let Err(e) = crate::utils::sync::mark_first_run_complete("private").await {
                    eprintln!("Failed to mark sync as completed: {}", e);
                }
                if let Err(e) = app
                    .emit("sync_completed", serde_json::json!({"type": "private"}))
                    .map_err(|e| e.to_string())
                {
                    eprintln!("Failed to emit sync_completed event: {}", e);
                }
                println!(
                    "[Sync] private Sync completed with {} recent items inside get sync activity",
                    recent.len()
                );
            }
            Ok(true) => {
                // Sync already marked as completed, do nothing
            }
            Err(_e) => {
                //
            }
        }
    }

    // Convert to unified format with account_id as owner
    let recent_unified = recent
        .iter()
        .map(|item| item.to_user_profile_file(&account_id))
        .collect();

    let uploading_unified = uploading
        .iter()
        .map(|item| item.to_user_profile_file(&account_id))
        .collect();

    SyncActivityResponse {
        recent: recent_unified,
        uploading: uploading_unified,
    }
}

/// Stops all running sync processes and resets sync state
pub fn stop_all_sync_processes() {
    println!("[Sync] Stopping all sync processes...");

    // Signal all sync processes to stop
    GLOBAL_CANCEL_TOKEN.store(true, Ordering::SeqCst);

    // Clear all syncing accounts
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if !syncing_accounts.is_empty() {
            println!(
                "[Sync] Clearing {} syncing accounts",
                syncing_accounts.len()
            );
            syncing_accounts.clear();
        }
    }

    // Reset S3 sync states
    {
        let mut private_status = S3_PRIVATE_SYNC_STATE.lock().unwrap();
        *private_status = S3SyncState::default();
    }
    {
        let mut public_status = S3_PUBLIC_SYNC_STATE.lock().unwrap();
        *public_status = S3SyncState::default();
    }

    println!("[Sync] All sync processes stopped and states reset");
}

/// Stops sync processes and resets state for a specific scope
///
/// # Arguments
/// * `scope` - The scope to stop syncing for ("public" or "private")
pub fn stop_sync_for_scope(scope: &str) {
    println!("[Sync] Stopping sync processes for scope: {}", scope);

    // Signal sync processes to stop
    GLOBAL_CANCEL_TOKEN.store(true, Ordering::SeqCst);

    // Clear syncing accounts for the specified scope
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        let before_count = syncing_accounts.len();
        syncing_accounts.retain(|(_, sync_type)| *sync_type != scope);
        let after_count = syncing_accounts.len();
        if before_count != after_count {
            println!(
                "[Sync] Cleared {} syncing accounts for scope: {}",
                before_count - after_count,
                scope
            );
        }
    }

    // Reset the appropriate sync state
    match scope {
        "private" => {
            let mut private_status = S3_PRIVATE_SYNC_STATE.lock().unwrap();
            *private_status = S3SyncState::default();
            println!("[Sync] Reset private sync state");
        }
        "public" => {
            let mut public_status = S3_PUBLIC_SYNC_STATE.lock().unwrap();
            *public_status = S3SyncState::default();
            println!("[Sync] Reset public sync state");
        }
        _ => {
            println!("[Sync] Warning: Unknown scope '{}', no state reset", scope);
            return;
        }
    }

    println!("[Sync] Sync processes stopped for scope: {}", scope);
}

/// Resets all sync state (kept for backward compatibility)
pub fn reset_all_sync_state() {
    stop_all_sync_processes();
}

pub fn prepare_for_new_sync() {
    GLOBAL_CANCEL_TOKEN.store(false, Ordering::SeqCst);
}

/// Updates the sync state when a file transitions from uploading to uploaded
/// Removes any existing "uploading" entry for the same file and adds a new "uploaded" entry
#[allow(dead_code)]
pub fn update_uploaded_file(scope: &str, file_path: &str) -> Option<RecentItem> {
    let state = if scope == "public" {
        S3_PUBLIC_SYNC_STATE.lock().unwrap()
    } else {
        S3_PRIVATE_SYNC_STATE.lock().unwrap()
    };

    // Create a new RecentItem for the uploaded file
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    if file_name.is_empty() {
        return None;
    }

    let uploaded_item = RecentItem {
        name: file_name.to_string(),
        scope: scope.to_string(),
        action: "uploaded".to_string(),
        kind: "file".to_string(),
        path: file_path.to_string(),
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    };

    // We need to drop the lock before calling any other functions that might lock
    drop(state);

    // Now get a mutable lock to update the state
    let mut state = if scope == "public" {
        S3_PUBLIC_SYNC_STATE.lock().unwrap()
    } else {
        S3_PRIVATE_SYNC_STATE.lock().unwrap()
    };

    // Remove any existing "uploading" entry for this file
    state.recent_items.retain(|item| item.path != file_path);

    // Only push if it doesn't already exist in recent_items
    let already_exists = state.recent_items.iter().any(|item| item.path == file_path);
    if !already_exists {
        state.recent_items.push_front(uploaded_item.clone());
    }

    // Trim the list if it gets too long
    while state.recent_items.len() > MAX_RECENT_ITEMS {
        state.recent_items.pop_back();
    }

    // Remove the file from uploading_items if it exists there
    state.uploading_items.retain(|item| item.path != file_path);

    Some(uploaded_item)
}

#[tauri::command]
pub fn app_close(app: AppHandle<Wry>) {
    app.exit(0);
}

// Helper to collect files recursively
pub fn collect_files_recursively(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') {
                continue; // Skip hidden files and directories
            }
        }

        if path.is_file() {
            files.push(path);
        } else if path.is_dir() {
            collect_files_recursively(&path, files)?;
        }
    }
    Ok(())
}

/// List all buckets using SDK (no CLI)
pub async fn list_all_buckets() -> Result<Vec<String>, String> {
    let client = make_s3_client().await;

    match client.list_buckets().send().await {
        Ok(resp) => {
            let buckets = resp
                .buckets
                .unwrap_or_default()
                .into_iter()
                .filter_map(|b| b.name)
                .collect::<Vec<_>>();
            Ok(buckets)
        }
        Err(e) => Err(format!("Failed to list buckets: {}", e)),
    }
}

/// Lists all files and folders across all S3 buckets
pub async fn list_bucket_contents(
    account_id: String,
    scope: String,
) -> Result<Vec<BucketItem>, String> {
    println!("[ListAllBuckets] Listing contents for all buckets");
    // // Get all bucket names and filter based on scope
    // let mut bucket_names = list_all_buckets().await?;

    // Filter buckets based on scope and format
    if scope != "private" && scope != "public" {
        return Err("Invalid scope. Must be 'public' or 'private'.".to_string());
    }

    // // Look for either -{scope}- in the middle or -{scope} at the end
    // let scope_pattern = format!("-{scope}-");
    // let scope_suffix = format!("-{scope}");
    // bucket_names.retain(|name| name.contains(&scope_pattern) || name.ends_with(&scope_suffix));

    let mut all_items = Vec::new();
    let mut errors = Vec::new();

    // Only include buckets for which we have a valid sync path
    let mut bucket_names = Vec::new();

    if scope == "public" {
        // Check and add public bucket if path exists
        if let Ok(public_path) = get_public_sync_path().await {
            if let Ok((bucket_name, _)) =
                get_bucket_name(&account_id, "public", std::path::Path::new(&public_path))
            {
                bucket_names.push(bucket_name);
            }
        }
    } else {
        // Check and add private bucket if path exists
        if let Ok(private_path) = get_private_sync_path().await {
            if let Ok((bucket_name, _)) =
                get_bucket_name(&account_id, "private", std::path::Path::new(&private_path))
            {
                bucket_names.push(bucket_name);
            }
        }
    }

    println!("[ListAllBuckets] Found {} buckets", bucket_names.len());

    // Process each bucket in parallel
    let handles: Vec<_> = bucket_names
        .into_iter()
        .map(|bucket_name| {
            tokio::spawn(async move {
                match list_single_bucket_contents(&bucket_name).await {
                    Ok(items) => Ok(items),
                    Err(e) => {
                        eprintln!(
                            "[ListAllBuckets] Error processing bucket {}: {}",
                            bucket_name, e
                        );
                        Err((bucket_name, e))
                    }
                }
            })
        })
        .collect();

    // Wait for all buckets to be processed
    for handle in handles {
        match handle.await {
            Ok(Ok(items)) => all_items.extend(items),
            Ok(Err((bucket, e))) => errors.push(format!("{}: {}", bucket, e)),
            Err(e) => errors.push(format!("Task failed: {}", e)),
        }
    }

    if !errors.is_empty() {
        eprintln!(
            "[ListAllBuckets] Completed with {} errors: {:?}",
            errors.len(),
            errors
        );
        if all_items.is_empty() {
            return Err(format!("Failed to list any buckets: {}", errors.join("; ")));
        }
    }

    // Remove duplicates based on path and size
    let mut seen = std::collections::HashSet::new();
    all_items.retain(|item| {
        let key = (item.path.clone(), item.size);
        let is_new = !seen.contains(&key);
        if is_new {
            seen.insert(key);
        }
        is_new
    });
    println!("[ListAllBuckets] Found {} unique items", seen.len());
    Ok(all_items)
}

pub async fn list_single_bucket_contents(bucket_name: &str) -> Result<Vec<BucketItem>, String> {
    let client = make_s3_client().await;
    let mut all_objects = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client.list_objects_v2().bucket(bucket_name);

        if let Some(token) = &continuation_token {
            req = req.continuation_token(token);
        }

        let resp = req.send().await;

        match resp {
            Ok(output) => {
                // contents() returns Option<&[Object]>, so we need to handle it correctly
                if let Some(contents) = output.contents {
                    all_objects.extend(contents);
                }

                // is_truncated is Option<bool>, so we need to unwrap or default to false
                if output.is_truncated.unwrap_or(false) {
                    continuation_token = output.next_continuation_token.map(|s| s.to_string());
                } else {
                    break;
                }
            }
            Err(SdkError::ServiceError(service_error)) => {
                // Handle NoSuchBucket error
                if service_error.err().is_no_such_bucket() {
                    println!(
                        "[ListBucket] Bucket {} does not exist, skipping",
                        bucket_name
                    );
                    return Ok(Vec::new());
                }
                return Err(format!(
                    "Failed to list bucket contents: {}",
                    service_error.err()
                ));
            }
            Err(e) => {
                return Err(format!("Failed to list bucket contents: {}", e));
            }
        }
    }

    // === Post-process object metadata ===
    let mut root_files: Vec<BucketItem> = Vec::new();
    let mut folder_sizes: HashMap<String, u64> = HashMap::new();
    let mut folder_last_modified: HashMap<String, String> = HashMap::new();
    let mut folder_storage_class: HashMap<String, String> = HashMap::new();
    let mut folder_ipfs_hash: HashMap<String, String> = HashMap::new();

    for item in all_objects {
        let key = match item.key() {
            Some(k) => k,
            None => continue,
        };

        if key.starts_with(MANIFEST_FOLDER) || *key == *MANIFEST_ROOT {
            continue;
        }

        let size_val = item.size().unwrap_or(0) as u64;
        let storage_class = item
            .storage_class()
            .map(|s| s.as_str().to_string())
            .unwrap_or_else(|| "STANDARD".to_string());

        // The "Owner" field is not included in list_objects_v2 by default
        let ipfs_hash = item.owner().and_then(|o| o.id()).unwrap_or("").to_string();

        let last_modified_fmt = item
            .last_modified()
            .and_then(|dt| {
                let secs = dt.secs();
                let nsecs = dt.subsec_nanos();
                DateTime::from_timestamp(secs, nsecs)

                // DateTime::<Utc>::from_timestamp(secs, nsecs)
            })
            .unwrap_or_else(|| Utc::now())
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();

        if key.ends_with('/') {
            // Handle folders explicitly ending in '/'
            let folder_name = key.trim_end_matches('/').to_string();
            if let Some(slash_pos) = folder_name.find('/') {
                let root_folder = folder_name[..slash_pos].to_string();
                *folder_sizes.entry(root_folder.clone()).or_insert(0) += size_val;
                folder_last_modified.insert(root_folder.clone(), last_modified_fmt.clone());
                folder_storage_class.insert(root_folder.clone(), storage_class.clone());
                folder_ipfs_hash.insert(root_folder, ipfs_hash);
            } else {
                *folder_sizes.entry(folder_name.clone()).or_insert(0) += size_val;
                folder_last_modified.insert(folder_name.clone(), last_modified_fmt.clone());
                folder_storage_class.insert(folder_name.clone(), storage_class.clone());
                folder_ipfs_hash.insert(folder_name, ipfs_hash);
            }
        } else if let Some(slash_pos) = key.find('/') {
            // Object inside a folder
            let folder_name = key[..slash_pos].to_string();
            *folder_sizes.entry(folder_name.clone()).or_insert(0) += size_val;
            folder_last_modified.insert(folder_name.clone(), last_modified_fmt.clone());
            folder_storage_class.insert(folder_name, storage_class);
        } else {
            // Root-level file
            root_files.push(BucketItem {
                path: key.to_string(),
                size: size_val,
                last_modified: last_modified_fmt,
                is_folder: false,
                storage_class: storage_class.clone(),
                ipfs_hash,
                bucket_name: bucket_name.to_string(),
            });
        }
    }

    // === Convert folder metadata into BucketItem ===
    let mut root_folders: Vec<BucketItem> = folder_sizes
        .into_iter()
        .map(|(path, size)| {
            let last_modified = folder_last_modified.get(&path).cloned().unwrap_or_default();
            let storage_class = folder_storage_class
                .get(&path)
                .cloned()
                .unwrap_or_else(|| "STANDARD".to_string());
            let ipfs_hash = folder_ipfs_hash.get(&path).cloned().unwrap_or_default();

            BucketItem {
                path,
                size,
                last_modified,
                is_folder: true,
                storage_class,
                ipfs_hash,
                bucket_name: bucket_name.to_string(),
            }
        })
        .collect();

    root_files.append(&mut root_folders);
    Ok(root_files)
}

#[derive(Debug, Clone, Serialize)]
pub struct BucketItem {
    pub path: String,
    pub size: u64,
    pub last_modified: String,
    pub is_folder: bool,
    pub storage_class: String,
    pub ipfs_hash: String,
    pub bucket_name: String,
}

pub async fn store_bucket_listing_in_db(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    items: &[BucketItem],
) -> Result<usize, sqlx::Error> {
    let file_type = if scope == "public" {
        "public"
    } else {
        "private"
    };

    // Get recent items from state
    let recent_items = if scope == "public" {
        S3_PUBLIC_SYNC_STATE.lock().unwrap().recent_items.clone()
    } else {
        S3_PRIVATE_SYNC_STATE.lock().unwrap().recent_items.clone()
    };

    // Extract file names of items that are currently being uploaded (exclude these from deletion)
    // but only if they don't exist in the items parameter
    let item_names: HashSet<&str> = items.iter().map(|item| item.path.as_str()).collect();
    let uploading_file_names: Vec<&str> = recent_items
        .iter()
        .filter(|item| item.action != "deleted" && !item_names.contains(item.name.as_str()))
        .map(|item| item.name.as_str())
        .collect();

    // Build the delete query
    let mut query =
        "DELETE FROM user_profiles WHERE owner = ? AND type = ? AND main_req_hash = 's3'"
            .to_string();

    // Add condition to exclude only uploading files (not all recent items)
    if !uploading_file_names.is_empty() {
        let placeholders = vec!["?"; uploading_file_names.len()].join(",");
        query.push_str(&format!(" AND file_name NOT IN ({})", placeholders));
    }

    let mut query = sqlx::query(&query).bind(owner).bind(file_type);

    // Bind uploading file names to exclude from deletion
    for name in uploading_file_names {
        query = query.bind(name);
    }

    query.execute(pool).await?;

    let mut stored = 0usize;

    // Get the list of deleted file names from recent items
    let deleted_files: HashSet<&str> = recent_items
        .iter()
        .filter(|item| item.action == "deleted" && !item_names.contains(item.name.as_str()))
        .map(|item| item.name.as_str())
        .collect();

    for it in items {
        if it.path.starts_with(MANIFEST_FOLDER) || it.path == MANIFEST_ROOT {
            continue;
        }
        // Skip files that are marked for deletion
        if deleted_files.contains(it.path.as_str()) {
            continue;
        }
        let file_name = it.path.clone();
        let source = format!("s3://{}/{}", it.bucket_name, it.path);
        let cid_hex = hex::encode(it.ipfs_hash.as_bytes());
        let file_hash_hex = cid_hex.clone();

        let is_assigned = it.ipfs_hash != "pending";

        // Only insert if file with same name and type doesn't exist
        let result = sqlx::query(
            "INSERT OR IGNORE INTO user_profiles (
                file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, 
                main_req_hash, selected_validator, total_replicas, block_number, profile_cid, 
                source, miner_ids, type, is_folder, created_at, bucket_name
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM user_profiles 
                WHERE file_name = ? AND type = ? AND owner = ?
            )",
        )
        .bind(&file_name)
        .bind(owner)
        .bind(&cid_hex)
        .bind(&file_hash_hex)
        .bind(it.size as i64)
        .bind(is_assigned)
        .bind(0i64)
        .bind("s3")
        .bind("")
        .bind(0i64)
        .bind(0i64)
        .bind("")
        .bind(&source)
        .bind("")
        .bind(file_type)
        .bind(it.is_folder)
        .bind(
            chrono::DateTime::parse_from_rfc3339(&it.last_modified)
                .unwrap_or_else(|_| chrono::Utc::now().into())
                .timestamp(),
        )
        .bind(&it.bucket_name)
        // WHERE NOT EXISTS conditions
        .bind(&file_name)
        .bind(file_type)
        .bind(owner)
        .execute(pool)
        .await?;

        if result.rows_affected() > 0 {
            stored += 1;
        }
        stored += 1;
    }

    Ok(stored)
}

pub async fn insert_bucket_items_if_absent(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    items: &[BucketItem],
) -> Result<usize, sqlx::Error> {
    let file_type = if scope == "public" {
        "public"
    } else {
        "private"
    };
    let mut stored = 0usize;

    for it in items {
        let file_name = it.path.clone();
        let exists: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM user_profiles WHERE owner = ? AND type = ? AND file_name = ? LIMIT 1",
        )
        .bind(owner)
        .bind(file_type)
        .bind(&file_name)
        .fetch_optional(pool)
        .await?;

        if exists.is_none() {
            let source = format!("s3://{}/{}", it.bucket_name, it.path);
            let cid_hex = hex::encode(it.ipfs_hash.as_bytes());
            let file_hash_hex = cid_hex.clone();

            sqlx::query(
                "INSERT INTO user_profiles (
                    file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, main_req_hash, selected_validator, total_replicas, block_number, profile_cid, source, miner_ids, type, is_folder, created_at, bucket_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&file_name)
            .bind(owner)
            .bind(&cid_hex)
            .bind(&file_hash_hex)
            .bind(it.size as i64)
            .bind(false)
            .bind(0i64)
            .bind("s3")
            .bind("")
            .bind(0i64)
            .bind(0i64)
            .bind("")
            .bind(&source)
            .bind("")
            .bind(file_type)
            .bind(it.is_folder)
            .bind(chrono::DateTime::parse_from_rfc3339(&it.last_modified)
                .unwrap_or_else(|_| chrono::Utc::now().into())
                .timestamp())
            .bind(&it.bucket_name)
            .execute(pool)
            .await?;

            stored += 1;
        }
    }
    println!(
        "[InsertBucketItemsIfAbsent] Inserted {} items for {} {}",
        stored, owner, scope
    );
    Ok(stored)
}

// Convenience: single-item variant
pub async fn insert_bucket_item_if_absent(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    item: &BucketItem,
) -> Result<bool, sqlx::Error> {
    let added =
        insert_bucket_items_if_absent(pool, owner, scope, std::slice::from_ref(item)).await?;
    Ok(added > 0)
}

// Delete a previously stored S3-derived record for this owner/scope by its top-level name.
// Matches how inserts are written (user_profiles with main_req_hash = 's3').
pub async fn delete_bucket_item_by_name(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    name: &str,
) -> Result<u64, sqlx::Error> {
    let file_type = if scope == "public" {
        "public"
    } else {
        "private"
    };
    let res = sqlx::query(
        "DELETE FROM user_profiles WHERE owner = ? AND type = ? AND file_name = ? AND main_req_hash = 's3'",
    )
    .bind(owner)
    .bind(file_type)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

pub fn folder_size(path: &Path) -> u64 {
    let mut size = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(metadata) = fs::metadata(&path) {
                    size += metadata.len();
                }
            } else if path.is_dir() {
                size += folder_size(&path);
            }
        }
    }

    size
}
