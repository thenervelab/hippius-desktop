//! Library target for the Hippius Desktop Tauri backend.
//!
//! Re-exports modules needed by integration tests. The binary entry
//! point is `main.rs`; this lib target exists so that `cargo test
//! --test <name>` can import symbols like `crypto::store::*`.

pub mod api;
pub mod app_state;
pub mod auth;
pub mod billing;
pub mod blockchain;
pub mod crypto;
pub mod error;
pub mod infra;
pub mod nebula;
pub mod notifications;
pub mod sync;
pub mod utils;
