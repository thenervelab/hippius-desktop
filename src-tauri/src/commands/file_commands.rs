//! File operations on the local sync folder.
//!
//! These commands let the frontend add, remove, list, and export files
//! from the sync folder. The hcfs-client file watcher picks up changes
//! automatically and syncs them to the remote server.
//!
//! All path-accepting commands include traversal protection via `ensure_within()`.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: Option<u64>,
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
    tokio::fs::copy(source, &dest)
        .await
        .map_err(|e| format!("Copy failed: {e}"))?;

    // Verify the created file is within the sync folder
    ensure_within(parent, &dest)?;

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
    copy_dir_recursive(source, &dest).await?;

    // Verify the created folder is within the sync folder
    ensure_within(parent, &dest)?;

    Ok(name)
}

/// Remove file/folder from sync folder
#[tauri::command]
pub async fn remove_file(sync_path: String, name: String) -> Result<(), String> {
    let parent = Path::new(&sync_path);
    let target = parent.join(&name);
    let target = ensure_within(parent, &target)?;

    if target.is_dir() {
        tokio::fs::remove_dir_all(&target)
            .await
            .map_err(|e| format!("Remove failed: {e}"))?;
    } else if target.exists() {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|e| format!("Remove failed: {e}"))?;
    }
    Ok(())
}

/// List contents of sync folder
#[tauri::command]
pub async fn list_sync_folder(
    sync_path: String,
    subfolder: Option<String>,
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
        entries.push(FileEntry {
            name,
            is_folder: meta.is_dir(),
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
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
        copy_dir_recursive(&source, Path::new(&output_path)).await?;
    } else {
        tokio::fs::copy(&source, &output_path)
            .await
            .map_err(|e| format!("Export failed: {e}"))?;
    }
    Ok(())
}

async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dst)
        .await
        .map_err(|e| e.to_string())?;
    let mut dir = tokio::fs::read_dir(src)
        .await
        .map_err(|e| e.to_string())?;
    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
