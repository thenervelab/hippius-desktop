//! Shared, leaf-level path helpers for the files submodules: containment
//! check (`ensure_within`), sync-relative name derivation
//! (`derive_relative_name`), recursive copy (`copy_dir_recursive`), and the
//! engine's hidden-name rule (`is_engine_hidden_name`). Kept in a
//! dependency-free leaf so the sibling submodules form a DAG rather than an
//! `add` <-> `resolve` cycle. All are `pub(super)`, reached via
//! `super::pathops::<helper>`.

use crate::error::Result;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Local mirror of hcfs-client's `drive::exclude::should_skip_path` — the rule
/// its real `Drive::collect_files` scan applies: skip the `.hippius` config dir
/// and every `.`-prefixed name, files and directories alike. Upstream is
/// `pub(super)`, hence re-derived rather than called.
///
/// The rule is the leading dot on EVERY platform, not an OS "hidden" notion.
/// Windows sets hidden via `FILE_ATTRIBUTE_HIDDEN` and its dotfiles are not
/// hidden, but the engine and the Drive listing both key off the dot there too,
/// so a name-based rule is what keeps the three in agreement.
///
/// `to_str()`-gated on purpose, matching upstream exactly: a non-UTF-8 name is
/// NOT skipped, so the engine uploads it. A lossy conversion here would drop
/// such a name from Drive (and from File No) while the engine still syncs it,
/// which is a silent split. Listing a UTF-8 hidden file as Pending would
/// pin it forever (H-063) — the engine never uploads it. Drive lists it
/// as `hidden` instead, except for internal names
/// ([`is_internal_hidden_name`]).
pub(super) fn is_engine_hidden_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|n| n.starts_with('.'))
}

/// Engine-owned names that must never appear in Drive: the `.hippius`
/// config dir and in-flight `.hippius-incoming-*` staging copies.
/// User dotfiles (`.env.qa`, `.hidden`) are listed as `hidden`.
pub(super) fn is_internal_hidden_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|n| n == ".hippius" || n.starts_with(".hippius-incoming-"))
}

/// True when any path component is an engine-hidden name.
///
/// Overlay keys are UTF-8 `String`s, so this is the same rule as
/// [`is_engine_hidden_name`] for every name the rel-path index can hold.
/// Applied to the server overlay so a `.env.qa` already in `synced_paths`
/// cannot reappear as Pending after the disk walk skipped it (H-063).
pub(super) fn rel_has_engine_hidden_component(rel: &str) -> bool {
    rel.split('/').any(|part| !part.is_empty() && is_engine_hidden_name(OsStr::new(part)))
}

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
    use std::ffi::OsStr;

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

    /// The dot rule is name-based on every platform, deliberately: Windows
    /// marks hidden with `FILE_ATTRIBUTE_HIDDEN` and treats dotfiles as
    /// ordinary, but hcfs-client's scan and the Drive listing both key off the
    /// dot there too. Counting by an OS-hidden notion would desync all three.
    #[test]
    fn is_engine_hidden_name_is_the_dot_rule_on_every_platform() {
        assert!(is_engine_hidden_name(OsStr::new(".DS_Store")));
        assert!(is_engine_hidden_name(OsStr::new(".hippius")));
        assert!(is_engine_hidden_name(OsStr::new(".env.qa")));
        assert!(is_engine_hidden_name(OsStr::new(".hidden")));
        assert!(is_engine_hidden_name(OsStr::new(".hippius-incoming-Photos-1")));
        assert!(is_internal_hidden_name(OsStr::new(".hippius")));
        assert!(is_internal_hidden_name(OsStr::new(".hippius-incoming-Photos-1")));
        assert!(!is_internal_hidden_name(OsStr::new(".env.qa")));
        assert!(!is_internal_hidden_name(OsStr::new(".hidden")));

        // Windows-hidden names carry no dot — the engine uploads them, so
        // listing and File No must include them.
        assert!(!is_engine_hidden_name(OsStr::new("desktop.ini")));
        assert!(!is_engine_hidden_name(OsStr::new("Thumbs.db")));
        assert!(!is_engine_hidden_name(OsStr::new("Preview.app")));
        assert!(!is_engine_hidden_name(OsStr::new("notes.txt")));
    }

    #[test]
    fn empty_name_is_not_hidden() {
        assert!(!is_engine_hidden_name(OsStr::new("")));
    }

    /// The `to_str()` gate is the whole helper. A lossy `.`-prefix check
    /// would skip this name; the engine uploads it.
    #[cfg(unix)]
    #[test]
    fn non_utf8_dot_prefix_is_not_hidden() {
        use std::os::unix::ffi::OsStrExt;

        assert!(
            !is_engine_hidden_name(OsStr::from_bytes(b".caf\xe9")),
            "engine uploads a non-UTF-8 `.`-name; lossy would skip it"
        );
        assert!(!is_engine_hidden_name(OsStr::from_bytes(&[0x2E, 0xFF])));
    }

    #[test]
    fn rel_hidden_component_matches_dot_segments_only() {
        assert!(rel_has_engine_hidden_component(".env.qa"));
        assert!(rel_has_engine_hidden_component(".hidden_dir/inside.txt"));
        assert!(rel_has_engine_hidden_component("keep/.env.qa"));
        assert!(!rel_has_engine_hidden_component("keep.txt"));
        assert!(!rel_has_engine_hidden_component("keep/notes.txt"));
        assert!(!rel_has_engine_hidden_component(""));
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
