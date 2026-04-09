//! File synchronization system.
//!
//! Contains the HCFS drive manager, multi-drive sync engine, progress tracking,
//! file operations, and all sync-related IPC commands.

pub mod config;
pub mod control;
pub mod device;
pub mod drive_status;
pub mod events;
pub mod failure_commands;
pub mod failure_tracking;
pub mod files;
pub mod folders;
pub mod lifecycle;
pub mod logic;
pub mod migration;
pub mod mnemonic;
pub mod paths;
pub mod progress;
pub mod remote;
pub mod selective;
pub mod status;
pub mod tauri_bridge;
pub mod user_stopped_migration;
