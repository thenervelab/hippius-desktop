//! Per-drive sync status — the single source of truth that replaces the
//! global `SyncEngineStatus` enum.
//!
//! ## Design
//!
//! Every locally synced folder is one drive, and each drive has exactly
//! one of these states at any time:
//!
//! - **Active**: the drive is loaded in memory, the sync loop is running
//!   for it, and `is_paused` is false in the DB.
//! - **Paused**: `is_paused` is true in the DB. The drive is not in the
//!   in-memory drives map; sync cycles skip it. Survives restarts.
//!
//! The previous global model (`Initializing | Active | Stopping | Stopped`)
//! collapsed multiple drives into one enum and had a sticky persisted
//! `user_stopped` flag that got promoted from per-drive operations
//! whenever the operation happened to remove the last drive — that
//! conflation was the source of the "Syncing is currently stopped" bugs
//! we kept hitting (`9aa9f234`, `8b03a64c`, et al).
//!
//! In the new model the FE never asks "is sync stopped?" — it asks
//! "what's the status of each drive?" and renders accordingly. The
//! only persisted state is `sync_paths.is_paused`, derived to `Paused`.
//! Everything else is computed live.
//!
//! ## Future: Error variant
//!
//! `DriveStatus` deliberately has only `Active` and `Paused` for now.
//! A future `Error(String)` variant can be added when we want the
//! settings page to surface per-drive init failures (currently logged
//! and silently swallowed). Adding it requires per-drive error state
//! in `AppState` plus error-clear logic on every successful transition;
//! out of scope for the initial per-drive migration.

use serde::{Deserialize, Serialize};

/// Per-drive status. Wire format is camelCase to match TypeScript.
///
/// `serde(tag = "kind")` produces `{"kind": "active"}` / `{"kind": "paused"}`
/// — the tagged shape leaves room for a future `Error { message: String }`
/// variant without breaking the wire format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DriveStatus {
    /// Drive is loaded in memory and sync cycles include it.
    Active,
    /// Drive's `is_paused` flag is true; not in the drives map.
    Paused,
}

/// One row in the response from `get_all_drive_statuses`.
///
/// `folder_name` is the basename of the configured sync path
/// (e.g. `/Users/me/Documents/Hippius` → `"Hippius"`). It's the
/// user-facing name shown in tray submenus, settings rows, and any
/// other UI surface that displays a drive — much friendlier than the
/// internal `label`, which is sometimes the literal string `"default"`
/// for the legacy single-drive setup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatusEntry {
    pub label: String,
    pub folder_name: String,
    pub status: DriveStatus,
}

/// Translate the persisted `is_paused` column into a `DriveStatus`.
///
/// This is the only translation step needed: a path with `is_paused=true`
/// is `Paused`, everything else is `Active`. The "drive is in the
/// in-memory map" check is implied by `is_paused=false` because every
/// non-paused path is loaded by `auto_init_sync` at startup; if a load
/// failure prevents that, the path is still considered Active here and
/// the failure surfaces elsewhere (logs, future Error variant).
pub fn status_from_is_paused(is_paused: bool) -> DriveStatus {
    if is_paused {
        DriveStatus::Paused
    } else {
        DriveStatus::Active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_from_is_paused_maps_correctly() {
        assert_eq!(status_from_is_paused(true), DriveStatus::Paused);
        assert_eq!(status_from_is_paused(false), DriveStatus::Active);
    }

    #[test]
    fn drive_status_serializes_as_tagged_kind() {
        // The wire format is `{"kind": "active"}` (not just `"active"`)
        // so a future `Error { message }` variant can be added without
        // breaking compatibility.
        let active = serde_json::to_string(&DriveStatus::Active).unwrap();
        let paused = serde_json::to_string(&DriveStatus::Paused).unwrap();
        assert_eq!(active, r#"{"kind":"active"}"#);
        assert_eq!(paused, r#"{"kind":"paused"}"#);
    }

    #[test]
    fn drive_status_round_trips() {
        for s in [DriveStatus::Active, DriveStatus::Paused] {
            let json = serde_json::to_string(&s).unwrap();
            let parsed: DriveStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, s);
        }
    }

    #[test]
    fn drive_status_entry_serializes_camel_case() {
        let entry = DriveStatusEntry {
            label: "default".to_string(),
            folder_name: "Hippius".to_string(),
            status: DriveStatus::Active,
        };
        let json = serde_json::to_string(&entry).unwrap();
        // Field names are camelCase even though Rust uses snake_case.
        assert_eq!(
            json,
            r#"{"label":"default","folderName":"Hippius","status":{"kind":"active"}}"#
        );
    }
}
