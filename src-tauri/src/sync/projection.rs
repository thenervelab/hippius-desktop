//! Progress tracking and UI/event projection (the Tauri bridge).
//!
//! Submodules are re-exported at `crate::sync::<module>` from `sync/mod.rs`,
//! so this grouping is an organizational layer over the file tree, not a path change.

pub mod events;
pub mod intent;
pub mod logic;
pub mod preparing;
pub mod progress;
pub mod status;
pub mod tauri_bridge;
pub mod upload_processing;
