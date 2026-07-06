//! File and folder operations over synced drives.
//!
//! Submodules are re-exported at `crate::sync::<module>` from `sync/mod.rs`,
//! so this grouping is an organizational layer over the file tree, not a path change.

pub mod files;
pub mod folders;
pub mod recent_uploads;
pub mod remote;
