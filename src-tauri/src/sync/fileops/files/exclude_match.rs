//! Shared exclude-pattern matching for Drive listings and recent files.
//!
//! The sync engine applies gitignore-style globs via
//! [`hcfs_client::drive::ExcludeRules`]. Listing used to compare each stored
//! pattern with `==` on the relative path, so a user-typed `*.bin` never
//! tagged `foo.bin` (or `dir/foo.bin`) as excluded — the file stayed Pending
//! on Drive even though the engine refused to upload it.

use hcfs_client::drive::ExcludeRules;
use std::path::Path;

/// Compile stored exclude patterns the same way the engine compiles
/// `.hippius/exclude`.
pub(super) fn rules_from_patterns(patterns: &[String]) -> ExcludeRules {
    if patterns.is_empty() {
        return ExcludeRules::empty();
    }
    ExcludeRules::parse(&patterns.join("\n"))
}

/// Whether `rel_path` is excluded under `rules`.
///
/// `is_dir` must match the engine walk: a trailing-slash pattern only
/// matches directories; a file glob only matches files.
pub(super) fn path_is_excluded(rules: &ExcludeRules, rel_path: &str, is_dir: bool) -> bool {
    if rules.is_empty() {
        return false;
    }
    rules.is_excluded(Path::new(rel_path), is_dir)
}

/// Read-time filter for the recent-files activity feed.
///
/// Returns `true` when this drive has compiled rules and `rel_path` matches
/// them as a file. Activity history is not deleted — the row is only omitted
/// from the feed.
pub(super) fn recent_rel_path_is_excluded(rules: Option<&ExcludeRules>, rel_path: &str) -> bool {
    match rules {
        Some(rules) => path_is_excluded(rules, rel_path, false),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{path_is_excluded, recent_rel_path_is_excluded, rules_from_patterns};

    fn rules(patterns: &[&str]) -> hcfs_client::drive::ExcludeRules {
        rules_from_patterns(&patterns.iter().map(|p| (*p).to_string()).collect::<Vec<_>>())
    }

    /// `*.bin` is the reported glob: engine skips `foo.bin` at any depth, and
    /// gitignore/globset does not treat `foo.bin.bak` as a `*.bin` match.
    #[test]
    fn star_bin_matches_foo_bin_at_any_depth_not_bin_bak() {
        let rules = rules(&["*.bin"]);

        assert!(
            path_is_excluded(&rules, "foo.bin", false),
            "*.bin must match foo.bin (engine ExcludeRules semantics)"
        );
        assert!(
            path_is_excluded(&rules, "dir/foo.bin", false),
            "*.bin must match dir/foo.bin, not only the drive root"
        );
        assert!(
            !path_is_excluded(&rules, "foo.bin.bak", false),
            "*.bin must not match foo.bin.bak unless gitignore/globset says so"
        );
    }

    #[test]
    fn directory_trailing_slash_matches_the_dir_and_files_inside() {
        let rules = rules(&["node_modules/"]);

        assert!(path_is_excluded(&rules, "node_modules", true));
        assert!(path_is_excluded(&rules, "project/node_modules", true));
        assert!(path_is_excluded(&rules, "node_modules/pkg/index.js", false));
        assert!(!path_is_excluded(&rules, "node_modules", false));
    }

    #[test]
    fn empty_rules_exclude_nothing() {
        let rules = rules(&[]);
        assert!(!path_is_excluded(&rules, "foo.bin", false));
        assert!(!recent_rel_path_is_excluded(None, "foo.bin"));
    }

    #[test]
    fn recent_feed_drops_glob_matches_and_keeps_non_matches() {
        let rules = rules(&["*.bin"]);

        assert!(recent_rel_path_is_excluded(Some(&rules), "foo.bin"));
        assert!(recent_rel_path_is_excluded(Some(&rules), "dir/foo.bin"));
        assert!(!recent_rel_path_is_excluded(Some(&rules), "foo.bin.bak"));
        assert!(!recent_rel_path_is_excluded(None, "foo.bin"));
    }
}
