//! Path resolution and export: `export_file`, `resolve_file_path`,
//! `resolve_file_info`. Shared path helpers live in `pathops`.

use super::pathops::{copy_dir_recursive, derive_relative_name, ensure_within};
use crate::auth::account_key::account_key;
use crate::error::Result;
use serde::Serialize;
use std::path::Path;

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
    let account_id = state.current_account_id()?;
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
    let account_id = state.require_session_account(&account_id)?;
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
    let account_id = state.require_session_account(&account_id)?;
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
