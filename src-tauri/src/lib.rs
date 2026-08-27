//! Library target for the Hippius Desktop Tauri backend.
//!
//! Re-exports modules so integration tests (`cargo test --test <name>`)
//! can import symbols like `crypto::store::*`. This is a binary
//! application, not a published library — the public surface here is
//! only consumed by tests.

pub mod api;
pub mod app_state;
pub mod auth;
pub mod billing;
pub mod blockchain;
pub mod console_access;
pub mod crypto;
pub mod error;
/// File-manager shell-extension bridge. Compiled on macOS, Linux, and Windows
/// so every CI `rust` job builds + tests the shared core (wire codec, transport
/// server, endpoint resolution); the active click→share plumbing is enabled by
/// each platform's native shim.
#[cfg(any(unix, windows))]
pub mod finder_bridge;
pub mod infra;
pub mod media_preview;
pub mod notifications;
pub mod power;
pub mod recovery;
pub mod recovery_binding;
pub mod recovery_proof;
pub mod release_channel;
pub mod shared_drives;
pub mod shares;
pub mod sync;
pub mod tray;
pub mod updates;
pub mod utils;
pub mod vpn;
pub mod wallet;

#[cfg(test)]
mod test_helpers;
