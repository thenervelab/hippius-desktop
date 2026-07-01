//! Per-file/per-drive failure tracking and notification gating.
//!
//! Submodules are re-exported at `crate::sync::<module>` from `sync/mod.rs`,
//! so this grouping is an organizational layer over the file tree, not a path change.

pub mod credits_exhausted;
pub mod error_notify;
pub mod failure_commands;
pub mod failure_repo;
pub mod failure_tracking;
