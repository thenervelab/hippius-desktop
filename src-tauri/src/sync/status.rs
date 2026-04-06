//! Tauri commands for sync status queries.
//!
//! These are thin wrappers that delegate to `SyncEngine` methods.

use hcfs_client::engine::types::{CombinedSyncState, SyncActivityAction, SyncActivityItem, SyncEngineHealth};
use serde::Serialize;
use std::collections::HashSet;
use tauri::{AppHandle, Wry};

/// Return the combined sync state across all drives.
#[tauri::command]
pub fn get_sync_status(state: tauri::State<'_, crate::app_state::AppState>) -> CombinedSyncState {
    state.sync.get_sync_status()
}

/// Return recent sync activity, optionally filtered by drive label.
#[tauri::command]
pub fn get_sync_activity(state: tauri::State<'_, crate::app_state::AppState>, limit: Option<usize>, label: Option<String>) -> Vec<SyncActivityItem> {
    state.sync.get_sync_activity(limit, label)
}

/// Return the current server connectivity health status.
#[tauri::command]
pub fn get_sync_engine_health(state: tauri::State<'_, crate::app_state::AppState>) -> SyncEngineHealth {
    state.sync.get_health()
}

/// Pre-normalized activity row ready for UI rendering.
///
/// Replaces the `normalizeActivityToRows()` TypeScript function that was
/// deduplicating, mapping statuses, shortening names, and sorting in the
/// frontend.
#[derive(Serialize)]
pub struct SyncActivityRow {
    pub id: String,
    pub file_name: String,
    pub raw_name: String,
    pub status: String,
    pub size: u64,
    pub timestamp: Option<i64>,
    pub deleted: bool,
}

/// Return recent sync activity as pre-normalized rows ready for UI display.
///
/// Handles deduplication, status mapping, name shortening, and sorting so
/// the frontend has zero transformation logic.
#[tauri::command]
pub fn get_sync_activity_rows(state: tauri::State<'_, crate::app_state::AppState>, limit: Option<usize>) -> Vec<SyncActivityRow> {
    let items = state.sync.get_sync_activity(limit, None);
    normalize_activity_rows(&items)
}

fn normalize_activity_rows(items: &[SyncActivityItem]) -> Vec<SyncActivityRow> {
    let mut rows = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();

    for item in items {
        let id = format!("{}:{}", item.action, item.file_name);
        if !seen.insert(id.clone()) {
            continue;
        }

        let status = match item.action {
            SyncActivityAction::Deleted => "deleted",
            // Uploaded, Downloaded, Conflict all map to "uploaded" in the
            // UI — historical behaviour. The previous string-based code had
            // an "uploading" arm but `SyncActivityItem.action` was never
            // set to that value (it came from `FileStatus`, not from this
            // struct).
            _ => "uploaded",
        };

        let raw_name = if item.file_name.is_empty() {
            "Unknown".to_string()
        } else {
            item.file_name.to_string()
        };
        let file_name = shorten_name(&raw_name, 30);

        rows.push(SyncActivityRow {
            id,
            file_name,
            raw_name,
            status: status.to_string(),
            size: item.size_bytes,
            timestamp: Some(item.timestamp),
            deleted: item.action == SyncActivityAction::Deleted,
        });
    }

    rows.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    rows
}

fn shorten_name(name: &str, max_len: usize) -> String {
    if name.chars().count() <= max_len {
        return name.to_string();
    }
    let head: String = name.chars().take(15).collect();
    let tail: String = name.chars().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}…{tail}")
}

/// Gracefully exit the application.
#[tauri::command]
pub fn app_close(app: AppHandle<Wry>) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_item(file_name: &str, action: SyncActivityAction, timestamp: i64) -> SyncActivityItem {
        SyncActivityItem {
            file_name: std::sync::Arc::from(file_name),
            action,
            timestamp,
            size_bytes: 100,
            label: std::sync::Arc::from("default"),
        }
    }

    #[test]
    fn normalize_deduplicates_by_action_and_name() {
        let items = vec![
            make_item("file.txt", SyncActivityAction::Uploaded, 1000),
            make_item("file.txt", SyncActivityAction::Uploaded, 2000),
        ];
        let rows = normalize_activity_rows(&items);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn normalize_keeps_different_actions() {
        let items = vec![
            make_item("file.txt", SyncActivityAction::Uploaded, 1000),
            make_item("file.txt", SyncActivityAction::Deleted, 2000),
        ];
        let rows = normalize_activity_rows(&items);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn normalize_maps_status_correctly() {
        // Activity items sort newest-first, so timestamps order results.
        let items = vec![
            make_item("a.txt", SyncActivityAction::Uploaded, 1),
            make_item("b.txt", SyncActivityAction::Deleted, 2),
            make_item("c.txt", SyncActivityAction::Conflict, 3),
            make_item("d.txt", SyncActivityAction::Downloaded, 4),
        ];
        let rows = normalize_activity_rows(&items);
        // Sorted newest-first: d (4), c (3), b (2), a (1)
        assert_eq!(rows[0].status, "uploaded"); // Downloaded → "uploaded"
        assert_eq!(rows[1].status, "uploaded"); // Conflict → "uploaded"
        assert_eq!(rows[2].status, "deleted");
        assert_eq!(rows[3].status, "uploaded");
    }

    #[test]
    fn normalize_sorts_newest_first() {
        let items = vec![
            make_item("old.txt", SyncActivityAction::Uploaded, 100),
            make_item("new.txt", SyncActivityAction::Uploaded, 500),
            make_item("mid.txt", SyncActivityAction::Uploaded, 300),
        ];
        let rows = normalize_activity_rows(&items);
        assert_eq!(rows[0].raw_name, "new.txt");
        assert_eq!(rows[1].raw_name, "mid.txt");
        assert_eq!(rows[2].raw_name, "old.txt");
    }

    #[test]
    fn shorten_name_under_limit_unchanged() {
        assert_eq!(shorten_name("short.txt", 30), "short.txt");
    }

    #[test]
    fn shorten_name_over_limit_truncated() {
        let long = "a".repeat(50);
        let result = shorten_name(&long, 30);
        assert!(result.len() < 50);
        assert!(result.contains('…'));
    }

    #[test]
    fn normalize_empty_filename_becomes_unknown() {
        let items = vec![make_item("", SyncActivityAction::Uploaded, 1)];
        let rows = normalize_activity_rows(&items);
        assert_eq!(rows[0].raw_name, "Unknown");
    }
}
