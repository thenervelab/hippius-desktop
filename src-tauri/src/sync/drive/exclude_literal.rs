//! Exclude a *specific file* from sync, as opposed to a user-typed glob.
//!
//! `.hippius/exclude` holds globs: hcfs-client compiles every line as
//! `**/{line}` through `globset`. The Sync Issues dialog used to write the
//! failed file's relative path onto that file verbatim, so the path was read
//! as a pattern, not a name. `Movies/Blade Runner [2049].mkv` became a
//! character class that never matched the file and *did* match
//! `Movies/Blade Runner 2.mkv`; an unclosed `[` was rejected by the engine and
//! listed as an active rule that excluded nothing. The toast said "excluded",
//! the file was re-planned on the next cycle, and the dialog came back.
//!
//! Everything that means "this one file" goes through [`literal_pattern`] on
//! the way in and the same function on the way out, so an add and its later
//! remove agree on the stored line. The Settings editor lists stored lines
//! through [`display_pattern`], which undoes the escaping so the user sees
//! the file name they clicked on, while removal still uses the stored line.
//!
//! Two limits inherited from the exclude-file format, both documented rather
//! than worked around: a path with leading or trailing whitespace is trimmed
//! by the engine's writer and cannot be excluded literally, and a backslash
//! in a name is glob syntax on Unix and is not escaped by `globset::escape`.

use hcfs_client::engine::DriveManager;
use serde::Serialize;

/// One stored exclude line, shaped for the Settings editor.
///
/// `pattern` is the line as written in `.hippius/exclude` and is the key a
/// removal must send back. `display` is what to show: the file name for a
/// literal exclusion, the pattern itself for a user-typed glob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludePatternEntry {
    pub pattern: String,
    pub display: String,
}

/// Characters `globset::escape` wraps in a one-character class, plus `#`,
/// which `ExcludeRules::parse` treats as a comment marker at line start.
const ESCAPED_CHARS: [char; 7] = ['?', '*', '[', ']', '{', '}', '#'];

/// Turn a relative path into an exclude line that matches only that path.
///
/// Identity for a name with no glob syntax, so lines older builds wrote for
/// plain names are still found by [`remove_literal_exclusion`].
pub fn literal_pattern(rel_path: &str) -> String {
    let escaped = globset::escape(rel_path);
    match escaped.strip_prefix('#') {
        Some(rest) => format!("[#]{rest}"),
        None => escaped,
    }
}

/// The user-facing form of a stored exclude line: a literal exclusion reads
/// back as the file name, anything else as typed.
///
/// A user-typed one-character class such as `[*]` is indistinguishable from
/// an escaped `*` and displays as `*`; removal still uses the stored line, so
/// nothing is lost.
pub fn display_pattern(stored: &str) -> String {
    let chars: Vec<char> = stored.chars().collect();
    let mut out = String::with_capacity(stored.len());
    let mut i = 0;

    while i < chars.len() {
        let escaped = chars.get(i + 2) == Some(&']') && chars[i] == '[' && chars.get(i + 1).is_some_and(|c| ESCAPED_CHARS.contains(c));
        if escaped {
            out.push(chars[i + 1]);
            i += 3;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }

    out
}

/// Pair every stored line with its display form for the Settings editor.
pub fn entries_from_patterns(patterns: Vec<String>) -> Vec<ExcludePatternEntry> {
    patterns
        .into_iter()
        .map(|pattern| ExcludePatternEntry {
            display: display_pattern(&pattern),
            pattern,
        })
        .collect()
}

/// Exclude exactly `rel_path` on `manager`'s drive. `Ok(false)` means the
/// line was already present.
pub fn exclude_path_literally(manager: &DriveManager, rel_path: &str) -> Result<bool, String> {
    manager.add_exclude_pattern(&literal_pattern(rel_path))
}

/// Undo [`exclude_path_literally`]. Also drops a raw copy of the path, which
/// a build before the escaping wrote and which may be excluding a different
/// file. `Ok(false)` means neither line was present.
pub fn remove_literal_exclusion(manager: &DriveManager, rel_path: &str) -> Result<bool, String> {
    let literal = literal_pattern(rel_path);
    let removed_literal = manager.remove_exclude_pattern(&literal)?;
    if literal == rel_path {
        return Ok(removed_literal);
    }

    let removed_raw = manager.remove_exclude_pattern(rel_path)?;
    Ok(removed_literal || removed_raw)
}
#[cfg(test)]
mod tests {
    use super::*;
    use hcfs_client::drive::ExcludeRules;
    use proptest::prelude::*;
    use std::path::Path;

    const BRACKETED: &str = "Movies/Blade Runner [2049].mkv";
    const SIBLING: &str = "Movies/Blade Runner 2.mkv";

    fn engine_excludes(pattern: &str, rel_path: &str) -> bool {
        ExcludeRules::parse(pattern).is_excluded(Path::new(rel_path), false)
    }

    #[test]
    fn literal_pattern_of_a_bracketed_name_excludes_that_file_and_not_its_sibling() {
        // The raw path is the bug: `[2049]` is a character class.
        assert!(!engine_excludes(BRACKETED, BRACKETED), "raw path must not match itself");
        assert!(engine_excludes(BRACKETED, SIBLING), "raw path matches the wrong file");

        let literal = literal_pattern(BRACKETED);
        assert!(engine_excludes(&literal, BRACKETED));
        assert!(!engine_excludes(&literal, SIBLING));
    }

    #[test]
    fn literal_pattern_of_an_unclosed_bracket_compiles_and_matches() {
        let name = "Docs/unclosed [bracket.pdf";
        assert!(!engine_excludes(name, name), "the engine drops the raw line");
        assert!(engine_excludes(&literal_pattern(name), name));
    }

    #[test]
    fn literal_pattern_of_a_plain_path_is_the_path_itself() {
        // Older builds wrote plain names verbatim; a retry must still find
        // those lines, so escaping has to be the identity when nothing needs
        // escaping.
        assert_eq!(literal_pattern("Music/plain name.flac"), "Music/plain name.flac");
    }

    #[test]
    fn literal_pattern_of_a_hash_prefixed_name_is_not_a_comment() {
        // `#` at the start of a line is a comment to the engine's parser.
        let name = "#notes.txt";
        assert!(!engine_excludes(name, name));
        assert!(engine_excludes(&literal_pattern(name), name));
    }

    #[test]
    fn display_pattern_undoes_literal_pattern_and_leaves_user_globs_alone() {
        for name in [BRACKETED, "Shows/Ep 01 {final}.mp4", "Photos/IMG_0001?.jpg", "#notes.txt"] {
            assert_eq!(display_pattern(&literal_pattern(name)), name);
        }
        for glob in ["*.log", "node_modules/", "[abc].txt", "build/*"] {
            assert_eq!(display_pattern(glob), glob);
        }
    }

    #[test]
    fn entries_pair_each_stored_line_with_its_display_form() {
        let stored = vec![literal_pattern(BRACKETED), "*.log".to_string()];
        let entries = entries_from_patterns(stored.clone());
        assert_eq!(
            entries,
            vec![
                ExcludePatternEntry {
                    pattern: stored[0].clone(),
                    display: BRACKETED.to_string(),
                },
                ExcludePatternEntry {
                    pattern: "*.log".to_string(),
                    display: "*.log".to_string(),
                },
            ]
        );
    }

    fn temp_manager() -> (tempfile::TempDir, DriveManager) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_dir = tmp.path().join(".hippius");
        std::fs::create_dir_all(&config_dir).expect("config dir");
        let manager = DriveManager::new(tmp.path().to_path_buf(), config_dir);
        (tmp, manager)
    }

    #[test]
    fn excluding_a_path_literally_is_what_the_engine_then_skips() {
        let (_tmp, manager) = temp_manager();

        assert!(exclude_path_literally(&manager, BRACKETED).expect("write"));
        assert!(manager.is_excluded(Path::new(BRACKETED), false));
        assert!(!manager.is_excluded(Path::new(SIBLING), false));

        // Idempotent: the second write reports "already present".
        assert!(!exclude_path_literally(&manager, BRACKETED).expect("rewrite"));
        assert_eq!(manager.list_exclude_patterns().len(), 1);
    }

    #[test]
    fn removing_a_literal_exclusion_lets_the_engine_see_the_file_again() {
        let (_tmp, manager) = temp_manager();
        exclude_path_literally(&manager, BRACKETED).expect("write");

        assert!(remove_literal_exclusion(&manager, BRACKETED).expect("remove"));
        assert!(!manager.is_excluded(Path::new(BRACKETED), false));
        assert!(manager.list_exclude_patterns().is_empty());
    }

    #[test]
    fn removing_a_literal_exclusion_also_drops_a_raw_line_an_older_build_wrote() {
        // A raw bracketed line excludes the wrong sibling; Retry must clear
        // it even though this build would never have written it.
        let (_tmp, manager) = temp_manager();
        manager.add_exclude_pattern(BRACKETED).expect("legacy raw line");
        assert!(manager.is_excluded(Path::new(SIBLING), false));

        assert!(remove_literal_exclusion(&manager, BRACKETED).expect("remove"));
        assert!(manager.list_exclude_patterns().is_empty());
        assert!(!manager.is_excluded(Path::new(SIBLING), false));
    }

    #[test]
    fn removing_an_absent_literal_exclusion_reports_nothing_removed() {
        let (_tmp, manager) = temp_manager();
        assert!(!remove_literal_exclusion(&manager, BRACKETED).expect("remove"));
    }

    /// Relative paths the way the planner emits them: posix separators, no
    /// leading slash, no `.`/`..` components, and — because the engine's
    /// writer trims each line — no leading or trailing whitespace. Segments
    /// deliberately mix glob metacharacters, `#`, spaces, and non-ASCII.
    fn rel_path() -> impl Strategy<Value = String> {
        let segment = "[A-Za-z0-9é_.(){}\\[\\]*?#-][A-Za-z0-9é _.(){}\\[\\]*?#-]{0,10}[A-Za-z0-9é_.(){}\\[\\]*?#-]"
            .prop_filter("no dot-only segments", |s| s != "." && s != "..");
        prop::collection::vec(segment, 1..=3).prop_map(|segs| segs.join("/"))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        #[test]
        fn a_literal_pattern_excludes_exactly_its_own_path(rel in rel_path()) {
            let literal = literal_pattern(&rel);
            prop_assert!(engine_excludes(&literal, &rel), "{literal:?} must match {rel:?}");
        }

        #[test]
        fn display_round_trips_every_literal_pattern(rel in rel_path()) {
            prop_assert_eq!(display_pattern(&literal_pattern(&rel)), rel);
        }
    }
}
