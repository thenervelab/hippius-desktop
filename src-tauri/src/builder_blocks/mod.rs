//! Tauri app builder blocks — setup hooks and event handlers.
//!
//! These modules extend the Tauri `Builder` with database initialization,
//! schema migration, deep-link registration, and window close handling.

pub mod on_window_event;
pub mod setup;
