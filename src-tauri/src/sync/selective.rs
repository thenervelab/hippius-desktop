//! Tauri IPC commands for managing per-drive exclusion patterns.
//!
//! These commands expose hcfs-client's glob-based file/directory exclusion
//! API. Patterns are stored in `.hippius/{label}/exclude` (one per line,
//! gitignore-style) and are applied during `scan_local_files`.

use crate::app_state::AppState;
use crate::error::AppError;
use hcfs_client::engine::runner::trigger_sync;
use std::path::Path;
use tauri::AppHandle;
use tracing::{debug, info};

/// Validate and trim an exclusion pattern.
///
/// Rejects empty/whitespace-only patterns and patterns containing `../`
/// (path traversal). Returns the trimmed pattern on success.
fn validate_pattern(pattern: &str) -> Result<String, AppError> {
    let trimmed = pattern.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Validation("Pattern cannot be empty".into()));
    }
    if trimmed.contains("../") {
        return Err(AppError::Validation("Pattern cannot contain '../' (path traversal)".into()));
    }
    Ok(trimmed)
}

/// List all active exclusion patterns for a drive.
///
/// Grabs the per-drive Arc from the drives map (microsecond outer lock),
/// then locks the manager to read patterns. Returns an empty list if the
/// drive does not exist.
#[tauri::command]
pub async fn list_exclude_patterns(label: String, app_state: tauri::State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        debug!(label = %label, "Drive not found, returning empty patterns");
        return Ok(Vec::new());
    };

    let manager = arc.lock().await;
    let patterns = manager.list_exclude_patterns();
    debug!(
        label = %label,
        count = patterns.len(),
        "Listed exclude patterns",
    );
    Ok(patterns)
}

/// Add an exclusion pattern to a drive.
///
/// Validates the pattern (rejects empty, whitespace-only, or path-traversal
/// patterns), then delegates to `Drive::add_exclude_pattern`. Returns `true`
/// if the pattern was added, `false` if it already existed.
#[tauri::command]
pub async fn add_exclude_pattern(label: String, pattern: String, app_state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let trimmed = validate_pattern(&pattern)?;

    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;
    let added = manager.add_exclude_pattern(&trimmed).map_err(AppError::Hcfs)?;
    if added {
        info!(label = %label, pattern = %trimmed, "Added exclude pattern");
    } else {
        debug!(
            label = %label,
            pattern = %trimmed,
            "Exclude pattern already exists",
        );
    }
    Ok(added)
}

/// Remove an exclusion pattern from a drive.
///
/// Delegates to `Drive::remove_exclude_pattern`. Returns `true` if the
/// pattern was removed, `false` if it was not found.
#[tauri::command]
pub async fn remove_exclude_pattern(label: String, pattern: String, app_state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;
    let removed = manager.remove_exclude_pattern(&pattern).map_err(AppError::Hcfs)?;
    if removed {
        info!(label = %label, pattern = %pattern, "Removed exclude pattern");
    } else {
        debug!(
            label = %label,
            pattern = %pattern,
            "Exclude pattern not found for removal",
        );
    }
    Ok(removed)
}

/// Check whether a relative path is excluded by the drive's current rules.
#[tauri::command]
pub async fn is_file_excluded(label: String, path: String, is_dir: bool, app_state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;
    let excluded = manager.is_excluded(Path::new(&path), is_dir);
    debug!(
        label = %label,
        path = %path,
        is_dir = is_dir,
        excluded = excluded,
        "Checked file exclusion",
    );
    Ok(excluded)
}

/// Apply a batch of inclusion/exclusion pattern changes atomically.
///
/// Removes exclusion patterns for paths the user wants included, adds
/// patterns for paths the user wants excluded, then triggers sync.
/// Replaces the paired loops in `RemoteFolderBrowser.tsx`.
#[tauri::command]
pub async fn apply_sync_selection(
    app_state: tauri::State<'_, AppState>,
    app: AppHandle,
    label: String,
    include: Vec<String>,
    exclude: Vec<String>,
) -> Result<(), AppError> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;

    for path in &include {
        let _ = manager.remove_exclude_pattern(path).map_err(AppError::Hcfs)?;
    }
    for path in &exclude {
        if let Ok(trimmed) = validate_pattern(path) {
            let _ = manager.add_exclude_pattern(&trimmed).map_err(AppError::Hcfs)?;
        }
    }

    drop(manager);

    info!(
        label = %label,
        included = include.len(),
        excluded = exclude.len(),
        "Applied sync selection"
    );

    // Trigger sync to download newly included files
    { use tauri::Manager; let s = app.state::<crate::app_state::AppState>().sync.clone(); let _ = trigger_sync(&s).await; }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_pattern;

    #[test]
    fn test_validate_empty_pattern_rejected() {
        let result = validate_pattern("");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_whitespace_only_rejected() {
        let result = validate_pattern("   ");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_traversal_pattern_rejected() {
        let result = validate_pattern("../secret");
        assert!(result.is_err());

        let nested = validate_pattern("foo/../bar");
        assert!(nested.is_err());
    }

    #[test]
    fn test_validate_normal_pattern_accepted() {
        assert_eq!(validate_pattern("*.log").unwrap(), "*.log");
        assert_eq!(validate_pattern("node_modules/").unwrap(), "node_modules/");
        assert_eq!(validate_pattern(".DS_Store").unwrap(), ".DS_Store");
    }

    #[test]
    fn test_validate_trims_whitespace() {
        assert_eq!(validate_pattern("  *.tmp  ").unwrap(), "*.tmp");
    }
}
