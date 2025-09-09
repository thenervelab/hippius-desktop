use std::sync::{Arc, Mutex};
use std::collections::{HashSet, VecDeque};
use tauri::{AppHandle, Wry};
use crate::constants::folder_sync::{SyncStatusResponse}; 
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::Path; 
use std::path::PathBuf;
// use std::fs;
use std::process::Command;
use serde::Serialize;
use sqlx::SqlitePool;
use hex;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
// use chrono::{DateTime, Utc};
use crate::user_profile_sync::UserProfileFileWithType;
use crate::utils::file_operations::calculate_local_size;
use crate::commands::node::get_aws_binary_path;

/// Parses a line from the `aws s3 sync` output to create a RecentItem.
pub fn parse_s3_sync_line(line: &str, scope: &str) -> Option<RecentItem> {
    // Normalize and strip optional dryrun prefix
    let mut s = line.trim();
    if s.starts_with("(dryrun)") {
        s = s.trim_start_matches("(dryrun)").trim();
    }

    // Helper to resolve absolute path for local filesystem entries
    let abs_path = |p: &str| -> String {
        let pth = std::path::Path::new(p);
        // Try canonicalize first (resolves symlinks). If it fails, fall back to CWD join for relative paths
        if let Ok(canon) = std::fs::canonicalize(pth) {
            canon.to_string_lossy().to_string()
        } else if pth.is_relative() {
            if let Ok(cwd) = std::env::current_dir() {
                cwd.join(pth).to_string_lossy().to_string()
            } else {
                p.to_string()
            }
        } else {
            p.to_string()
        }
    };

    // Helper to build item
    let mk_item = |name: &str, action: &str, path: String| -> Option<RecentItem> {
        if name.is_empty() { return None; }
        let now_ms: i64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Some(RecentItem {
            name: name.to_string(),
            scope: scope.to_string(),
            action: action.to_string(),
            kind: "file".to_string(),
            path,
            timestamp: now_ms,
        })
    };

    // Handle 'upload:' lines: "upload: <src> to s3://..."
    if let Some(rest) = s.strip_prefix("upload:") {
        let rest = rest.trim_start();
        let src = if let Some(idx) = rest.find(" to ") { &rest[..idx] } else { rest };
        let file_name = Path::new(src).file_name().and_then(|s| s.to_str()).unwrap_or("");
        let path_abs = abs_path(src);
        return mk_item(file_name, "uploaded", path_abs);
    }

    // Handle 'copy:' lines similarly to upload (ACL/metadata changes)
    if let Some(rest) = s.strip_prefix("copy:") {
        let rest = rest.trim_start();
        let src = if let Some(idx) = rest.find(" to ") { &rest[..idx] } else { rest };
        let file_name = Path::new(src).file_name().and_then(|s| s.to_str()).unwrap_or("");
        let path_abs = abs_path(src);
        return mk_item(file_name, "uploaded", path_abs);
    }

    // Handle 'delete:' lines: "delete: s3://bucket/key"
    if let Some(rest) = s.strip_prefix("delete:") {
        let s3path = rest.trim();
        let file_name = s3path.rsplit('/').next().unwrap_or("");
        return mk_item(file_name, "deleted", s3path.to_string());
    }

    None
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
        UserProfileFileWithType {
            owner: account_id.to_string(),
            cid: "".to_string(),    // Not available in RecentItem
            file_hash: "".to_string(), // Not available in RecentItem
            file_name: self.name.clone(),
            file_size_in_bytes: file_size,
            is_assigned: false,      // Default value
            last_charged_at: 0,      // Default value
            main_req_hash: "s3".to_string(), // Indicates this came from S3 sync
            selected_validator: "".to_string(), // Not available
            total_replicas: 1,       // Default value
            block_number: 0,         // Not available
            profile_cid: "".to_string(), // Not available
            source: self.path.clone(),
            miner_ids: None,         // Not available
            created_at: self.timestamp / 1000, // Convert ms to seconds
            is_folder: self.kind == "folder",
            type_: self.scope.clone(),
        }
    }
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct S3SyncState {
    pub in_progress: bool,
    pub total_files: usize,
    pub processed_files: usize,
    pub current_item: Option<RecentItem>,
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
    pub uploading: Vec<UserProfileFileWithType>
}

// --- Update Tauri Commands to Aggregate Data ---
#[tauri::command]
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
pub fn get_sync_activity(account_id: String, limit: Option<usize>) -> SyncActivityResponse {
    let p_state = S3_PRIVATE_SYNC_STATE.lock().unwrap();
    let pub_state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
    let limit = limit.unwrap_or(100);

    // Combine and sort recent items
    let mut recent: Vec<RecentItem> = p_state.recent_items.iter()
        .chain(pub_state.recent_items.iter())
        .cloned()
        .collect();
    
    // Sort by timestamp (newest first)
    recent.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    recent.truncate(limit);

    // Get currently uploading items
    let uploading: Vec<RecentItem> = p_state.current_item.iter()
        .chain(pub_state.current_item.iter())
        .cloned()
        .collect();

    // Convert to unified format with account_id as owner
    let recent_unified = recent.iter()
        .map(|item| item.to_user_profile_file(&account_id))
        .collect();
        
    let uploading_unified = uploading.iter()
        .map(|item| item.to_user_profile_file(&account_id))
        .collect();
        
    SyncActivityResponse { 
        recent: recent_unified,
        uploading: uploading_unified 
    }
}

pub fn reset_all_sync_state() {
    
    GLOBAL_CANCEL_TOKEN.store(true, Ordering::SeqCst);
    
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        syncing_accounts.clear();
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
}

pub fn prepare_for_new_sync() {
    GLOBAL_CANCEL_TOKEN.store(false, Ordering::SeqCst);
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

pub async fn insert_file_if_not_exists(pool: &sqlx::SqlitePool, file_path: &Path, owner: &str, is_public: bool, is_folder: bool) {
    let file_path = if file_path.is_relative() {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(file_path),
            Err(e) => {
                eprintln!("Failed to get current directory: {}", e);
                return;
            }
        }
    } else {
        file_path.to_path_buf()
    };
    let file_name = file_path.file_name().unwrap().to_string_lossy();
    let file_type = if is_public { "public" } else { "private" };

    let exists: Option<(String,)> = sqlx::query_as(
        "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND owner = ? AND type = ?"
    )
    .bind(&file_name)
    .bind(owner)
    .bind(file_type)
    .fetch_optional(pool)
    .await
    .unwrap();
    println!("[insert_file_if_not_exists] Inserting record for '{}', owner: {}, type: {}", file_name, owner, file_type);
    if exists.is_none() {
        println!("[insert_file_if_not_exists] Inserting record for '{}', owner: {}, type: {}", file_name, owner, file_type);
        sqlx::query(
            "INSERT INTO sync_folder_files (
                file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, main_req_hash, selected_validator, total_replicas, block_number, profile_cid, source, miner_ids, type, is_folder
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&file_name)
        .bind(owner)
        .bind("")
        .bind("")
        .bind(0)
        .bind(false)
        .bind(0)
        .bind("")
        .bind("")
        .bind(0)
        .bind(0)
        .bind("")
        .bind("")
        .bind("")
        .bind(file_type)
        .bind(is_folder)
        .execute(pool)
        .await
        .unwrap();
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BucketItem {
    pub path: String,
    pub size: u64,
    pub last_modified: String,
    pub is_folder: bool, 
    pub storage_class: String,
    pub ipfs_hash: String,
}

/// Lists all root-level files and folders in a given S3 bucket using AWS CLI.
/// Folders will have their total size calculated by summing up the sizes of their contents.
pub async fn list_bucket_contents(account_id: String, scope: String) -> Result<Vec<BucketItem>, String> {
    if scope != "public" && scope != "private" {
        return Err("Invalid scope provided. Must be 'public' or 'private'.".to_string());
    }

    let bucket_name = format!("{}-{}", account_id, scope);
    let endpoint_url = "https://s3.hippius.com";

    println!("[ListBucket] Listing contents for bucket: s3://{}", bucket_name);

    // Dynamically get the AWS binary path
    let aws_binary_path = match get_aws_binary_path().await {
        Ok(path) => {
            println!("[ListBucket] Found AWS binary at: {}", path.display());
            path
        }
        Err(e) => {
            eprintln!("[ListBucket] Failed to get AWS binary path: {}, falling back to system PATH", e);
            // Fall back to checking system PATH with which crate
            if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                println!("[ListBucket] Found AWS in system PATH at: {}", path.display());
                path
            } else {
                eprintln!("[ListBucket] AWS CLI not found in system PATH or custom location");
                return Err("AWS CLI not found".to_string());
            }
        }
    };

    // Construct dynamic PATH with OS-appropriate separator
    let path_separator = if cfg!(windows) { ";" } else { ":" };
    let dynamic_path = format!(
        "{}{}{}",
        aws_binary_path.parent().unwrap().to_string_lossy(),
        path_separator,
        std::env::var("PATH").unwrap_or_default()
    );

    // Execute aws s3api list-objects-v2 command
    let output = Command::new(&aws_binary_path)
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3api")
        .arg("list-objects-v2")
        .arg("--bucket")
        .arg(&bucket_name)
        .arg("--endpoint-url")
        .arg(endpoint_url)
        .output()
        .map_err(|e| format!("Failed to execute aws command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[ListBucket] Failed to list bucket contents: {}", stderr);
        return Err(format!("Failed to list bucket contents: {}", stderr));
    }

    // Parse the JSON output
    let output_str = String::from_utf8_lossy(&output.stdout);
    let result: serde_json::Value = serde_json::from_str(&output_str)
        .map_err(|e| format!("Failed to parse AWS CLI output: {}", e))?;

    let mut root_files: Vec<BucketItem> = Vec::new();
    let mut folder_sizes: HashMap<String, u64> = HashMap::new();
    let mut folder_last_modified: HashMap<String, String> = HashMap::new();
    let mut folder_storage_class: HashMap<String, String> = HashMap::new();
    let mut folder_ipfs_hash: HashMap<String, String> = HashMap::new();

    // Process each object in the response
    if let Some(contents) = result["Contents"].as_array() {
        for item in contents {
            let storage_class = item["StorageClass"].as_str().unwrap_or("STANDARD").to_string();
            let ipfs_hash = item["Owner"]
                .as_object()
                .and_then(|o| o.get("ID"))
                .and_then(|id| id.as_str())
                .unwrap_or("")
                .to_string();

            if let (Some(key), Some(size_val), Some(last_modified)) = (
                item["Key"].as_str(),
                item["Size"].as_u64(),
                item["LastModified"].as_str(),
            ) {
                // Parse the last modified date to a consistent format
                let last_modified_dt = chrono::DateTime::parse_from_rfc3339(last_modified)
                    .map_err(|_| "Failed to parse last modified date")?;
                let last_modified_fmt = last_modified_dt.format("%Y-%m-%d %H:%M:%S").to_string();

                if key.ends_with('/') {
                    // This is a folder (common prefix)
                    let folder_name = key.trim_end_matches('/').to_string();
                    if let Some(slash_pos) = folder_name.find('/') {
                        // This is a subfolder, track the root folder
                        let root_folder = folder_name[..slash_pos].to_string();
                        *folder_sizes.entry(root_folder.clone()).or_insert(0) += size_val;
                        folder_last_modified.insert(root_folder.clone(), last_modified_fmt.clone());
                        folder_storage_class.insert(root_folder.clone(), storage_class);
                        folder_ipfs_hash.insert(root_folder.clone(), ipfs_hash);
                    } else {
                        // This is a root folder
                        *folder_sizes.entry(folder_name.clone()).or_insert(0) += size_val;
                        folder_last_modified.insert(folder_name.clone(), last_modified_fmt.clone());
                        folder_storage_class.insert(folder_name.clone(), storage_class);
                        folder_ipfs_hash.insert(folder_name, ipfs_hash);
                    }
                } else {
                    // This is a file
                    if let Some(slash_pos) = key.find('/') {
                        // File is inside a folder
                        let folder_name = key[..slash_pos].to_string();
                        *folder_sizes.entry(folder_name.clone()).or_insert(0) += size_val;
                        folder_last_modified.insert(folder_name.clone(), last_modified_fmt.clone());
                        folder_storage_class.insert(folder_name.clone(), storage_class.clone());
                        folder_ipfs_hash.insert(folder_name, ipfs_hash);
                    } else {
                        // This is a root file
                        root_files.push(BucketItem {
                            path: key.to_string(),
                            size: size_val,
                            last_modified: last_modified_fmt,
                            is_folder: false,
                            storage_class,
                            ipfs_hash,
                        });
                    }
                }
            }
        }
    }

    // Convert folder information to BucketItem
    let mut root_folders: Vec<BucketItem> = folder_sizes
        .into_iter()
        .map(|(path, size)| {
            let last_modified = folder_last_modified.get(&path).cloned().unwrap_or_default();
            let storage_class = folder_storage_class.get(&path).cloned().unwrap_or_else(|| "STANDARD".to_string());
            let ipfs_hash = folder_ipfs_hash.get(&path).cloned().unwrap_or_default();
            
            BucketItem {
                path,
                size,
                last_modified,
                is_folder: true,
                storage_class,
                ipfs_hash,
            }
        })
        .collect();

    // Combine root files and folders
    root_files.append(&mut root_folders);
    
    Ok(root_files)
}

pub async fn store_bucket_listing_in_db(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    items: &[BucketItem],
) -> Result<usize, sqlx::Error> {
    let file_type = if scope == "public" { "public" } else { "private" };
    let bucket = format!("{}-{}", owner, file_type);

    // Remove any existing S3-derived records for this owner and scope to avoid duplicates
    sqlx::query(
        "DELETE FROM user_profiles WHERE owner = ? AND type = ? AND main_req_hash = 's3'"
    )
    .bind(owner)
    .bind(file_type)
    .execute(pool)
    .await?;

    let mut stored = 0usize;

    for it in items {
        let file_name = it.path.clone();
        let source = format!("s3://{}/{}", bucket, it.path);
        let cid_hex = hex::encode(it.ipfs_hash.as_bytes());
        let file_hash_hex = cid_hex.clone();

        let is_assigned = it.ipfs_hash != "pending";

        // Insert new record
        sqlx::query(
            "INSERT INTO user_profiles (
                file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, 
                main_req_hash, selected_validator, total_replicas, block_number, profile_cid, 
                source, miner_ids, type, is_folder, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        .bind(chrono::DateTime::parse_from_rfc3339(&it.last_modified)
            .unwrap_or_else(|_| chrono::Utc::now().into())
            .timestamp() as i64)
        .execute(pool)
        .await?;
        stored += 1;
    }

    Ok(stored)
}

// New: Non-destructive insert that only adds missing items for this owner/scope
pub async fn insert_bucket_items_if_absent(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    items: &[BucketItem],
) -> Result<usize, sqlx::Error> {
    let file_type = if scope == "public" { "public" } else { "private" };
    let bucket = format!("{}-{}", owner, file_type);

    let mut stored = 0usize;

    for it in items {
        let file_name = it.path.clone();
        let exists: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM user_profiles WHERE owner = ? AND type = ? AND main_req_hash = 's3' AND file_name = ? LIMIT 1"
        )
        .bind(owner)
        .bind(file_type)
        .bind(&file_name)
        .fetch_optional(pool)
        .await?;

        if exists.is_none() {
            let source = format!("s3://{}/{}", bucket, it.path);
            let cid_hex = hex::encode(it.ipfs_hash.as_bytes());
            let file_hash_hex = cid_hex.clone();

            sqlx::query(
                "INSERT INTO user_profiles (
                    file_name, owner, cid, file_hash, file_size_in_bytes, is_assigned, last_charged_at, main_req_hash, selected_validator, total_replicas, block_number, profile_cid, source, miner_ids, type, is_folder, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
                .timestamp() as i64)
            .execute(pool)
            .await?;

            stored += 1;
        }
    }
    println!("[InsertBucketItemsIfAbsent] Inserted {} items for {} {}", stored, owner, scope);
    Ok(stored)
}

// Convenience: single-item variant
pub async fn insert_bucket_item_if_absent(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    item: &BucketItem,
) -> Result<bool, sqlx::Error> {
    let added = insert_bucket_items_if_absent(pool, owner, scope, std::slice::from_ref(item)).await?;
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
    let file_type = if scope == "public" { "public" } else { "private" };
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

