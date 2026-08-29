//! Shared exclude-pattern matching for Drive listings and recent files.
//!
//! The sync engine applies globs via [`hcfs_client::drive::ExcludeRules`].
//! Listing used to compare each stored pattern with `==` on the relative
//! path, so a user-typed `*.bin` never tagged `foo.bin` (or `dir/foo.bin`)
//! as excluded — the file stayed Pending on Drive even though the engine
//! refused to upload it.
//!
//! # Semantics
//!
//! These are `globset`'s, not gitignore's, and the difference is load-bearing
//! — the UI must hide exactly what the engine skips, so this module compiles
//! the patterns the same way `ExcludeRules::parse` does and never "improves"
//! on it:
//!
//! - **Unanchored at every depth.** A pattern `p` becomes the glob `**/p`,
//!   and `**/` compiles to `(?:/?|.*/)`, i.e. zero or more leading
//!   directories. So `notes.txt` matches `notes.txt` AND `a/b/notes.txt`, and
//!   even `docs/notes.txt` matches `archive/docs/notes.txt`. Gitignore would
//!   anchor the second one to the root; this does not.
//! - **`*` crosses `/`.** `globset`'s `literal_separator` is off by default,
//!   so `*` compiles to `.*`. `build/*` therefore covers the whole subtree
//!   (`build/a/b.txt`), not just direct children.
//! - **Case-sensitive on every platform.** `*.BIN` does not match `foo.bin`,
//!   even on a case-insensitive macOS/Windows volume. Matching the engine
//!   matters more than matching the filesystem: making the listing
//!   case-insensitive here would hide files the engine still uploads.
//! - **A trailing `/` means "directory".** `node_modules/` compiles to a
//!   directory glob (`**/node_modules`) plus a contents glob
//!   (`**/node_modules/**`), so the folder and its whole subtree go. Without
//!   the slash, only a FILE named `node_modules` matches.
//! - **An uncompilable pattern matches nothing.** `ExcludeRules::parse` drops
//!   it with a `warn!` and keeps the others. `validate_pattern` refuses such a
//!   pattern at the point the user types it so this stays unreachable for
//!   anything written through the app.

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
    use proptest::prelude::*;

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

    /// Without the trailing slash the pattern is a FILE glob: it hides a file
    /// literally named `node_modules` and nothing else. Users type both forms,
    /// and the difference decides whether a 40k-file tree disappears or
    /// nothing happens at all.
    #[test]
    fn directory_name_without_trailing_slash_does_not_prune_the_subtree() {
        let rules = rules(&["node_modules"]);

        assert!(
            !path_is_excluded(&rules, "node_modules", true),
            "no trailing slash ⇒ not a directory rule"
        );
        assert!(!path_is_excluded(&rules, "node_modules/pkg/index.js", false), "the subtree stays visible");
        assert!(path_is_excluded(&rules, "node_modules", false), "a FILE with that name still matches");
    }

    /// `globset` is case-sensitive on every platform. Deliberate: the engine
    /// would still upload `foo.bin` under a `*.BIN` rule, so hiding it here
    /// would make the listing lie about what is backed up. Pinned so a
    /// well-meant "macOS is case-insensitive" change has to argue with a test.
    #[test]
    fn matching_is_case_sensitive_even_on_case_insensitive_filesystems() {
        assert!(!path_is_excluded(&rules(&["*.BIN"]), "foo.bin", false));
        assert!(!path_is_excluded(&rules(&["*.bin"]), "FOO.BIN", false));
        assert!(!path_is_excluded(&rules(&["Node_Modules/"]), "node_modules", true));
    }

    /// Patterns are NOT anchored to the drive root, even when they carry a
    /// separator — where gitignore would anchor `docs/notes.txt`, `**/`
    /// prefixing means it also matches `archive/docs/notes.txt`.
    #[test]
    fn patterns_are_unanchored_at_every_depth() {
        let bare = rules(&["notes.txt"]);
        assert!(path_is_excluded(&bare, "notes.txt", false));
        assert!(path_is_excluded(&bare, "a/b/notes.txt", false));
        assert!(!path_is_excluded(&bare, "notes.txt.bak", false));

        let nested = rules(&["docs/notes.txt"]);
        assert!(path_is_excluded(&nested, "docs/notes.txt", false));
        assert!(
            path_is_excluded(&nested, "archive/docs/notes.txt", false),
            "globset `**/` prefixing is unanchored — gitignore would anchor this one"
        );
    }

    /// `literal_separator` is off, so `*` compiles to `.*` and spans `/`.
    /// `build/*` therefore hides every file in the subtree — but NOT the
    /// `build` directory row itself, which needs the trailing-slash form.
    #[test]
    fn star_crosses_path_separators_but_does_not_hide_the_directory_row() {
        let rules = rules(&["build/*"]);

        assert!(path_is_excluded(&rules, "build/out.o", false));
        assert!(path_is_excluded(&rules, "build/deep/nested/out.o", false), "* spans `/`");
        assert!(
            !path_is_excluded(&rules, "build", true),
            "a file glob never prunes the directory — only `build/` does"
        );
    }

    /// A pattern that does not compile is dropped by the engine with a warn
    /// and matches nothing; its neighbours keep working. `validate_pattern`
    /// refuses these on the way in, so this only covers a hand-edited
    /// `.hippius/exclude`.
    #[test]
    fn uncompilable_pattern_matches_nothing_and_spares_the_others() {
        // `[` opens a character class that is never closed.
        let rules = rules(&["*.log", "[", "node_modules/"]);

        assert!(
            path_is_excluded(&rules, "app.log", false),
            "a valid pattern before the bad one still matches"
        );
        assert!(
            path_is_excluded(&rules, "project/node_modules", true),
            "a valid pattern after it still matches"
        );
        assert!(!path_is_excluded(&rules, "[", false), "the bad pattern excludes nothing, not even itself");
        assert!(!path_is_excluded(&rules, "readme.md", false));
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

    /// Drive-relative paths built from a small alphabet that mixes the names
    /// the properties below key on (`d`, `*.log`) with near-misses
    /// (`d.log`, `notd`, `a.log.bak`) the shrinker can reach.
    fn rel_path() -> impl Strategy<Value = String> {
        let component = prop::sample::select(vec!["d", "notd", "dd", "a.log", "d.log", "a.log.bak", "b.txt", "log"]);
        prop::collection::vec(component, 1..4).prop_map(|parts| parts.join("/"))
    }

    proptest! {
        /// Oracle for the extension form: because `*` spans `/` and `**/` is
        /// unanchored, `*.log` reduces to "the rel-path ends with `.log`".
        /// Anything that narrowed the match (turning on `literal_separator`,
        /// anchoring to the root, matching only the basename) breaks this.
        ///
        /// Compared as BYTES on purpose. `str::ends_with` here draws clippy's
        /// case-sensitive-extension lint, whose suggested `Path::extension`
        /// fix would be a different predicate (`a.log.bak` has extension
        /// `bak`) and whose case-insensitive advice is the opposite of what
        /// this oracle exists to detect.
        #[test]
        fn star_extension_matches_exactly_the_paths_ending_in_that_extension(rel in rel_path()) {
            let rules = rules(&["*.log"]);
            prop_assert_eq!(path_is_excluded(&rules, &rel, false), rel.as_bytes().ends_with(b".log"), "rel = {}", rel);
        }

        /// Oracle for the directory form. `d/` compiles to two globs with
        /// different jobs: `**/d` decides the FOLDER row (last component is
        /// `d`), `**/d/**` decides files (some non-final component is `d`).
        /// Together they are what makes excluding a folder hide its subtree.
        #[test]
        fn directory_rule_prunes_the_folder_row_and_everything_under_it(rel in rel_path()) {
            let rules = rules(&["d/"]);
            let components: Vec<&str> = rel.split('/').collect();
            let last_is_d = components.last() == Some(&"d");
            let has_non_final_d = components[..components.len() - 1].contains(&"d");

            prop_assert_eq!(path_is_excluded(&rules, &rel, true), last_is_d, "dir rel = {}", rel);
            prop_assert_eq!(path_is_excluded(&rules, &rel, false), has_non_final_d, "file rel = {}", rel);
        }

        /// No pattern set can hide anything when the user configured none.
        /// The fail-open direction is the safe one for a listing: showing a
        /// file the engine skipped is recoverable, hiding one it backed up
        /// is how users conclude their data is gone.
        #[test]
        fn empty_rules_never_exclude(rel in rel_path(), is_dir: bool) {
            prop_assert!(!path_is_excluded(&rules(&[]), &rel, is_dir));
        }
    }
}
