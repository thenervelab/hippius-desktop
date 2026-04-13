//! File operations on the local sync folder.
//!
//! These commands let the frontend add, remove, list, and export files
//! from the sync folder. The hcfs-client file watcher picks up changes
//! automatically and syncs them to the remote server.
//!
//! All path-accepting commands include traversal protection via `ensure_within()`.

use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::auth::account_key::account_key;
use crate::error::Result;
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::{SyncRunner, trigger_sync};
use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem};

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
pub async fn allow_asset_scope(app: tauri::AppHandle, path: String) -> Result<()> {
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
/// Delegates to hcfs-client library.
fn ensure_within(parent: &Path, child: &Path) -> Result<PathBuf> {
    hcfs_client::drive::files::ensure_within(parent, child).map_err(|e| crate::error::AppError::Other(e.to_string()))
}

/// Pure file-copy implementation, no eligibility check. The check is
/// performed at the IPC boundary by `add_file` (single-file path) or
/// `add_files` (batch path), and the inner helper is called from both
/// without re-checking — see the call sites for the rationale.
async fn add_file_internal(sync_path: String, file_path: String) -> Result<String> {
    let source = Path::new(&file_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Other("Invalid file name".into()))?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Other("Invalid file name".into()));
    }

    let parent = Path::new(&sync_path);
    let dest = parent.join(&name);

    // Validate destination is within the sync folder BEFORE writing
    // (canonicalize parent only — dest doesn't exist yet)
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    tokio::fs::copy(source, &dest)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Copy failed: {e}")))?;

    Ok(name)
}

/// Add file to sync folder (Drive auto-syncs)
#[tauri::command]
pub async fn add_file(state: tauri::State<'_, crate::app_state::AppState>, sync_path: String, file_path: String) -> Result<String> {
    // Enforce credit eligibility at the IPC boundary. Even if a stale
    // FE cache let the user click the upload button, this fails the
    // operation here so we never copy the file into the sync folder
    // (and thus never trigger an upload that would silently fail
    // server-side for billing reasons).
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    crate::billing::eligibility::require_eligible(&state, &account_id, crate::billing::eligibility::InsufficientCreditsAction::FileUpload).await?;

    add_file_internal(sync_path, file_path).await
}

/// Add folder to sync folder
#[tauri::command]
pub async fn add_folder(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    folder_path: String,
    subfolder: Option<String>,
) -> Result<String> {
    // Enforce credit eligibility at the IPC boundary — same rationale
    // as `add_file`.
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    crate::billing::eligibility::require_eligible(&state, &account_id, crate::billing::eligibility::InsufficientCreditsAction::FolderUpload).await?;

    let source = Path::new(&folder_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Other("Invalid folder name".into()))?
        .to_string();

    // Reject names containing path separators or traversal components
    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Other("Invalid folder name".into()));
    }

    // Resolve target directory (with optional subfolder)
    let sync_root = Path::new(&sync_path);
    let target_dir = if let Some(ref sub) = subfolder {
        // Reject traversal components before creating directories
        if sub.contains("..") {
            return Err(crate::error::AppError::Other("Subfolder path contains traversal component".into()));
        }
        let t = sync_root.join(sub);
        if !t.exists() {
            std::fs::create_dir_all(&t).map_err(|e| crate::error::AppError::Other(format!("Failed to create subfolder: {e}")))?;
        }
        // Verify resolved path is within sync root
        let canonical_root = sync_root
            .canonicalize()
            .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
        let canonical_target = t
            .canonicalize()
            .map_err(|e| crate::error::AppError::Other(format!("Invalid subfolder path: {e}")))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(crate::error::AppError::Other("Subfolder escapes sync folder".into()));
        }
        t
    } else {
        sync_root.to_path_buf()
    };

    let dest = target_dir.join(&name);

    // Validate destination is within the sync folder BEFORE writing
    let canonical_parent = target_dir
        .canonicalize()
        .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    copy_dir_recursive(source, &dest, 0).await?;

    // Trigger sync so the uploaded folder gets synced
    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>().sync.clone();
        let _ = trigger_sync(&s).await;
    }

    Ok(name)
}

/// Internal folder copy — no sync trigger (caller handles it).
async fn add_folder_internal(sync_path: &str, folder_path: &str) -> Result<String> {
    let source = Path::new(folder_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Other("Invalid folder name".into()))?
        .to_string();

    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Other("Invalid folder name".into()));
    }

    let parent = Path::new(sync_path);
    let dest = parent.join(&name);

    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    copy_dir_recursive(source, &dest, 0).await?;
    Ok(name)
}

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

/// Request to delete a single file, used by the `delete_files` batch command.
#[derive(Deserialize)]
pub struct FileDeleteRequest {
    pub name: String,
    pub source: Option<String>,
    pub label: Option<String>,
    pub size: u64,
}

/// Per-file error from a batch delete.
#[derive(Serialize)]
pub struct FileDeleteError {
    pub name: String,
    pub error: String,
}

/// Result of a batch file deletion.
#[derive(Serialize)]
pub struct DeleteFilesResult {
    pub deleted: u32,
    pub failed: Vec<FileDeleteError>,
}

/// Delete multiple files in one call, resolving paths internally.
///
/// For each file: resolves sync_path + relative_name via label/source,
/// calls the existing `remove_file` logic, and aggregates results.
/// Triggers sync once at the end. Replaces the per-file loop that was
/// in `use-delete-file/index.tsx`.
#[tauri::command]
pub async fn delete_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: AppHandle,
    account_id: String,
    files: Vec<FileDeleteRequest>,
) -> Result<DeleteFilesResult> {
    let pool = state.pool()?;
    let mut deleted = 0u32;
    let mut failed = Vec::new();

    for file in &files {
        let effective_label = file.label.as_deref().unwrap_or("default");
        let sync_path = match crate::sync::config::get_sync_path_for_label(pool, &account_id, effective_label).await {
            Ok(p) => p,
            Err(_) if effective_label != "default" => crate::sync::config::get_sync_path_for_label(pool, &account_id, "default")
                .await
                .unwrap_or_default(),
            Err(_) => String::new(),
        };

        let relative_name = derive_relative_name(&sync_path, file.source.as_deref(), &file.name);

        let parent = Path::new(&sync_path);
        let target = parent.join(&relative_name);
        match ensure_within(parent, &target) {
            Ok(target) => {
                let size_bytes = if target.is_dir() {
                    0
                } else {
                    tokio::fs::metadata(&target).await.map(|m| m.len()).unwrap_or(0)
                };

                let remove_result = if target.is_dir() {
                    tokio::fs::remove_dir_all(&target).await
                } else if target.exists() {
                    tokio::fs::remove_file(&target).await
                } else {
                    Ok(())
                };

                match remove_result {
                    Ok(()) => {
                        if let Some(lbl) = &file.label {
                            state.sync.update_state(lbl, |st| {
                                st.add_activity(SyncActivityItem {
                                    file_name: std::sync::Arc::from(relative_name.as_str()),
                                    action: SyncActivityAction::Deleted,
                                    timestamp: chrono::Utc::now().timestamp(),
                                    size_bytes,
                                    label: std::sync::Arc::from(lbl.as_str()),
                                });
                            });
                        }
                        deleted += 1;
                    }
                    Err(e) => {
                        warn!(file = %file.name, error = %e, "Failed to delete file");
                        failed.push(FileDeleteError {
                            name: file.name.clone(),
                            error: e.to_string(),
                        });
                    }
                }
            }
            Err(e) => {
                failed.push(FileDeleteError {
                    name: file.name.clone(),
                    error: e.to_string(),
                });
            }
        }
    }

    // Trigger sync so server picks up the deletions
    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>().sync.clone();
        let _ = trigger_sync(&s).await;
    }

    info!(deleted, failed = failed.len(), "Batch delete completed");
    Ok(DeleteFilesResult { deleted, failed })
}

/// Add multiple files to the sync folder in one call.
///
/// Copies each file into `sync_path` and triggers sync once at the end.
/// Add multiple files/folders to the sync folder. Collects errors instead
/// of aborting on the first failure. Always triggers sync at the end so
/// successfully added files get uploaded even if some failed.
#[derive(Serialize)]
pub struct AddFilesResult {
    pub added: Vec<String>,
    pub failed: Vec<FileDeleteError>,
}

/// Batch file/folder add operation. Used by both the loose multi-file
/// upload path (`useFilesUpload::upload` — drag/drop, multi-select) and
/// the folder-upload path (`UploadFilesFlow::uploadFilesFolder`).
///
/// The `for_folder` parameter classifies the batch so the credit
/// eligibility check uses the right action. FE callers MUST set it
/// correctly:
///
/// - `false` for loose multi-file uploads → `FileUpload` action
/// - `true` for folder uploads (the entire folder is one billable
///   unit) → `FolderUpload` action
///
/// The thresholds for both actions are identical today (`> 0`), but
/// pricing for folder uploads can diverge in the future and the gate
/// would silently use the wrong threshold if the FE classified
/// incorrectly.
#[tauri::command]
pub async fn add_files(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    file_paths: Vec<String>,
    subfolder: Option<String>,
    for_folder: bool,
) -> Result<AddFilesResult> {
    // Enforce credit eligibility once for the whole batch at the IPC
    // boundary. The per-file `add_file_internal` calls inside the loop
    // below do NOT re-check — there's no point hammering the billing
    // API once per file when the batch is treated as a single unit.
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    let action = if for_folder {
        crate::billing::eligibility::InsufficientCreditsAction::FolderUpload
    } else {
        crate::billing::eligibility::InsufficientCreditsAction::FileUpload
    };
    crate::billing::eligibility::require_eligible(&state, &account_id, action).await?;

    // When a subfolder is specified, resolve the effective target directory.
    // This replaces the path-join logic that was previously in TypeScript.
    let target_path = if let Some(ref sub) = subfolder {
        // Reject traversal components
        if sub.contains("..") {
            return Err(crate::error::AppError::Other("Subfolder path contains traversal component".into()));
        }
        let target = Path::new(&sync_path).join(sub);
        if !target.exists() {
            std::fs::create_dir_all(&target).map_err(|e| crate::error::AppError::Other(format!("Failed to create subfolder: {e}")))?;
        }
        // Verify resolved path stays within sync root
        let canonical_root = Path::new(&sync_path)
            .canonicalize()
            .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
        let canonical_target = target
            .canonicalize()
            .map_err(|e| crate::error::AppError::Other(format!("Invalid subfolder path: {e}")))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(crate::error::AppError::Other("Subfolder escapes sync folder".into()));
        }
        target.to_string_lossy().to_string()
    } else {
        sync_path.clone()
    };

    let mut added = Vec::new();
    let mut failed = Vec::new();

    let total = file_paths.len();
    for (i, file_path) in file_paths.iter().enumerate() {
        let source = Path::new(file_path);
        let result = if source.is_dir() {
            // Pass app handle but no subfolder — subfolder already resolved into target_path.
            // Don't trigger sync per-folder — add_files triggers once at the end.
            add_folder_internal(&target_path, file_path).await
        } else {
            // Use the internal helper that skips the per-file eligibility
            // check — the batch eligibility check at the top of `add_files`
            // covers the whole operation.
            add_file_internal(target_path.clone(), file_path.clone()).await
        };
        match result {
            Ok(name) => added.push(name),
            Err(e) => {
                let name = source.file_name().map_or_else(|| file_path.clone(), |n| n.to_string_lossy().to_string());
                warn!(file = %name, error = %e, "Failed to add file");
                failed.push(FileDeleteError { name, error: e.to_string() });
            }
        }
        let _ = app.emit(
            "add_files_progress",
            serde_json::json!({
                "completed": i + 1,
                "total": total,
            }),
        );
    }

    // Always trigger sync so successfully added files get uploaded
    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>().sync.clone();
        let _ = trigger_sync(&s).await;
    }

    info!(added = added.len(), failed = failed.len(), "Batch add completed");
    Ok(AddFilesResult { added, failed })
}

use hcfs_client::engine::types::{SyncedFileInfo, build_synced_paths_from_state};

/// Build a map of relative paths → sync info for files whose
/// `path_hash` appears in the drive's persisted `synced` tree.
/// Returns `None` when the drive isn't available (e.g. logged out)
/// so the caller can fall back to "unknown".
///
/// Tries the live drive lock first (non-blocking). On success the cache
/// is also refreshed. When the lock is unavailable (sync in progress),
/// falls back to the last cached snapshot so the file browser still
/// shows accurate sync status instead of "unknown".
async fn synced_paths_for_label(sync: &SyncRunner, label: &str) -> Option<HashMap<String, SyncedFileInfo>> {
    // Get the per-drive Arc from the map (brief outer lock).
    let drive_arc = {
        match sync.drives.try_lock() {
            Ok(guard) => guard.get(label).map(|slot| slot.manager.clone()),
            Err(_) => return sync.get_cached_synced_paths(label),
        }
    };
    let Some(arc) = drive_arc else {
        return sync.get_cached_synced_paths(label);
    };
    // Try to lock the per-drive mutex; fall back to cache if syncing.
    match arc.try_lock() {
        Ok(manager) => {
            let state = manager.load_sync_state().await.ok()?;
            let paths = build_synced_paths_from_state(&state);
            sync.update_synced_paths_cache(label, paths.clone());
            Some(paths)
        }
        Err(_) => sync.get_cached_synced_paths(label),
    }
}

/// Sync metadata for a single file, returned by `get_synced_file_metadata`.
#[derive(Serialize)]
pub struct SyncedFileMetadata {
    /// File name (basename only, e.g. "photo.jpg")
    pub file_name: String,
    /// Relative path from sync root (e.g. "subfolder/photo.jpg")
    pub relative_path: String,
    /// Drive label this file belongs to
    pub label: String,
    /// Hex-encoded BLAKE3 path hash
    pub arion_hash: String,
    /// Arion CID from storage backend (empty if not available)
    pub arion_cid: String,
    /// Unix timestamp when file was first uploaded (0 if unknown)
    pub uploaded_at: i64,
    /// Unix timestamp when file was last updated (0 if unknown)
    pub updated_at: i64,
}

/// Return sync metadata (arion hashes, CIDs, timestamps) for all synced
/// files across all drives. Used internally by `get_user_files` to look
/// up arion hashes without needing to list every subfolder from disk.
pub async fn get_synced_file_metadata(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Vec<SyncedFileMetadata>> {
    let sync = &state.sync;
    let mut result = Vec::new();

    // Collect labels + cached paths in one pass
    let label_maps: Vec<(String, HashMap<String, SyncedFileInfo>)> = {
        let drive_arcs: Vec<(String, std::sync::Arc<tokio::sync::Mutex<DriveManager>>)> = {
            match sync.drives.try_lock() {
                Ok(guard) => guard.iter().map(|(k, slot)| (k.clone(), slot.manager.clone())).collect(),
                Err(_) => Vec::new(),
            }
        };
        if drive_arcs.is_empty() {
            // All locks held by sync — use cached data
            if let Ok(cache) = sync.synced_paths_cache.lock() {
                cache.iter().map(|(l, m)| (l.clone(), m.clone())).collect()
            } else {
                Vec::new()
            }
        } else {
            let mut out = Vec::new();
            for (label, arc) in &drive_arcs {
                if let Ok(manager) = arc.try_lock() {
                    if let Ok(st) = manager.load_sync_state().await {
                        let paths = build_synced_paths_from_state(&st);
                        sync.update_synced_paths_cache(label, paths.clone());
                        out.push((label.clone(), paths));
                    }
                } else if let Some(cached) = sync.get_cached_synced_paths(label) {
                    // Drive is syncing — fall back to cached snapshot so
                    // arion hashes remain visible while downloads are active.
                    out.push((label.clone(), cached));
                }
            }
            out
        }
    };

    for (label, paths) in label_maps {
        for (rel_path, info) in &paths {
            // Use the full relative path so lookups match activity items
            // that also use relative paths (e.g. "bucket/photo.jpg").
            result.push(SyncedFileMetadata {
                file_name: rel_path.clone(),
                relative_path: rel_path.clone(),
                label: label.clone(),
                arion_hash: info.path_hash_hex(),
                arion_cid: info.arion_cid.to_string(),
                uploaded_at: info.uploaded_at,
                updated_at: info.updated_at,
            });
        }
    }

    Ok(result)
}

/// A recent file ready for UI rendering. Matches the frontend `FormattedUserFile`
/// shape so the hook can pass it through without transformation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub actual_file_name: String,
    pub size: u64,
    pub created_at: i64,
    pub arion_hash: String,
    pub arion_cid: String,
    pub source: String,
    pub miner_ids: Vec<String>,
    pub is_assigned: bool,
    pub last_charged_at: i64,
    pub file_hash: String,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub file_type: String,
    pub is_erasure_coded: bool,
    pub main_req_hash: String,
    pub label: String,
}

/// Bundled per-file metadata from synced paths, used to enrich recent file entries.
/// Keyed by `"filename::label"` in the lookup map.
struct MetadataBundle {
    arion_hash: String,
    arion_cid: String,
    uploaded_at: i64,
    updated_at: i64,
}

/// Fetch recent files by joining sync activity, sync paths, and file metadata.
///
/// This replaces the 130-line orchestration in `use-recent-files/index.ts`.
/// All data joining, filtering, deduplication, and sorting happens in Rust.
#[tauri::command]
pub async fn get_recent_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    limit: Option<usize>,
) -> Result<Vec<RecentFile>> {
    let sync = &state.sync;
    let pool = state.pool()?;

    // 1. Get sync activity items
    let items = sync.get_sync_activity(limit, None);
    if items.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Get sync paths → build label→path lookup
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id)
        .await
        .unwrap_or_default();
    let label_to_path: HashMap<String, String> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty() && !sp.label.is_empty())
        .map(|sp| (sp.label.clone(), sp.path.clone()))
        .collect();

    // 3. Get synced file metadata → build lookup map
    let metadata = get_synced_file_metadata(state.clone()).await.unwrap_or_default();
    let mut meta_map: HashMap<String, MetadataBundle> = HashMap::with_capacity(metadata.len());
    for entry in &metadata {
        let key = format!("{}::{}", entry.file_name, entry.label);
        meta_map.insert(
            key,
            MetadataBundle {
                arion_hash: entry.arion_hash.clone(),
                arion_cid: entry.arion_cid.clone(),
                uploaded_at: entry.uploaded_at,
                updated_at: entry.updated_at,
            },
        );
    }

    // 4. Filter deleted files
    let deleted_names: std::collections::HashSet<String> = items
        .iter()
        .filter(|item| item.action == SyncActivityAction::Deleted)
        .map(|item| format!("{}::{}", item.file_name, item.label))
        .collect();

    let non_deleted: Vec<_> = items
        .iter()
        .filter(|item| item.action != SyncActivityAction::Deleted && !deleted_names.contains(&format!("{}::{}", item.file_name, item.label)))
        .collect();

    if non_deleted.is_empty() {
        return Ok(Vec::new());
    }

    // 5. Map to RecentFile with path resolution and timestamp priority
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for item in &non_deleted {
        // Deduplicate by actualFileName + label (reuse key for meta_map lookup)
        let key = format!("{}::{}", item.file_name, item.label);
        if !seen.insert(key.clone()) {
            continue;
        }

        let sync_folder_path = label_to_path.get(item.label.as_ref());
        let source = match sync_folder_path {
            Some(path) if !item.file_name.is_empty() => format!("{path}/{}", item.file_name),
            _ => String::new(),
        };
        let display_name = item.file_name.rsplit('/').next().unwrap_or(&item.file_name).to_string();
        let display_name = if display_name.is_empty() { "Unknown".to_string() } else { display_name };

        let bundle = meta_map.remove(&key);
        let (arion_hash, arion_cid, uploaded_at_sec, updated_at_sec) = match bundle {
            Some(b) => (b.arion_hash, b.arion_cid, b.uploaded_at, b.updated_at),
            None => (String::new(), String::new(), 0, 0),
        };

        let activity_ms = if item.timestamp != 0 { item.timestamp * 1000 } else { now_ms };
        let created_at_ms = if uploaded_at_sec != 0 { uploaded_at_sec * 1000 } else { activity_ms };
        let last_charged_at_ms = if updated_at_sec != 0 {
            updated_at_sec * 1000
        } else if uploaded_at_sec != 0 {
            uploaded_at_sec * 1000
        } else {
            activity_ms
        };

        let file_type = {
            let mut chars = item.action.as_str().chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        };

        result.push(RecentFile {
            name: display_name,
            actual_file_name: item.file_name.to_string(),
            size: item.size_bytes,
            created_at: created_at_ms,
            arion_hash,
            arion_cid,
            source,
            miner_ids: Vec::new(),
            is_assigned: true,
            last_charged_at: last_charged_at_ms,
            file_hash: String::new(),
            is_folder: false,
            file_type,
            is_erasure_coded: false,
            main_req_hash: String::new(),
            label: item.label.to_string(),
        });
    }

    // 6. Sort by timestamp (newest first)
    result.sort_by(|a, b| b.last_charged_at.cmp(&a.last_charged_at));

    Ok(result)
}

/// Recursively compute total size and file count within a directory.
/// Hidden files (starting with '.') are excluded.
async fn dir_stats_recursive(path: &Path) -> (u64, u64) {
    let mut size: u64 = 0;
    let mut count: u64 = 0;
    let Ok(mut dir) = tokio::fs::read_dir(path).await else {
        return (0, 0);
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_dir() {
            let (sub_size, sub_count) = Box::pin(dir_stats_recursive(&entry.path())).await;
            size += sub_size;
            count += sub_count;
        } else {
            size += meta.len();
            count += 1;
        }
    }
    (size, count)
}

/// List contents of sync folder
#[tauri::command]
#[expect(clippy::too_many_lines, reason = "1 line over; extracting hurts readability")]
pub async fn list_sync_folder(
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<Vec<FileEntry>> {
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
        Some(ref l) => synced_paths_for_label(&state.sync, l).await,
        None => None,
    };

    // Load exclusion patterns so excluded files aren't shown as "pending"
    let excluded_patterns: Vec<String> = match label {
        Some(ref l) => {
            let drive_arc = {
                let guard = state.sync.drives.lock().await;
                guard.get(l).map(|slot| slot.manager.clone())
            };
            if let Some(arc) = drive_arc {
                if let Ok(m) = arc.try_lock() {
                    m.list_exclude_patterns()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        }
        None => Vec::new(),
    };

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Read dir failed: {e}")))?;

    while let Some(entry) = dir.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip .hippius config directory and hidden files
        if name.starts_with('.') {
            continue;
        }

        let meta = entry.metadata().await?;
        let is_folder = meta.is_dir();

        // Remove and skip failed download artifacts (`downloaded_<hex>`) and
        // 0-byte encrypted-name stubs (`file_<hex>`) left by decryption
        // failures. Deleting on sight closes the gap between sync cycles
        // where post-sync cleanup hasn't run yet.
        if !is_folder {
            if hcfs_client::engine::classify::is_failed_download_artifact(&name).is_some() {
                let path = entry.path();
                info!(artifact = %name, "Removing failed download artifact on list");
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
            if hcfs_client::engine::classify::is_encrypted_name_stub(&name).is_some() && meta.len() == 0 {
                let path = entry.path();
                info!(stub = %name, "Removing 0-byte encrypted-name stub on list");
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
        }

        // Build relative path matching hcfs-client convention:
        // BLAKE3 is computed over relative_path.to_string_lossy()
        let relative_path = match subfolder {
            Some(ref sub) => format!("{sub}/{name}"),
            None => name.clone(),
        };

        // Folders don't have server-side entries — their children do
        let is_excluded = !excluded_patterns.is_empty() && excluded_patterns.iter().any(|p| p == &relative_path);
        let (sync_status, info) = if is_excluded {
            ("excluded", None)
        } else if is_folder {
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

        let (size, file_count) = if is_folder {
            dir_stats_recursive(&target.join(&name)).await
        } else {
            (meta.len(), 0)
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
            arion_hash: info.map_or_else(String::new, hcfs_client::engine::types::SyncedFileInfo::path_hash_hex),
            arion_cid: info.map_or_else(String::new, |i| i.arion_cid.to_string()),
            file_count,
            uploaded_at: info.map_or(0, |i| i.uploaded_at),
            updated_at: info.map_or(0, |i| i.updated_at),
        });
    }

    Ok(entries)
}

/// Filter criteria for the files page, matching the frontend `FilterCriteria`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilterCriteria {
    pub search_term: Option<String>,
    pub file_types: Option<Vec<String>>,
    pub date_filter: Option<String>,
    pub file_sizes: Option<Vec<u64>>,
    pub folder_tab: Option<String>,
}

impl FileFilterCriteria {
    /// `true` when every filter field is empty — short-circuits the
    /// `filter_file_entries` IPC so callers don't pay the round-trip
    /// serialization cost for a no-op.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.search_term.as_deref().is_none_or(str::is_empty)
            && self.file_types.as_ref().is_none_or(std::vec::Vec::is_empty)
            && self.date_filter.as_deref().is_none_or(str::is_empty)
            && self.file_sizes.as_ref().is_none_or(std::vec::Vec::is_empty)
            && self.folder_tab.is_none()
    }
}

/// Result of get_user_files including both files and metadata.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFilesResult {
    pub files: Vec<UserFileEntry>,
    pub total_private_size: String,
    pub sync_folder_labels: Vec<String>,
}

/// A user file ready for UI rendering. Matches `FormattedUserFile` shape.
///
/// `Deserialize` is required so the frontend can pass a previously-fetched
/// list back into [`filter_file_entries`] for re-filtering without a round
/// trip to disk.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserFileEntry {
    pub name: String,
    pub actual_file_name: String,
    pub size: u64,
    pub created_at: i64,
    pub arion_hash: String,
    pub arion_cid: String,
    pub source: String,
    pub miner_ids: Vec<String>,
    pub is_assigned: bool,
    pub last_charged_at: i64,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub file_type: String,
    pub is_erasure_coded: bool,
    pub main_req_hash: String,
    pub sync_status: String,
    pub label: String,
    pub file_count: Option<u64>,
    pub deleted: bool,
}

/// Fetch all user files from all sync paths, apply filters, return UI-ready data.
///
/// Replaces both the `use-user-files` orchestration (multi-invoke loop with
/// timestamp logic) AND `fileFilterUtils.ts` (search, type, date, size filtering).
#[tauri::command]
#[expect(
    clippy::too_many_lines,
    reason = "Replaces two full frontend modules (use-user-files + fileFilterUtils) in one Rust function. The filter chain (search / type / date / size) must share the candidate list and statistics accumulators; splitting would require an iterator-builder pattern that obscures the filter order."
)]
pub async fn get_user_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    filters: Option<FileFilterCriteria>,
) -> Result<UserFilesResult> {
    let pool = state.pool()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id)
        .await
        .unwrap_or_default();

    let mut all_files: Vec<UserFileEntry> = Vec::new();
    let mut total_private_size: u64 = 0;
    let sync_folder_labels: Vec<String> = sync_paths.iter().filter(|sp| !sp.path.is_empty()).map(|sp| sp.label.clone()).collect();

    // List all sync folders concurrently
    let folder_futures: Vec<_> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty())
        .map(|sp| {
            let state = state.clone();
            let path = sp.path.clone();
            let label = sp.label.clone();
            async move {
                match list_sync_folder(state, path, None, Some(label.clone())).await {
                    Ok(entries) => (label, entries),
                    Err(err) => {
                        tracing::warn!(label = %label, error = %err, "Failed to list sync folder");
                        (label, Vec::new())
                    }
                }
            }
        })
        .collect();

    let results = futures::future::join_all(folder_futures).await;

    for (label, entries) in &results {
        total_private_size += entries.iter().map(|e| e.size).sum::<u64>();

        for entry in entries.iter().filter(|e| e.sync_status != "excluded") {
            let local_modified_ms = entry.modified.map_or(0, |m| m as i64 * 1000);
            let uploaded_at_ms = if entry.uploaded_at != 0 { entry.uploaded_at * 1000 } else { 0 };
            let updated_at_ms = if entry.updated_at != 0 { entry.updated_at * 1000 } else { 0 };
            // created_at represents "DATE UPLOADED" in the UI. For files,
            // only use the server-side uploaded_at timestamp — showing the
            // local mtime under "DATE UPLOADED" is confusing (the frontend
            // renders 0 as "—", the correct placeholder for not-yet-uploaded).
            // Folders (including .app bundles on macOS) have no server-side
            // timestamp, so fall back to local mtime for them.
            let created_at_ms = if uploaded_at_ms != 0 {
                uploaded_at_ms
            } else if entry.is_folder {
                local_modified_ms
            } else {
                0
            };
            // last_charged_at_ms is a billing timestamp -- only use
            // server-side values, never fall back to local mtime.
            let last_charged_at_ms = if updated_at_ms != 0 { updated_at_ms } else { uploaded_at_ms };

            // Detect encrypted file names (long hex strings or file_<hex> patterns)
            let display_name = if hcfs_client::engine::classify::is_encrypted_name_stub(&entry.name).is_some()
                || (entry.name.len() >= 16 && !entry.name.contains('.') && entry.name.chars().all(|c| c.is_ascii_hexdigit()))
            {
                "Encrypted file".to_string()
            } else {
                entry.name.clone()
            };

            // Find the sync path for this label to get the folder path
            let folder_path = sync_paths.iter().find(|sp| sp.label == *label).map_or("", |sp| sp.path.as_str());

            all_files.push(UserFileEntry {
                name: display_name,
                actual_file_name: entry.name.clone(),
                size: entry.size,
                created_at: created_at_ms,
                arion_hash: entry.arion_hash.clone(),
                arion_cid: entry.arion_cid.clone(),
                source: format!("{folder_path}/{}", entry.name),
                miner_ids: Vec::new(),
                is_assigned: true,
                last_charged_at: last_charged_at_ms,
                is_folder: entry.is_folder,
                file_type: "private".to_string(),
                is_erasure_coded: false,
                main_req_hash: String::new(),
                sync_status: entry.sync_status.clone(),
                label: label.clone(),
                file_count: if entry.is_folder { Some(entry.file_count) } else { None },
                deleted: false,
            });
        }
    }

    if let Some(ref f) = filters {
        apply_file_filters(&mut all_files, f);
    }

    // Sort by timestamp (newest first)
    all_files.sort_by(|a, b| b.last_charged_at.cmp(&a.last_charged_at));

    Ok(UserFilesResult {
        files: all_files,
        total_private_size: total_private_size.to_string(),
        sync_folder_labels,
    })
}

/// Apply the full filter chain to a mutable file list in place.
///
/// Shared between [`get_user_files`] (initial fetch with filters) and
/// [`filter_file_entries`] (UI-side filter re-application without a
/// refetch). Owning the filter rules in a single function keeps the
/// folder view and the files page from drifting — previously both
/// reimplemented the logic in TypeScript.
fn apply_file_filters(files: &mut Vec<UserFileEntry>, f: &FileFilterCriteria) {
    let search_lower = f.search_term.as_ref().and_then(|s| {
        let low = s.to_lowercase();
        if low.is_empty() { None } else { Some(low) }
    });
    let now = chrono::Utc::now();

    files.retain(|file| {
        if let Some(ref tab) = f.folder_tab
            && file.label != *tab
        {
            return false;
        }

        if let Some(ref search) = search_lower
            && !file.name.to_lowercase().contains(search)
            && !file.arion_hash.to_lowercase().contains(search)
        {
            return false;
        }

        if let Some(ref types) = f.file_types
            && !types.is_empty()
        {
            let matches = if file.is_folder {
                types.iter().any(|t| t == "folder")
            } else {
                let ext = file.name.rsplit('.').next().unwrap_or("").to_lowercase();
                let file_type = classify_extension(&ext);
                types.iter().any(|t| t == file_type)
            };
            if !matches {
                return false;
            }
        }

        if let Some(ref date) = f.date_filter
            && !date.is_empty()
        {
            if file.created_at == 0 {
                return false;
            }
            let file_ms = if file.created_at > 946_684_800_000 {
                file.created_at
            } else {
                file.created_at * 1000
            };
            let Some(file_dt) = chrono::DateTime::from_timestamp_millis(file_ms) else {
                return false;
            };
            let date_matches = match date.as_str() {
                "today" => file_dt.date_naive() == now.date_naive(),
                "last7days" => (now - file_dt).num_days() <= 7,
                "last30days" => (now - file_dt).num_days() <= 30,
                "thisyear" => file_dt.date_naive().year() == now.date_naive().year(),
                "lastyear" => file_dt.date_naive().year() == now.date_naive().year() - 1,
                _ => {
                    if let Ok(target) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                        file_dt.date_naive() == target
                    } else {
                        true
                    }
                }
            };
            if !date_matches {
                return false;
            }
        }

        // Size thresholds come from `EnhancedFileSizeSelector` in SI
        // bytes (1 MB = 1_000_000) to match the user-facing labels the
        // `formatBytes` helper prints. Any other numeric threshold is
        // treated as a custom "size >= N" cut.
        if let Some(ref sizes) = f.file_sizes
            && !sizes.is_empty()
        {
            let size = file.size;
            let size_matches = sizes.iter().any(|&threshold| match threshold {
                1 => size < 1_000_000,
                1_000_000 => (1_000_000..=100_000_000).contains(&size),
                100_000_000 => size > 100_000_000 && size <= 1_000_000_000,
                1_000_000_000 => size > 1_000_000_000,
                _ => size >= threshold,
            });
            if !size_matches {
                return false;
            }
        }

        true
    });
}

/// Map a file extension to the coarse type group the filter UI uses.
///
/// Pulled out of the filter so the same classifier can be reused (e.g.
/// for icon selection) without duplicating the extension list.
fn classify_extension(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "svg" | "webp" | "ico" | "tiff" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "wmv" | "flv" | "webm" | "m4v" | "3gp" => "video",
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "wma" | "m4a" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "csv" | "md" => "document",
        "zip" | "tar" | "gz" | "rar" | "7z" | "bz2" => "archive",
        _ => "other",
    }
}

/// Apply the user files filter to an arbitrary list of entries.
///
/// Used by the files page and the folder view to re-filter a list the
/// frontend already has without re-fetching it from disk. Exposing the
/// shared filter as its own command keeps every filter rule (date
/// ranges, size thresholds, search behaviour) on the Rust side — the
/// TS layer now just passes criteria and renders the result.
#[tauri::command]
pub fn filter_file_entries(files: Vec<UserFileEntry>, filters: FileFilterCriteria) -> Vec<UserFileEntry> {
    let mut files = files;
    apply_file_filters(&mut files, &filters);
    files
}

/// Export file or folder from sync folder to arbitrary location.
///
/// Rejects `sync_path` values that are not registered in the `sync_paths`
/// table for the active account. Without this check, a caller (e.g. a
/// compromised frontend) could set `sync_path` to `/` and `file_name` to
/// `etc/passwd` and the inner `ensure_within` guard would trivially allow
/// it because `/etc/passwd` is contained in `/`.
#[tauri::command]
pub async fn export_file(
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    file_name: String,
    output_path: String,
) -> Result<()> {
    // Gate 1: sync_path must be a registered sync folder for the active
    // user. This prevents the broad `ensure_within` guard from being
    // bypassed via an attacker-controlled parent directory.
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    let owner = account_key(&account_id);
    let registered: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM sync_paths WHERE owner = ? AND path = ? LIMIT 1")
        .bind(&owner)
        .bind(&sync_path)
        .fetch_optional(state.pool()?)
        .await?;
    if registered.is_none() {
        return Err(crate::error::AppError::Other(
            "sync_path is not a registered sync folder for this account".into(),
        ));
    }

    let parent = Path::new(&sync_path);
    let source = parent.join(&file_name);
    let source = ensure_within(parent, &source)?;

    if source.is_dir() {
        copy_dir_recursive(&source, Path::new(&output_path), 0).await?;
    } else {
        tokio::fs::copy(&source, &output_path)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("Export failed: {e}")))?;
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
) -> Result<String> {
    // Reject path traversal attempts — slashes are allowed for subfolder access
    if file_name.contains("..") {
        return Err(crate::error::AppError::Other("Invalid file name".into()));
    }

    let db = state.pool()?;
    let owner = account_key(&account_id);

    let result: Option<(String,)> = sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(&label)
        .fetch_optional(db)
        .await?;

    let sync_path = result
        .map(|(p,)| p)
        .ok_or_else(|| format!("No sync path configured for label '{label}'"))?;

    let full_path = Path::new(&sync_path).join(&file_name);

    // Validate the resolved path stays within the sync folder
    let canonical_parent = Path::new(&sync_path)
        .canonicalize()
        .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
    let canonical_file = full_path.canonicalize().map_err(|_| format!("File not found: {file_name}"))?;
    if !canonical_file.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    Ok(canonical_file.to_string_lossy().to_string())
}

/// Resolved sync path and relative file name, ready for `export_file`.
#[derive(Serialize)]
pub struct FilePathInfo {
    pub sync_path: String,
    pub relative_name: String,
}

/// Resolve the sync folder path and the file's relative name within it.
///
/// This replaces duplicated path resolution logic that was spread across
/// three TypeScript files (`downloadFile.ts`, `downloadFolder.ts`,
/// `use-delete-file/index.tsx`).
///
/// Resolution strategy:
/// 1. Look up sync_path for the given `label` (falls back to "default").
/// 2. If `source` is provided and starts with the sync_path prefix, derive
///    the relative name by stripping the prefix. Otherwise use `file_name`.
#[tauri::command]
pub async fn resolve_file_info(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    label: Option<String>,
    source: Option<String>,
    file_name: String,
) -> Result<FilePathInfo> {
    let pool = state.pool()?;
    let effective_label = label.as_deref().unwrap_or("default");

    // Try the requested label, fall back to "default"
    let sync_path = match crate::sync::config::get_sync_path_for_label(pool, &account_id, effective_label).await {
        Ok(p) => p,
        Err(_) if effective_label != "default" => crate::sync::config::get_sync_path_for_label(pool, &account_id, "default")
            .await
            .unwrap_or_default(),
        Err(_) => String::new(),
    };

    let relative_name = derive_relative_name(&sync_path, source.as_deref(), &file_name);

    Ok(FilePathInfo { sync_path, relative_name })
}

/// Derive a file's path relative to the sync root.
///
/// If `source` starts with `sync_path/`, strips the prefix to get the
/// relative path (e.g., `/home/user/Hippius/docs/file.txt` → `docs/file.txt`).
/// Otherwise returns `fallback_name` as-is.
fn derive_relative_name(sync_path: &str, source: Option<&str>, fallback_name: &str) -> String {
    if let Some(src) = source
        && !sync_path.is_empty()
    {
        let prefix = if sync_path.ends_with('/') {
            sync_path.to_string()
        } else {
            format!("{sync_path}/")
        };
        if src.starts_with(&prefix) {
            return src[prefix.len()..].to_string();
        }
    }
    fallback_name.to_string()
}

/// Delegates to hcfs-client library.
async fn copy_dir_recursive(src: &Path, dst: &Path, depth: u32) -> Result<()> {
    hcfs_client::drive::files::copy_dir_recursive(src, dst, depth)
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- derive_relative_name ---

    #[test]
    fn strips_sync_path_prefix() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius", Some("/home/user/Hippius/docs/file.txt"), "fallback.txt"),
            "docs/file.txt",
        );
    }

    #[test]
    fn strips_prefix_with_trailing_slash() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius/", Some("/home/user/Hippius/file.txt"), "fallback.txt"),
            "file.txt",
        );
    }

    #[test]
    fn falls_back_when_source_doesnt_match() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius", Some("/other/path/file.txt"), "fallback.txt"),
            "fallback.txt",
        );
    }

    #[test]
    fn falls_back_when_no_source() {
        assert_eq!(derive_relative_name("/home/user/Hippius", None, "fallback.txt"), "fallback.txt",);
    }

    #[test]
    fn falls_back_when_empty_sync_path() {
        assert_eq!(derive_relative_name("", Some("/some/path/file.txt"), "fallback.txt"), "fallback.txt",);
    }

    #[test]
    fn handles_nested_subfolder() {
        assert_eq!(derive_relative_name("/sync", Some("/sync/a/b/c/deep.txt"), "x.txt"), "a/b/c/deep.txt",);
    }

    // --- filter_file_entries / apply_file_filters ---

    fn make_file(name: &str, size: u64, label: &str, created_at: i64, is_folder: bool) -> UserFileEntry {
        UserFileEntry {
            name: name.to_string(),
            actual_file_name: name.to_string(),
            size,
            created_at,
            arion_hash: String::new(),
            arion_cid: String::new(),
            source: String::new(),
            miner_ids: Vec::new(),
            is_assigned: false,
            last_charged_at: created_at,
            is_folder,
            file_type: String::new(),
            is_erasure_coded: false,
            main_req_hash: String::new(),
            sync_status: String::new(),
            label: label.to_string(),
            file_count: None,
            deleted: false,
        }
    }

    #[test]
    fn filter_search_matches_name_case_insensitive() {
        let files = vec![make_file("Report.pdf", 1_000, "docs", 0, false), make_file("photo.png", 1_000, "docs", 0, false)];
        let criteria = FileFilterCriteria {
            search_term: Some("REPORT".into()),
            file_types: None,
            date_filter: None,
            file_sizes: None,
            folder_tab: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Report.pdf");
    }

    #[test]
    fn filter_folder_tab_isolates_label() {
        let files = vec![
            make_file("a.txt", 1, "drive-one", 0, false),
            make_file("b.txt", 1, "drive-two", 0, false),
            make_file("c.txt", 1, "drive-one", 0, false),
        ];
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: None,
            date_filter: None,
            file_sizes: None,
            folder_tab: Some("drive-one".into()),
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["a.txt", "c.txt"]);
    }

    #[test]
    fn filter_size_si_thresholds() {
        let files = vec![
            make_file("tiny.txt", 500, "d", 0, false),               // Small
            make_file("medium.zip", 50_000_000, "d", 0, false),      // Medium
            make_file("large.bin", 500_000_000, "d", 0, false),      // Large
            make_file("huge.iso", 5_000_000_000, "d", 0, false),     // Very Large
        ];
        // "Medium" + "Very Large" selected — boundaries match the UI's SI labels.
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: None,
            date_filter: None,
            file_sizes: Some(vec![1_000_000, 1_000_000_000]),
            folder_tab: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["medium.zip", "huge.iso"]);
    }

    #[test]
    fn filter_type_classifies_by_extension() {
        let files = vec![
            make_file("pic.png", 1, "d", 0, false),
            make_file("clip.mp4", 1, "d", 0, false),
            make_file("notes.txt", 1, "d", 0, false),
            make_file("subfolder", 0, "d", 0, true),
        ];
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: Some(vec!["image".into(), "folder".into()]),
            date_filter: None,
            file_sizes: None,
            folder_tab: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["pic.png", "subfolder"]);
    }

    #[test]
    fn empty_criteria_is_a_noop() {
        let files = vec![make_file("a.txt", 1, "d", 0, false), make_file("b.txt", 1, "d", 0, false)];
        let criteria = FileFilterCriteria {
            search_term: Some(String::new()),
            file_types: Some(Vec::new()),
            date_filter: Some(String::new()),
            file_sizes: Some(Vec::new()),
            folder_tab: None,
        };
        assert!(criteria.is_empty());
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.len(), 2);
    }
}
