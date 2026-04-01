//! Library target for the Hippius Desktop Tauri backend.
//!
//! Exposes `sync_logic` for unit testing via `cargo test --lib`. The actual
//! application entry point is `main.rs` — this crate target exists solely
//! so that pure-logic modules can be tested without building the full binary.

pub mod sync_logic;
