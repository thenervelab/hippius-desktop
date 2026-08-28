//! Tauri commands for sync status queries.
//!
//! These are thin wrappers that delegate to `SyncEngine` methods.

use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem, SyncEngineHealth};
use serde::Serialize;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Wry};

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

    rows.sort_by_key(|b| std::cmp::Reverse(b.timestamp));
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

// ── Per-drive status (replaces the old global SyncEngineStatus) ────────

use crate::error::AppError;
use crate::sync::drive_status::{DriveStatus, DriveStatusEntry, derive_folder_name, status_from_is_paused};
use crate::sync::events::{DRIVE_REMOVED, DRIVE_STATUS_CHANGED, DriveStatusChangedPayload};

/// Emit a `DRIVE_STATUS_CHANGED` event for a single drive.
///
/// Use this from any lifecycle transition that changes a drive's
/// status (init success, pause, resume, init failure) so the frontend
/// can update its per-drive status map without re-fetching the full
/// list.
///
/// Callers must pass the drive's on-disk `path` so the FE can populate
/// the entry without a fallback DB read. `folder_name` is derived from
/// the path here so the helper has exactly one source of truth for
/// basename derivation (`derive_folder_name`).
///
/// Also writes the status into `AppState::drive_status_cache` so a
/// subsequent `get_all_drive_statuses` call (e.g. when the user
/// navigates to the Settings page after an init failure has already
/// emitted) returns the last-known status instead of clobbering the
/// FE atom's Error state with the DB-derived `Active`.
///
/// Emit failures are swallowed because they only happen when the app
/// is shutting down, in which case the FE will rebuild from
/// `get_all_drive_statuses` on next mount anyway — which now reads
/// the cache.
///
/// Generic over the Tauri runtime (like the lifecycle callbacks) so the
/// `suspend_drive_inmemory` teardown funnel can be driven end-to-end from
/// the in-module `MockRuntime` tests; production callers pass `Wry`.
pub fn emit_drive_status<R: tauri::Runtime>(app: &AppHandle<R>, label: &str, path: &str, status: DriveStatus) {
    use tauri::Manager;

    // Write the last-emitted status to the per-drive cache BEFORE
    // emitting the event. The cache is what `get_all_drive_statuses`
    // will read on the next FE bootstrap, so writing here ensures the
    // cache is up-to-date for the lifetime of this status — even if
    // the FE isn't listening at the moment the event fires.
    let app_state = app.state::<crate::app_state::AppState>();
    if let Ok(mut cache) = app_state.drive_status_cache.lock() {
        cache.insert(label.to_string(), status.clone());
    }

    let payload = DriveStatusChangedPayload {
        label: label.to_string(),
        folder_name: derive_folder_name(path, label),
        path: path.to_string(),
        status,
    };
    let _ = app.emit(DRIVE_STATUS_CHANGED, payload);
}

/// Emit a `DRIVE_REMOVED` event for a single drive. Called by
/// `remove_drive` after the `sync_paths` row is deleted. The FE
/// listener drops the entry from its per-drive status map, and the
/// per-drive cache entry is pruned here so a label-reuse scenario
/// (user removes a drive then creates a new one with the same label)
/// doesn't resurface a stale Error state.
pub fn emit_drive_removed(app: &AppHandle<Wry>, label: &str) {
    use tauri::Manager;

    let app_state = app.state::<crate::app_state::AppState>();
    if let Ok(mut cache) = app_state.drive_status_cache.lock() {
        cache.remove(label);
    }

    let payload = crate::sync::events::LabelPayload { label: label.to_string() };
    let _ = app.emit(DRIVE_REMOVED, payload);
}

/// Inner body of `get_all_drive_statuses` — takes a borrowed `AppState`
/// directly so integration tests can exercise the per-drive query
/// without constructing a `tauri::State` wrapper. The IPC command
/// below is a one-liner that delegates here.
///
/// Status resolution precedence:
/// 1. **`drive_status_cache`** — the last status emitted for this
///    label via `emit_drive_status`, including `Error` states from
///    `auto_init_sync_inner`'s per-drive init failure path. This is
///    what prevents the FE from silently clobbering an Error row
///    with `Active` when the user navigates to Settings after the
///    init failure has already fired.
/// 2. **`status_from_is_paused`** — the DB-derived fallback for
///    labels that haven't emitted a status yet this session (fresh
///    cold start before the first init loop).
pub async fn get_all_drive_statuses_inner(state: &crate::app_state::AppState) -> Result<Vec<DriveStatusEntry>, AppError> {
    let pool = state.pool()?;

    // No account → empty list. The FE shouldn't be calling this when
    // logged out, but be defensive.
    let Ok(account_id) = state.current_account_id() else {
        return Ok(Vec::new());
    };

    // Propagate a DB failure rather than rendering it as an empty drive list:
    // `.unwrap_or_default()` made a pool/query error indistinguishable from a
    // legitimately empty account, so the FE showed "no drives configured" for a
    // transient DB error. The no-account case above already returns an empty
    // list; a real query error should surface (the FE handles an Err here).
    let paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id).await?;

    // Snapshot the cache once so the loop below doesn't hold the lock
    // across the sync-path iteration. A missing label falls through to
    // the DB-derived status; a hit wins over it.
    // Recover a poisoned lock rather than `unwrap_or_default()`-ing to an empty
    // cache, which would silently drop every cached drive status (the rows fall
    // back to DB-derived status, masking the poison). into_inner reads the data.
    let cache_snapshot: std::collections::HashMap<String, DriveStatus> =
        state.drive_status_cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();

    Ok(paths
        .into_iter()
        // Skip the internal "migration" pseudo-drive — it's not user-
        // facing and shouldn't appear in any per-drive UI.
        .filter(|p| p.label != "migration")
        .map(|p| {
            // Folder name is derived via the shared helper so the
            // bootstrap fetch and the per-drive `emit_drive_status`
            // event always produce the same basename for the same
            // path.
            let folder_name = derive_folder_name(&p.path, &p.label);
            let status = cache_snapshot
                .get(&p.label)
                .cloned()
                .unwrap_or_else(|| status_from_is_paused(p.is_paused));
            DriveStatusEntry {
                label: p.label,
                folder_name,
                path: p.path,
                status,
            }
        })
        .collect())
}

/// Return the per-drive status for every configured `sync_paths` row
/// belonging to the current account.
///
/// Called by the frontend on mount to bootstrap its per-drive status
/// map. After mount, the FE listens for `DRIVE_STATUS_CHANGED` /
/// `DRIVE_REMOVED` events to keep the map in sync without re-polling.
///
/// Returns an empty list when no account is logged in (the FE renders
/// nothing in that case anyway).
#[tauri::command]
pub async fn get_all_drive_statuses(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Vec<DriveStatusEntry>, AppError> {
    get_all_drive_statuses_inner(&state).await
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

    /// Wire-contract pin for the FOREIGN `hcfs_client::engine::types::SyncEngineHealth`,
    /// which crosses to the FE via TWO paths — the `get_sync_engine_health` command
    /// return AND the `hcfs_connectivity_changed` event (tauri_bridge.rs emits `&health`
    /// raw). The FE `syncAtoms.ts::SyncEngineHealthState` reads the six snake_case keys
    /// below. Foreign + `#[derive(Serialize)]` with no `rename_all`, so an hcfs rename
    /// would break the connection indicator with no compile error here. AUDIT gap H4.
    #[test]
    fn sync_engine_health_pins_wire_shape() {
        use std::collections::BTreeSet;

        let json = serde_json::to_value(SyncEngineHealth::default()).expect("serialize SyncEngineHealth");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = [
            "status",
            "last_check_time",
            "last_successful_check",
            "consecutive_failures",
            "server_version",
            "error_message",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(
            keys, expected,
            "SyncEngineHealth wire keys drifted — FE SyncEngineHealthState reads these"
        );
    }

    /// The `ConnectivityStatus` variant strings are matched literally by the FE
    /// (`syncAtoms.ts::ConnectivityStatusType`) to drive the connection label. A
    /// rename in hcfs would collapse the FE to its `connected` default — HIDING a
    /// real outage. `#[serde(rename_all = "snake_case")]`, pinned here. AUDIT gap H4.
    #[test]
    fn connectivity_status_pins_wire_strings() {
        use hcfs_client::engine::types::ConnectivityStatus;

        let cases = [
            (ConnectivityStatus::Connected, "connected"),
            (ConnectivityStatus::ServerUnreachable, "server_unreachable"),
            (ConnectivityStatus::NetworkOffline, "network_offline"),
            (ConnectivityStatus::AuthExpired, "auth_expired"),
            (ConnectivityStatus::Degraded, "degraded"),
        ];
        for (status, wire) in cases {
            let json = serde_json::to_value(status).expect("serialize ConnectivityStatus");
            assert_eq!(
                json,
                serde_json::Value::String(wire.to_string()),
                "ConnectivityStatus wire string drifted (expected {wire})"
            );
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
