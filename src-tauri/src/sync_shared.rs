use std::sync::{Arc, Mutex};
use std::collections::{HashSet, VecDeque};
use tauri::{AppHandle, Wry};
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse}; 
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::Path; 
use std::path::PathBuf;
use std::fs;
use std::process::Command;
use serde::Serialize;
use sqlx::SqlitePool;
use hex;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use chrono::{DateTime, Utc};
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
    println!("[get_sync_activity] Found {} recent items, {} uploading for account {}", 
        recent.len(), uploading.len(), account_id);
        
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

// Helper to collect all subfolders
pub fn collect_folders_recursively(dir: &Path, folders: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') {
                continue; // Skip hidden files and directories
            }
        }
        if path.is_dir() {
            folders.push(path.clone());
            collect_folders_recursively(&path, folders)?;
        }
    }
    Ok(())
}

// Helper to collect files in a single folder (non-recursive)
pub fn collect_files_in_folder(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.starts_with('.') {
                continue; // Skip hidden files and directories
            }
        }
        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                if file_name.starts_with('.') {
                    continue; // Skip hidden files
                }
            }
            files.push(path);
        }
    }
    Ok(())
}

// Helper function to collect files with their relative paths
pub fn collect_files_with_relative_paths(
    root: &Path,
    current: &Path,
    files: &mut Vec<(PathBuf, String)>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let relative_path = path.strip_prefix(root)
                .unwrap()
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or("")
                .to_string();
            files.push((path, relative_path));
        } else if path.is_dir() {
            collect_files_with_relative_paths(root, &path, files)?;
        }
    }
    Ok(())
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

pub fn find_top_level_folder(path: &Path, sync_path: &Path) -> Option<PathBuf> {
    // If the path is already a direct child of sync_path, return it
    if path.parent().map(|p| p == sync_path).unwrap_or(false) {
        return Some(path.to_path_buf());
    }
    
    // Otherwise walk up the tree to find the first child of sync_path
    let mut current = path;
    while let Some(parent) = current.parent() {
        if parent == sync_path {
            return Some(current.to_path_buf());
        }
        current = parent;
    }
    None
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

    let output = Command::new(&aws_binary_path)
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3")
        .arg("ls")
        .arg(format!("s3://{}/", bucket_name))
        .arg("--endpoint-url")
        .arg(endpoint_url)
        .arg("--recursive")
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut root_files: Vec<BucketItem> = Vec::new();
                let mut folder_sizes: HashMap<String, u64> = HashMap::new();
                let mut folder_last_modified: HashMap<String, String> = HashMap::new();

                for line in stdout.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() < 4 {
                        continue;
                    }

                    let last_modified = format!("{} {}", parts[0], parts[1]);
                    let size_str = parts[2];
                    let path = parts[3..].join(" ");

                    if let Ok(size) = size_str.parse::<u64>() {
                        if let Some(slash_index) = path.find('/') {
                            // This is inside a folder.
                            let root_folder_name = path[..slash_index].to_string();
                            *folder_sizes.entry(root_folder_name.clone()).or_insert(0) += size;
                            
                            // Keep the last modified date of the latest file in the folder as the folder's last modified date.
                            folder_last_modified.insert(root_folder_name, last_modified.clone());
                        } else {
                            // This is a root file.
                            root_files.push(BucketItem {
                                path,
                                size,
                                last_modified,
                                is_folder: false,
                            });
                        }
                    }
                }

                let mut root_folders: Vec<BucketItem> = folder_sizes.into_iter().map(|(path, size)| {
                    let last_modified = folder_last_modified.get(&path).cloned().unwrap_or_default();
                    BucketItem {
                        path,
                        size,
                        last_modified,
                        is_folder: true,
                    }
                }).collect();

                root_files.append(&mut root_folders);
                Ok(root_files)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!("[ListBucket] Failed to list bucket contents: {}", stderr);
                Err(format!("Failed to list bucket contents: {}", stderr))
            }
        }
        Err(e) => {
            eprintln!("[ListBucket] Failed to execute 'aws s3 ls' command: {}", e);
            Err(format!("Failed to execute aws command: {}", e))
        }
    }
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
        let cid_hex = hex::encode("s3".as_bytes());
        let file_hash_hex = cid_hex.clone();

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
        .bind(true)
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
            let cid_hex = hex::encode("s3".as_bytes());
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
            .bind(true)
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

//  Reconcile DB rows with the given root-level bucket items. Any DB row for this
// owner/scope (main_req_hash='s3') whose file_name is NOT present in items will be deleted.
pub async fn reconcile_bucket_root(
    pool: &SqlitePool,
    owner: &str,
    scope: &str,
    items: &[BucketItem],
) -> Result<u64, sqlx::Error> {
    let file_type = if scope == "public" { "public" } else { "private" };
    // Fetch current names
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT file_name FROM user_profiles WHERE owner = ? AND type = ? AND main_req_hash = 's3'",
    )
    .bind(owner)
    .bind(file_type)
    .fetch_all(pool)
    .await?;

    let existing: std::collections::HashSet<String> = rows.into_iter().map(|(n,)| n).collect();
    let wanted: std::collections::HashSet<String> = items.iter().map(|it| it.path.clone()).collect();

    // Compute names to delete: existing - wanted
    let to_delete: Vec<String> = existing.difference(&wanted).cloned().collect();
    if to_delete.is_empty() {
        return Ok(0);
    }

    // Delete in a transaction
    let mut tx = pool.begin().await?;
    let mut deleted: u64 = 0;
    for name in to_delete {
        let res = sqlx::query(
            "DELETE FROM user_profiles WHERE owner = ? AND type = ? AND file_name = ? AND main_req_hash = 's3'",
        )
        .bind(owner)
        .bind(file_type)
        .bind(&name)
        .execute(&mut *tx)
        .await?;
        deleted += res.rows_affected();
    }
    tx.commit().await?;
    Ok(deleted)
}
 
// Build a top-level BucketItem from an absolute local file path.
// Only the first path segment under sync_root is used as the S3 "path" field, so
// children of an uploaded folder are coalesced into the folder entry.
pub fn bucket_item_from_local(abs_local: &Path, sync_root: &Path) -> Option<BucketItem> {
    let rel = abs_local.strip_prefix(sync_root).ok()?;
    let mut comps = rel.components();
    let first = comps.next()?; // top-level component under sync root
    let first_str = first.as_os_str().to_string_lossy().to_string();
    // If there are remaining components after the first, we treat it as a folder upload
    // and only store the top folder once.
    let is_folder = comps.next().is_some();

    let (size, last_modified) = if is_folder {
        (0, Utc::now().to_rfc3339())
    } else {
        let metadata = std::fs::metadata(abs_local).ok()?;
        let modified = metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| DateTime::from_timestamp(d.as_secs() as i64, 0).unwrap_or_else(Utc::now))
            .unwrap_or_else(Utc::now)
            .to_rfc3339();
        (metadata.len(), modified)
    };

    Some(BucketItem {
        path: first_str,
        size,
        last_modified,
        is_folder,
    })
}