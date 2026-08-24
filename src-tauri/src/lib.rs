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
/// macOS Finder Sync extension bridge. Gated `#[cfg(unix)]` so the Linux CI
/// `rust` job still compiles + tests the pure wire codec; the socket layer
/// inside is macOS-only.
#[cfg(unix)]
pub mod finder_bridge;
pub mod infra;
pub mod media_preview;
pub mod notifications;
pub mod power;
pub mod recovery;
pub mod recovery_binding;
pub mod shares;
pub mod sync;
pub mod tray;
pub mod utils;
pub mod vpn;
pub mod wallet;

#[cfg(test)]
mod test_helpers;
