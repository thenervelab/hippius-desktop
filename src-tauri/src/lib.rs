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
pub mod infra;
pub mod nebula;
pub mod notifications;
pub mod recovery;
pub mod sync;
pub mod utils;

#[cfg(test)]
mod test_helpers;
