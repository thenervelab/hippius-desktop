//! Tauri IPC command modules.
//!
//! Each sub-module exposes `#[tauri::command]` functions registered in
//! `main.rs` via `tauri::generate_handler![]`. The modules are grouped
//! by domain: authentication, blockchain, file sync, infrastructure
//! (VMs, VPN, SSH keys), billing, and local persistence.

pub mod accounts;
pub mod auth;
pub mod billing;
pub mod billing_auth;
pub mod blockchain;
pub mod chart_formatting;
pub mod file_commands;
pub mod indexer;
pub mod local_db;
pub mod migration;
pub mod notifications;
pub mod oauth;
pub mod remote_browse;
pub mod selective_sync;
pub mod session;
pub mod ssh_keys;
pub mod substrate_tx;
pub mod support;
pub mod sync_status;
pub mod syncing;
pub mod vm;
pub mod vpn_enabled;
