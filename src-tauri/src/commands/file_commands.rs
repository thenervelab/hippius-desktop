//! File operations on the local sync folder.
//!
//! These commands let the frontend add, remove, list, and export files
//! from the sync folder. The hcfs-client file watcher picks up changes
//! automatically and syncs them to the remote server.
//!
//! All path-accepting commands include traversal protection via `ensure_within()`.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tracing::{info, warn};

use crate::hcfs_drive::HCFS_DRIVES;
use crate::sync_shared::{SyncActivityItem, update_state};
use crate::utils::account_key::account_key;

/// Allow the given directory (recursively) in the Tauri asset protocol scope
/// so the frontend can display files via `asset://localhost/...` URLs.
///
/// The static scope in `tauri.conf.json` only covers `$HOME/.hippius/**` (drive
/// metadata). User-chosen sync folders live elsewhere, so we expand the scope
/// at runtime whenever a sync path is configured or loaded.
pub fn allow_asset_directory(app: &tauri::AppHandle, path: &str) {
    let dir = Path::new(path);
    if !dir.exists() {
        info!("Skipping asset scope for non-existent path: {}", path);
        return;
    }
    match app.asset_protocol_scope().allow_directory(dir, true) {
        Ok(()) => info!("Asset protocol scope allowed for: {}", path),
        Err(e) => warn!("Failed to allow asset scope for '{}': {}", path, e),
    }
}

/// Tauri command to explicitly allow a directory in the asset protocol scope.
/// Called by the frontend at startup for every known sync path.
#[tauri::command]
pub async fn allow_asset_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    allow_asset_directory(&app, &path);
    Ok(())
}

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: Option<u64>,
    /// Sync status: "synced", "pending", or "unknown"
    pub sync_status: String,
    /// Hex-encoded path_hash from the synced state (empty if not synced yet)
    pub arion_hash: String,
    /// Arion CID from storage backend (empty if not available)
    pub arion_cid: String,
    /// For folders: total number of files (not directories) recursively inside.
    /// For files: 0.
    pub file_count: u64,
    /// Server-side timestamp: when the file was first uploaded (Unix seconds).
    /// 0 when not available (file not yet synced).
    pub uploaded_at: i64,
    /// Server-side timestamp: when the file was last updated (Unix seconds).
    /// 0 when not available (file not yet synced).
    pub updated_at: i64,
}

/// Verify that `child` is contained within `parent` after canonicalization.
/// Prevents path traversal attacks via `../` in user-supplied file names.
fn ensure_within(parent: &Path, child: &Path) -> Result<PathBuf, String> {
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid sync path: {e}"))?;
    let canonical_child = child
        .canonicalize()
        .map_err(|e| format!("Path not found: {e}"))?;
    if !canonical_child.starts_with(&canonical_parent) {
        return Err("Path escapes sync folder".to_string());
    }
    Ok(canonical_child)
}

/// Add file to sync folder (Drive auto-syncs)
#[tauri::command]
pub async fn add_file(sync_path: String, file_path: String) -> Result<String, String> {
    let source = Path::new(&file_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err("Invalid file name".to_string());
    }

    let parent = Path::new(&sync_path);
    let dest = parent.join(&name);

    // Validate destination is within the sync folder BEFORE writing
    // (canonicalize parent only — dest doesn't exist yet)
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid sync path: {e}"))?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err("Path escapes sync folder".to_string());
    }

    tokio::fs::copy(source, &dest)
        .await
        .map_err(|e| format!("Copy failed: {e}"))?;

    Ok(name)
}

/// Add folder to sync folder
#[tauri::command]
pub async fn add_folder(sync_path: String, folder_path: String) -> Result<String, String> {
    let source = Path::new(&folder_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid folder name")?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err("Invalid folder name".to_string());
    }

    let parent = Path::new(&sync_path);
    let dest = parent.join(&name);

    // Validate destination is within the sync folder BEFORE writing
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid sync path: {e}"))?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err("Path escapes sync folder".to_string());
    }

    copy_dir_recursive(source, &dest, 0).await?;

    Ok(name)
}

/// Remove file/folder from sync folder.
///
/// When `label` is provided the deletion is recorded in the sync activity
/// ring buffer so the frontend can immediately filter it from recent files.
#[tauri::command]
pub async fn remove_file(
    sync_path: String,
    name: String,
    label: Option<String>,
) -> Result<(), String> {
    let parent = Path::new(&sync_path);
    let target = parent.join(&name);
    let target = ensure_within(parent, &target)?;

    // Grab size before deleting so the activity entry is meaningful.
    let size_bytes = if target.is_dir() {
        0
    } else {
        tokio::fs::metadata(&target)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    };

    if target.is_dir() {
        tokio::fs::remove_dir_all(&target)
            .await
            .map_err(|e| format!("Remove failed: {e}"))?;
    } else if target.exists() {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|e| format!("Remove failed: {e}"))?;
    }

    // Record "deleted" activity so recent-files filtering works immediately.
    if let Some(lbl) = label {
        update_state(&lbl, |state| {
            state.add_activity(SyncActivityItem {
                file_name: name.clone(),
                action: "deleted".to_string(),
                timestamp: chrono::Utc::now().timestamp(),
                size_bytes,
                label: lbl.clone(),
            });
        });
    }

    Ok(())
}

/// Sync info for a single file: path_hash (hex), optional Arion CID,
/// and server-side timestamps.
struct SyncedFileInfo {
    path_hash_hex: String,
    arion_cid: String,
    /// Unix timestamp when file was first uploaded (0 if unknown)
    uploaded_at: i64,
    /// Unix timestamp when file was last updated (0 if unknown)
    updated_at: i64,
}

/// Build a map of relative paths → sync info for files whose
/// `path_hash` appears in the drive's persisted `synced` tree.
/// Returns `None` when the drive isn't available (e.g. logged out)
/// so the caller can fall back to "unknown".
async fn synced_paths_for_label(label: &str) -> Option<HashMap<String, SyncedFileInfo>> {
    // Use try_lock to avoid blocking file listing while sync holds the lock.
    // When sync is in progress the lock is held for the entire network cycle;
    // returning None here lets list_sync_folder report "unknown" sync status
    // instead of hanging until sync completes.
    let Ok(guard) = HCFS_DRIVES.try_lock() else {
        return None;
    };
    let manager = guard.get(label)?;
    let state = manager.load_sync_state().ok()?;

    let mut paths = HashMap::new();
    for (hash, rel_path) in &state.path_index {
        if state.synced.files.contains_key(hash) {
            let arion_cid = state
                .remote_arion_hashes
                .get(hash)
                .cloned()
                .unwrap_or_default();
            let timestamps = state.remote_timestamps.get(hash);
            paths.insert(
                rel_path.to_string_lossy().to_string(),
                SyncedFileInfo {
                    path_hash_hex: hex::encode(hash),
                    arion_cid,
                    uploaded_at: timestamps.map_or(0, |t| t.created_at),
                    updated_at: timestamps.map_or(0, |t| t.updated_at),
                },
            );
        }
    }
    Some(paths)
}

/// Recursively compute the total size of all files within a directory.
/// Hidden files (starting with '.') are excluded to match listing behaviour.
async fn dir_size_recursive(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let Ok(mut dir) = tokio::fs::read_dir(path).await else {
        return 0;
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_dir() {
            total += Box::pin(dir_size_recursive(&entry.path())).await;
        } else {
            total += meta.len();
        }
    }
    total
}

/// Recursively count the total number of files (not directories) within a directory.
/// Hidden files (starting with '.') are excluded to match listing behaviour.
async fn dir_file_count_recursive(path: &Path) -> u64 {
    let mut count: u64 = 0;
    let Ok(mut dir) = tokio::fs::read_dir(path).await else {
        return 0;
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_dir() {
            count += Box::pin(dir_file_count_recursive(&entry.path())).await;
        } else {
            count += 1;
        }
    }
    count
}

/// List contents of sync folder
#[tauri::command]
pub async fn list_sync_folder(
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    let base = PathBuf::from(&sync_path);
    let target = match subfolder {
        Some(ref sub) => base.join(sub),
        None => base.clone(),
    };

    // Return empty list if directory doesn't exist yet (e.g. sync still initializing after login)
    if !target.exists() {
        return Ok(Vec::new());
    }

    // Validate subfolder stays within sync_path
    if subfolder.is_some() {
        ensure_within(&base, &target)?;
    }

    // Load synced file paths from the drive's persisted sync state
    let synced_set = match label {
        Some(ref l) => synced_paths_for_label(l).await,
        None => None,
    };

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| format!("Read dir failed: {e}"))?;

    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip .hippius config directory and hidden files
        if name.starts_with('.') {
            continue;
        }

        let meta = entry.metadata().await.map_err(|e| e.to_string())?;
        let is_folder = meta.is_dir();

        // Remove and skip failed download artifacts (`downloaded_<hex>`) and
        // 0-byte encrypted-name stubs (`file_<hex>`) left by decryption
        // failures. Deleting on sight closes the gap between sync cycles
        // where post-sync cleanup hasn't run yet.
        if !is_folder {
            if crate::sync_logic::is_failed_download_artifact(&name).is_some() {
                let path = entry.path();
                info!(artifact = %name, "Removing failed download artifact on list");
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
            if crate::sync_logic::is_encrypted_name_stub(&name).is_some()
                && meta.len() == 0
            {
                let path = entry.path();
                info!(stub = %name, "Removing 0-byte encrypted-name stub on list");
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
        }

        // Build relative path matching hcfs-client convention:
        // BLAKE3 is computed over relative_path.to_string_lossy()
        let relative_path = match subfolder {
            Some(ref sub) => format!("{}/{}", sub, name),
            None => name.clone(),
        };

        // Folders don't have server-side entries — their children do
        let (sync_status, info) = if is_folder {
            ("synced", None)
        } else {
            match &synced_set {
                Some(map) => match map.get(&relative_path) {
                    Some(i) => ("synced", Some(i)),
                    None => ("pending", None),
                },
                None => ("unknown", None),
            }
        };

        let size = if is_folder {
            dir_size_recursive(&target.join(&name)).await
        } else {
            meta.len()
        };

        let file_count = if is_folder {
            dir_file_count_recursive(&target.join(&name)).await
        } else {
            0
        };

        entries.push(FileEntry {
            name,
            is_folder,
            size,
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            sync_status: sync_status.to_string(),
            arion_hash: info.map_or_else(String::new, |i| i.path_hash_hex.clone()),
            arion_cid: info.map_or_else(String::new, |i| i.arion_cid.clone()),
            file_count,
            uploaded_at: info.map_or(0, |i| i.uploaded_at),
            updated_at: info.map_or(0, |i| i.updated_at),
        });
    }

    Ok(entries)
}

/// Export file or folder from sync folder to arbitrary location
#[tauri::command]
pub async fn export_file(
    sync_path: String,
    file_name: String,
    output_path: String,
) -> Result<(), String> {
    let parent = Path::new(&sync_path);
    let source = parent.join(&file_name);
    let source = ensure_within(parent, &source)?;

    if source.is_dir() {
        copy_dir_recursive(&source, Path::new(&output_path), 0).await?;
    } else {
        tokio::fs::copy(&source, &output_path)
            .await
            .map_err(|e| format!("Export failed: {e}"))?;
    }
    Ok(())
}

/// Resolve the local file system path for a file given its label and name.
///
/// Looks up the sync folder path from the database for the specified label
/// and account, then combines it with the file name. Supports subfolder
/// paths (e.g., "subfolder/file.txt"). Returns an error if the sync path
/// is not configured or the file does not exist on disk.
#[tauri::command]
pub async fn resolve_file_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    label: String,
    file_name: String,
) -> Result<String, String> {
    // Reject path traversal attempts — slashes are allowed for subfolder access
    if file_name.contains("..") {
        return Err("Invalid file name".to_string());
    }

    let db = state.pool()?;
    let owner = account_key(&account_id);

    let result: Option<(String,)> =
        sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
            .bind(&owner)
            .bind(&label)
            .fetch_optional(db)
            .await
            .map_err(|e| format!("Failed to look up sync path: {e}"))?;

    let sync_path = result
        .map(|(p,)| p)
        .ok_or_else(|| format!("No sync path configured for label '{label}'"))?;

    let full_path = Path::new(&sync_path).join(&file_name);

    // Validate the resolved path stays within the sync folder
    let canonical_parent = Path::new(&sync_path)
        .canonicalize()
        .map_err(|e| format!("Invalid sync path: {e}"))?;
    let canonical_file = full_path
        .canonicalize()
        .map_err(|_| format!("File not found: {file_name}"))?;
    if !canonical_file.starts_with(&canonical_parent) {
        return Err("Path escapes sync folder".to_string());
    }

    Ok(canonical_file.to_string_lossy().to_string())
}

/// Maximum recursion depth for directory copies to prevent symlink loops
const MAX_COPY_DEPTH: u32 = 64;

async fn copy_dir_recursive(src: &Path, dst: &Path, depth: u32) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err(format!(
            "Directory nesting exceeds maximum depth ({MAX_COPY_DEPTH})"
        ));
    }

    tokio::fs::create_dir_all(dst)
        .await
        .map_err(|e| e.to_string())?;
    let mut dir = tokio::fs::read_dir(src).await.map_err(|e| e.to_string())?;
    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        // Use symlink_metadata to detect symlinks without following them
        let meta = tokio::fs::symlink_metadata(&src_path)
            .await
            .map_err(|e| e.to_string())?;

        // Skip symlinks to prevent traversal loops and escaping the source tree
        if meta.is_symlink() {
            continue;
        }

        if meta.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path, depth + 1)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
