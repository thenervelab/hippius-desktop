//! File synchronization system.
//!
//! Contains the HCFS drive manager, multi-drive sync engine, progress tracking,
//! file operations, and all sync-related IPC commands.
//!
//! The submodules are organized into six private sub-domain groups — `drive`,
//! `projection`, `fileops`, `migrate`, `failure`, and `shared`. Every submodule
//! is re-exported here so the established `crate::sync::<module>::<item>` paths
//! keep resolving unchanged: the grouping is an organizational layer over the
//! file tree, not a path change. Add a new submodule to its group's `<group>.rs`
//! and re-export it below.

mod drive;
mod failure;
mod fileops;
mod migrate;
mod projection;
mod shared;

pub use drive::{config, control, device, drive_status, identity, lifecycle, lifecycle_guard, paths, selective};
pub use failure::{credits_exhausted, error_notify, failure_commands, failure_repo, failure_tracking, folder_restore_notify};
pub use fileops::{files, folders, recent_uploads, remote};
pub use migrate::{
    folder_entries_backfill, folder_entries_materialize, folder_entries_reconcile, migration, relative_path_backfill, relative_path_backfill_reset,
    user_stopped_migration, user_stopped_reversal,
};
pub use projection::{events, intent, logic, preparing, progress, status, tauri_bridge, upload_processing};
pub use shared::{chunk_reclaim, mnemonic, region};
