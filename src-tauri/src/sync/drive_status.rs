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
//! ## Error variant
//!
//! `DriveStatus::Error { message }` is emitted by `auto_init_sync_inner`
//! when a per-drive `initialize_sync_inner` call fails — previously these
//! were silently swallowed and the drive just vanished from the per-drive
//! status map, leaving the user with no affordance to retry. The FE
//! renders this as a "needs attention" row and triggers a retry on the
//! `hippius_auth_ready` event, which covers the slow-system race where
//! `AuthInfo.mnemonic` hasn't been populated yet when auto-init first
//! runs.

use serde::{Deserialize, Serialize};

/// Per-drive status. Wire format is camelCase to match TypeScript.
///
/// `serde(tag = "kind")` produces `{"kind": "active"}`, `{"kind": "paused"}`,
/// or `{"kind": "error", "message": "..."}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DriveStatus {
    /// Drive is loaded in memory and sync cycles include it.
    Active,
    /// Drive's `is_paused` flag is true; not in the drives map.
    Paused,
    /// Init failed — carries the user-facing reason so the FE can render
    /// a retry affordance without a second IPC round-trip.
    Error { message: String },
}

/// One row in the response from `get_all_drive_statuses`.
///
/// `folder_name` is the basename of the configured sync path
/// (e.g. `/Users/me/Documents/Hippius` → `"Hippius"`). It's the
/// user-facing name shown in tray submenus, settings rows, and any
/// other UI surface that displays a drive — much friendlier than the
/// internal `label`, which is sometimes the literal string `"default"`
/// for the legacy single-drive setup.
///
/// `path` is the absolute on-disk location of the synced folder. It
/// rides on every entry so the frontend never needs to call back into
/// the `sync_paths` table to resolve a label → path mapping (folder
/// pickers, "Reveal in Finder" wiring, the files-folder breadcrumbs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatusEntry {
    pub label: String,
    pub folder_name: String,
    pub path: String,
    pub status: DriveStatus,
}

/// Pure helper: derive the user-facing folder name from a sync path.
///
/// Returns the basename of `path` (e.g. `/Users/me/Hippius` → `"Hippius"`).
/// Falls back to `label` when the path has no basename — typically only
/// hits for the literal `"/"` or empty paths, and we'd rather show the
/// label than an empty string.
pub fn derive_folder_name(path: &str, label: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map_or_else(|| label.to_string(), ToString::to_string)
}

/// Translate the persisted `is_paused` column into a `DriveStatus`.
///
/// This is the only translation step needed: a path with `is_paused=true`
/// is `Paused`, everything else is `Active`. The "drive is in the
/// in-memory map" check is implied by `is_paused=false` because every
/// non-paused path is loaded by `auto_init_sync` at startup; if a load
/// failure prevents that, `auto_init_sync_inner` emits a subsequent
/// `DriveStatus::Error` event for that label which overrides this
/// bootstrap default in the FE map.
pub fn status_from_is_paused(is_paused: bool) -> DriveStatus {
    if is_paused { DriveStatus::Paused } else { DriveStatus::Active }
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
    fn derive_folder_name_uses_basename() {
        assert_eq!(derive_folder_name("/Users/me/Hippius", "default"), "Hippius");
        assert_eq!(derive_folder_name("/Users/me/Documents/Photos", "photos"), "Photos");
    }

    #[test]
    fn derive_folder_name_falls_back_to_label_when_no_basename() {
        assert_eq!(derive_folder_name("/", "default"), "default");
        assert_eq!(derive_folder_name("", "my-label"), "my-label");
    }

    #[test]
    fn drive_status_serializes_as_tagged_kind() {
        // The wire format is `{"kind": "active"}` (not just `"active"`)
        // so the `Error { message }` variant sits alongside the unit
        // variants without breaking compatibility.
        let active = serde_json::to_string(&DriveStatus::Active).unwrap();
        let paused = serde_json::to_string(&DriveStatus::Paused).unwrap();
        let error = serde_json::to_string(&DriveStatus::Error { message: "boom".to_string() }).unwrap();
        assert_eq!(active, r#"{"kind":"active"}"#);
        assert_eq!(paused, r#"{"kind":"paused"}"#);
        assert_eq!(error, r#"{"kind":"error","message":"boom"}"#);
    }

    #[test]
    fn drive_status_round_trips() {
        for s in [
            DriveStatus::Active,
            DriveStatus::Paused,
            DriveStatus::Error {
                message: "oh no".to_string(),
            },
        ] {
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
            path: "/Users/me/Documents/Hippius".to_string(),
            status: DriveStatus::Active,
        };
        let json = serde_json::to_string(&entry).unwrap();
        // Field names are camelCase even though Rust uses snake_case.
        assert_eq!(
            json,
            r#"{"label":"default","folderName":"Hippius","path":"/Users/me/Documents/Hippius","status":{"kind":"active"}}"#
        );
    }
}
