//! Drive lifecycle, registration, and per-drive configuration.
//!
//! Submodules are re-exported at `crate::sync::<module>` from `sync/mod.rs`,
//! so this grouping is an organizational layer over the file tree, not a path change.

pub mod config;
pub mod control;
pub mod device;
pub mod drive_status;
pub mod lifecycle;
pub mod lifecycle_guard;
pub mod paths;
pub mod selective;
