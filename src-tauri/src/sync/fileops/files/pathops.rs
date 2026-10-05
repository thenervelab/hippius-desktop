//! Shared, leaf-level path helpers for the files submodules: containment
//! check (`ensure_within`), sync-relative name derivation
//! (`derive_relative_name`), recursive copy (`copy_dir_recursive`), the
//! engine's hidden-name rule (`is_engine_hidden_name`), and the child filter
//! every tree upload shares (`visible_children`, `pub(crate)`). Kept in a
//! dependency-free leaf so the sibling submodules form a DAG rather than an
//! `add` <-> `resolve` cycle. The rest are `pub(super)`, reached via
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
// `pub(in crate::sync::fileops)` rather than `pub(super)`: the remote
// upload walk is a sibling of `files` and must skip exactly the names the
// engine skips, so a folder uploaded to the server and the same folder
// synced locally produce one file set.
pub(in crate::sync::fileops) fn is_engine_hidden_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|n| n.starts_with('.'))
}

/// What a visible directory child is.
#[derive(Debug)]
pub(crate) enum VisibleKind {
    Dir,
    /// A regular file and its length when it was listed.
    File {
        size: u64,
    },
    /// Listed, but its type could not be read (a folder that can be listed
    /// but not entered, a lost privacy grant). A share must refuse it by
    /// name; a drive upload skips it, since its files are independent.
    Unreadable {
        error: std::io::Error,
    },
    /// A file or folder whose name is not valid UTF-8. Wire paths are
    /// strings, so it has no spelling there; `VisibleEntry::name` carries
    /// the lossy form for a message. APFS stores only UTF-8, so on macOS
    /// this never occurs.
    NotText,
}

/// One child of a directory that an upload of the tree carries.
#[derive(Debug)]
pub(crate) struct VisibleEntry {
    /// UTF-8 name; lossy for [`VisibleKind::NotText`] only.
    pub name: String,
    pub path: PathBuf,
    pub kind: VisibleKind,
}

/// The children of `dir` that an upload of the tree carries, in `read_dir`
/// order.
///
/// One definition for every walk that uploads a local tree (a folder upload
/// into a drive, a folder shared as an uploaded copy), so each holds the
/// file set the engine would sync:
/// - dot-names are skipped ([`is_engine_hidden_name`]);
/// - symlinks and special files are skipped: `DirEntry::metadata` does not
///   follow links, so a link is neither file nor dir, which also keeps a
///   link cycle from ever being walked;
/// - an entry that vanished between `read_dir` and its stat (`NotFound`) is
///   skipped; any other stat failure is reported as
///   [`VisibleKind::Unreadable`], so a caller that must not lose an item
///   silently can refuse it by name;
/// - a non-UTF-8 name is reported as [`VisibleKind::NotText`].
///
/// At most `limit` children are returned: listing stops there, so a caller
/// that refuses past a count does not stat a million-entry folder first.
///
/// # Errors
///
/// The `read_dir` of `dir` itself, or an error reading its next entry
/// (that is the directory failing to list, and no name exists to report).
/// The caller decides whether an unreadable directory is skippable (drive
/// upload) or fatal (a share must not silently drop a subfolder).
pub(crate) fn visible_children(dir: &Path, limit: usize) -> std::io::Result<Vec<VisibleEntry>> {
    let mut children = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        if children.len() >= limit {
            break;
        }
        let entry = entry?;
        let name = entry.file_name();
        if is_engine_hidden_name(&name) {
            continue;
        }

        let kind = match entry.metadata() {
            Ok(meta) if meta.is_dir() => VisibleKind::Dir,
            Ok(meta) if meta.is_file() => VisibleKind::File { size: meta.len() },
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => VisibleKind::Unreadable { error },
        };
        let (name, kind) = match name.to_str() {
            Some(name) => (name.to_owned(), kind),
            None => (name.to_string_lossy().into_owned(), VisibleKind::NotText),
        };
        children.push(VisibleEntry {
            name,
            path: entry.path(),
            kind,
        });
    }
    Ok(children)
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

    /// Listing stops at the limit, so a capped walk never stats the rest of
    /// a huge folder.
    #[test]
    fn visible_children_stops_at_the_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}")), b"x").expect("file");
        }

        assert_eq!(visible_children(dir.path(), 2).expect("list").len(), 2);
        assert_eq!(visible_children(dir.path(), usize::MAX).expect("list").len(), 5);
    }

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
