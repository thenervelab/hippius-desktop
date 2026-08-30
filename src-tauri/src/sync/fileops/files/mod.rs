//! File and folder operations on the local sync folder.
//!
//! Split from the former flat `files.rs` into sub-domain submodules. Every item
//! the rest of the crate referenced as `crate::sync::files::X` is re-exported
//! here so external call sites (main.rs's IPC handler list, lifecycle.rs,
//! session_restore.rs, paths.rs, recent_uploads.rs) keep resolving unchanged —
//! this is a move-only refactor with no behavioral change.
//!
//! Cross-submodule private helpers (`ensure_within`, `derive_relative_name`,
//! `copy_dir_recursive`, the `synced_paths_*` reads, exclude-glob matching in
//! `exclude_match`) are `pub(super)` in their home submodule and reached by
//! siblings via `super::<mod>::<item>`; they are deliberately NOT re-exported
//! here. `dir_stats_recursive` is the exception: `pub(crate)` so billing's
//! storage-overview lag probe uses the same walk as the Files header (same
//! hidden-file skip, same cache).

mod add;
mod asset_scope;
mod delete;
mod dir_stats;
mod exclude_match;
mod export_zip;
mod listing;
mod pathops;
mod recent;
mod rename;
mod resolve;
mod synced_state;
mod user_files;

pub use add::{AddFilesResult, AddFolderResult, add_file, add_files, add_folder};
pub use asset_scope::{allow_asset_directory, allow_asset_scope};
pub use delete::{DeleteFilesResult, FileDeleteError, FileDeleteRequest, delete_files};
pub use export_zip::export_folder_zip;
pub use listing::{FileEntry, GroupedListing, list_sync_folder, list_sync_folder_grouped, list_sync_folder_grouped_inner};
pub use recent::{RecentFile, get_recent_files};
pub use rename::{FileRenameRequest, RenameEntryResult, rename_entry};
pub use resolve::{FilePathInfo, export_file, resolve_file_info, resolve_file_path};
pub use user_files::{
    DateRangeFilter, FileFilterCriteria, LabelStats, UserFileEntry, UserFilesResult, filter_file_entries, get_user_files, search_user_files_recursive,
};

// Reachable from `crate::sync::lifecycle` as `crate::sync::files::X`, matching
// these helpers' original `pub(super)` (= `crate::sync`) visibility.
pub(in crate::sync) use add::{compute_startup_pending_summary, sum_regular_file_bytes};
pub(crate) use dir_stats::{dir_stats_for_sync_root, dir_stats_recursive};
pub(in crate::sync) use dir_stats::{invalidate_dir_stats_after_cycle, invalidate_dir_stats_under};
