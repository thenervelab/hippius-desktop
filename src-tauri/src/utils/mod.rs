//! Shared utility modules used across the Tauri backend.
//!
//! These are internal helpers — not exposed as IPC commands. Grouped by
//! concern: cryptographic key derivation, auth token persistence, Nebula
//! VPN management, macOS sandbox bookmarks, and sync helpers.

pub mod account_key;
pub mod accounts;
pub mod auth_tokens;
pub mod bookmark_db;
pub mod nebula;
pub mod sync;
