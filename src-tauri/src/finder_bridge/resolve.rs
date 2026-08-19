//! Resolve a clicked Finder path to its Hippius drive (or "outside").
//!
//! When the extension forwards an absolute path the user right-clicked, the
//! share dispatch must decide whether it lives inside one of the registered
//! sync drives — in which case the existing share engine can mint a link keyed
//! by `(folder_label, relative_path)` and record a reshare origin — or under no
//! drive, in which case the file is shared by reading its bytes directly
//! ("upload & share").
//!
//! This is the pure, sans-I/O core of that decision (no filesystem access, so
//! the Linux CI `rust` job exercises it). File-vs-folder and existence are
//! determined separately by the dispatcher via `fs::metadata`.
//!
//! ## Containment is component-level, never substring
//! Following the `validation/path_validator` exemplar: matching uses
//! [`Path::strip_prefix`] (component boundaries) and rejects any `..`
//! (`Component::ParentDir`) in the remainder. A substring/`starts_with(str)`
//! check would mismatch `/a/bc` against root `/a/b`, and a textual `..` scan
//! would false-positive on a filename like `foo..bar`.

use std::path::{Component, Path, PathBuf};

/// Where a clicked path lives relative to the registered drives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareTarget {
    /// The path is inside the drive `label`, at `relative_path` (`/`-joined,
    /// no leading slash; empty when the drive root itself was clicked).
    InDrive {
        /// The drive's sync label.
        label: String,
        /// Path relative to the drive root, suitable for the share engine.
        relative_path: String,
    },
    /// The path is under no registered drive (or cannot be expressed as a
    /// clean UTF-8 relative path) — the caller should "upload & share" it by
    /// reading its bytes directly.
    Outside,
}

/// Decide the [`ShareTarget`] for `clicked` against the registered `roots`
/// (`(label, root_path)` pairs).
///
/// The most specific (longest) containing root wins, so a drive nested inside
/// another drive's folder resolves to the inner one. A non-absolute `clicked`,
/// a remainder containing `..`, or a non-UTF-8 component all yield
/// [`ShareTarget::Outside`] — the dispatcher then shares by absolute path,
/// which still works, just without a reshare-origin record.
pub fn resolve_share_target(clicked: &Path, roots: &[(String, PathBuf)]) -> ShareTarget {
    if !clicked.is_absolute() {
        return ShareTarget::Outside;
    }
    // Track the deepest matching root by component count so nested drives pick
    // the inner one.
    let mut best: Option<(usize, String, String)> = None;
    for (label, root) in roots {
        let Ok(remainder) = clicked.strip_prefix(root) else {
            continue;
        };
        let Some(relative_path) = clean_relative(remainder) else {
            continue;
        };
        let depth = root.components().count();
        if best.as_ref().is_none_or(|(best_depth, _, _)| depth > *best_depth) {
            best = Some((depth, label.clone(), relative_path));
        }
    }
    match best {
        Some((_, label, relative_path)) => ShareTarget::InDrive { label, relative_path },
        None => ShareTarget::Outside,
    }
}

/// Render a strip-prefix remainder as a `/`-joined relative string, or `None`
/// if it contains a `..` component (traversal — reject the match) or a
/// non-UTF-8 component (the String-based share engine can't carry it).
/// `Component::CurDir` (`.`) is skipped; the remainder of a `strip_prefix`
/// never carries `RootDir`/`Prefix`.
fn clean_relative(remainder: &Path) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for component in remainder.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_str()?),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(pairs: &[(&str, &str)]) -> Vec<(String, PathBuf)> {
        pairs.iter().map(|(l, p)| ((*l).to_string(), PathBuf::from(p))).collect()
    }

    #[test]
    fn file_inside_a_drive_resolves_to_label_and_relative() {
        let r = roots(&[("docs", "/Users/me/Hippius")]);
        assert_eq!(
            resolve_share_target(Path::new("/Users/me/Hippius/notes/a.txt"), &r),
            ShareTarget::InDrive {
                label: "docs".into(),
                relative_path: "notes/a.txt".into()
            }
        );
    }

    #[test]
    fn clicking_the_drive_root_yields_empty_relative() {
        let r = roots(&[("docs", "/Users/me/Hippius")]);
        assert_eq!(
            resolve_share_target(Path::new("/Users/me/Hippius"), &r),
            ShareTarget::InDrive {
                label: "docs".into(),
                relative_path: String::new()
            }
        );
    }

    #[test]
    fn nested_drives_pick_the_most_specific_root() {
        let r = roots(&[("outer", "/a"), ("inner", "/a/b")]);
        assert_eq!(
            resolve_share_target(Path::new("/a/b/c.txt"), &r),
            ShareTarget::InDrive {
                label: "inner".into(),
                relative_path: "c.txt".into()
            }
        );
    }

    #[test]
    fn sibling_prefix_is_not_a_containment_match() {
        // `/a/bcd` must NOT match root `/a/b` (component-level, not substring).
        let r = roots(&[("b", "/a/b")]);
        assert_eq!(resolve_share_target(Path::new("/a/bcd/x"), &r), ShareTarget::Outside);
    }

    #[test]
    fn path_under_no_root_is_outside() {
        let r = roots(&[("docs", "/Users/me/Hippius")]);
        assert_eq!(resolve_share_target(Path::new("/tmp/elsewhere.pdf"), &r), ShareTarget::Outside);
    }

    #[test]
    fn relative_clicked_path_is_outside() {
        let r = roots(&[("docs", "/Users/me/Hippius")]);
        assert_eq!(resolve_share_target(Path::new("relative/x"), &r), ShareTarget::Outside);
    }

    #[test]
    fn parent_dir_in_remainder_is_rejected() {
        // A non-normalized clicked path escaping via `..` must not resolve in-drive.
        let r = roots(&[("docs", "/Users/me/Hippius")]);
        assert_eq!(resolve_share_target(Path::new("/Users/me/Hippius/../secret"), &r), ShareTarget::Outside);
    }

    #[test]
    fn cur_dir_components_are_normalized_away() {
        let r = roots(&[("docs", "/Users/me/Hippius")]);
        assert_eq!(
            resolve_share_target(Path::new("/Users/me/Hippius/./a/./b.txt"), &r),
            ShareTarget::InDrive {
                label: "docs".into(),
                relative_path: "a/b.txt".into()
            }
        );
    }

    #[test]
    fn dotdot_inside_a_filename_is_a_normal_component() {
        // `foo..bar` is one legitimate filename, not a traversal.
        let r = roots(&[("docs", "/d")]);
        assert_eq!(
            resolve_share_target(Path::new("/d/foo..bar"), &r),
            ShareTarget::InDrive {
                label: "docs".into(),
                relative_path: "foo..bar".into()
            }
        );
    }

    #[test]
    fn empty_roots_is_always_outside() {
        assert_eq!(resolve_share_target(Path::new("/a/b"), &[]), ShareTarget::Outside);
    }

    proptest::proptest! {
        // For any drive root and clean relative path, joining them and resolving
        // recovers exactly that (label, relative_path).
        #[test]
        fn in_drive_round_trips(
            root_segs in proptest::collection::vec("[a-zA-Z0-9_]{1,8}", 1..4),
            rel_segs in proptest::collection::vec("[a-zA-Z0-9_]{1,8}", 1..4),
        ) {
            let mut root = PathBuf::from("/");
            for seg in &root_segs {
                root.push(seg);
            }
            let mut clicked = root.clone();
            for seg in &rel_segs {
                clicked.push(seg);
            }
            let r = vec![("drive".to_string(), root)];
            proptest::prop_assert_eq!(
                resolve_share_target(&clicked, &r),
                ShareTarget::InDrive { label: "drive".into(), relative_path: rel_segs.join("/") }
            );
        }
    }
}
