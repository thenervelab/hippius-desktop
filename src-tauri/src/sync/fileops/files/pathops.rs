//! Shared, leaf-level path helpers for the files submodules: containment
//! check (`ensure_within`), sync-relative name derivation
//! (`derive_relative_name`), and recursive copy (`copy_dir_recursive`). Kept in
//! a dependency-free leaf so the sibling submodules form a DAG rather than an
//! `add` <-> `resolve` cycle. All are `pub(super)`, reached via
//! `super::pathops::<helper>`.

use crate::error::Result;
use std::path::{Path, PathBuf};

/// Verify that `child` is contained within `parent` after canonicalization.
/// Delegates to hcfs-client library.
pub(super) fn ensure_within(parent: &Path, child: &Path) -> Result<PathBuf> {
    // A containment failure means `child` escapes `parent` — a path-boundary
    // (security) reject → Validation, not the catch-all Other.
    hcfs_client::drive::files::ensure_within(parent, child).map_err(|e| crate::error::AppError::Validation(e.to_string()))
}

/// Derive a file's path relative to the sync root.
///
/// If `source` starts with `sync_path/`, strips the prefix to get the
/// relative path (e.g., `/home/user/Hippius/docs/file.txt` → `docs/file.txt`).
/// Otherwise returns `fallback_name` as-is.
pub(super) fn derive_relative_name(sync_path: &str, source: Option<&str>, fallback_name: &str) -> String {
    if let Some(src) = source
        && !sync_path.is_empty()
    {
        let prefix = if sync_path.ends_with('/') {
            sync_path.to_string()
        } else {
            format!("{sync_path}/")
        };
        if src.starts_with(&prefix) {
            return src[prefix.len()..].to_string();
        }
    }
    fallback_name.to_string()
}

/// Delegates to hcfs-client library.
pub(super) async fn copy_dir_recursive(src: &Path, dst: &Path, depth: u32) -> Result<()> {
    // A recursive-copy failure surfaces from the hcfs-client fs layer → Hcfs
    // (keeps the descriptive message), not the catch-all Other.
    hcfs_client::drive::files::copy_dir_recursive(src, dst, depth)
        .await
        .map_err(|e| crate::error::AppError::Hcfs(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_sync_path_prefix() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius", Some("/home/user/Hippius/docs/file.txt"), "fallback.txt"),
            "docs/file.txt",
        );
    }

    #[test]
    fn strips_prefix_with_trailing_slash() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius/", Some("/home/user/Hippius/file.txt"), "fallback.txt"),
            "file.txt",
        );
    }

    #[test]
    fn falls_back_when_source_doesnt_match() {
        assert_eq!(
            derive_relative_name("/home/user/Hippius", Some("/other/path/file.txt"), "fallback.txt"),
            "fallback.txt",
        );
    }

    #[test]
    fn falls_back_when_no_source() {
        assert_eq!(derive_relative_name("/home/user/Hippius", None, "fallback.txt"), "fallback.txt",);
    }

    #[test]
    fn falls_back_when_empty_sync_path() {
        assert_eq!(derive_relative_name("", Some("/some/path/file.txt"), "fallback.txt"), "fallback.txt",);
    }

    #[test]
    fn handles_nested_subfolder() {
        assert_eq!(derive_relative_name("/sync", Some("/sync/a/b/c/deep.txt"), "x.txt"), "a/b/c/deep.txt",);
    }
}
