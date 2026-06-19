//! File synchronization system.
//!
//! Contains the HCFS drive manager, multi-drive sync engine, progress tracking,
//! file operations, and all sync-related IPC commands.

pub mod config;
pub mod control;
pub mod credits_exhausted;
pub mod device;
pub mod drive_status;
pub mod error_notify;
pub mod events;
pub mod failure_commands;
pub mod failure_repo;
pub mod failure_tracking;
pub mod files;
pub mod folders;
pub mod intent;
pub mod lifecycle;
pub mod lifecycle_guard;
pub mod logic;
pub mod migration;
pub mod mnemonic;
pub mod paths;
pub mod preparing;
pub mod progress;
pub mod recent_uploads;
pub mod region;
pub mod relative_path_backfill;
pub mod relative_path_backfill_reset;
pub mod remote;
pub mod selective;
pub mod status;
pub mod tauri_bridge;
pub mod upload_processing;
pub mod user_stopped_migration;
pub mod user_stopped_reversal;
