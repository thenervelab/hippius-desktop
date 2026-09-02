//! Tauri IPC commands for managing per-drive exclusion patterns.
//!
//! These commands expose hcfs-client's glob-based file/directory exclusion
//! API. Patterns are stored in `.hippius/{label}/exclude` (one per line,
//! gitignore-style) and are applied during `scan_local_files`.

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::exclude_literal::{ExcludePatternEntry, entries_from_patterns, exclude_path_literally, literal_pattern, remove_literal_exclusion};
use hcfs_client::engine::DriveManager;
use hcfs_client::engine::runner::trigger_sync;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, info, warn};

/// Kick a listing refresh and a sync cycle after an exclude-rule edit.
///
/// `apply_sync_selection` already did this; add/remove used to write the
/// file and return, so Drive stayed Pending until a manual refresh.
/// `hcfs_activity_updated` is the listing-refresh event `useSyncEvents`
/// already folds into `sync_files_completed_changed`.
///
/// A failed emit is non-fatal — the rule is already written and the next
/// listing picks it up — but it must not pass silently: with the error
/// swallowed it reads back to us as "the list just doesn't refresh" and there
/// is nothing in the support bundle to say otherwise.
///
/// `trigger_sync`'s `bool` is "did any drive actually sync", not success:
/// `false` is the ordinary "nothing to do" answer, so it is discarded.
async fn trigger_sync_after_exclude_edit(app: &AppHandle, label: &str) {
    if let Err(e) = app.emit(
        crate::sync::events::ACTIVITY_UPDATED,
        crate::sync::events::LabelPayload { label: label.to_string() },
    ) {
        warn!(label = %label, error = %e, "Failed to emit activity-updated after exclude edit — Drive refreshes on the next listing instead");
    }

    let sync = app.state::<crate::app_state::AppState>().sync.clone();
    let _ = trigger_sync(&sync).await;
}

/// Validate and trim an exclusion pattern.
///
/// Rejects empty/whitespace-only patterns and any pattern containing a `..`
/// path component (path traversal). Returns the trimmed pattern on success.
///
/// The component check splits on both `/` and `\` so it catches cases a bare
/// `contains("../")` substring test cannot: the Windows separator (`..\`), a
/// trailing `foo/..`, and a bare `..`. Exclusion patterns are
/// gitignore-style globs matched against relative paths, so a `..` component
/// can never be legitimate — rejecting all of them is both safe and complete.
///
/// Embedded newlines are rejected too: hcfs-client's `ExcludeRules::parse`
/// splits the on-disk exclude file with `lines()`, so a single call must carry
/// exactly one pattern — a `"foo\n..\nbar"` string would otherwise smuggle a
/// standalone `..` rule past this per-pattern check onto its own line.
fn validate_pattern(pattern: &str) -> Result<String> {
    let trimmed = pattern.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Validation("Pattern cannot be empty".into()));
    }
    if trimmed.contains(['\n', '\r']) {
        return Err(AppError::Validation("Pattern cannot contain newlines (one pattern per call)".into()));
    }
    if trimmed.split(['/', '\\']).any(|component| component == "..") {
        return Err(AppError::Validation(
            "Pattern cannot contain '..' path components (path traversal)".into(),
        ));
    }
    if matches_everything(&trimmed) {
        return Err(AppError::Validation(
            "Pattern would exclude the entire folder — nothing would sync. Use a more specific pattern.".into(),
        ));
    }
    if let Err(e) = compile_like_the_engine(&trimmed) {
        return Err(AppError::Validation(format!(
            "Not a valid pattern: {e}. Try something like *.log, build/, or notes.txt."
        )));
    }
    Ok(trimmed)
}

/// Compile `pattern` exactly as `ExcludeRules::parse` will, and report why
/// it cannot be.
///
/// `ExcludeRules::parse` drops an uncompilable line with a `warn!` and keeps
/// the rest, so an unclosed `[` used to be accepted here, written to
/// `.hippius/exclude`, listed back by `list_exclude_patterns` as an active
/// rule — and match nothing, forever, with the only trace in a log file.
/// Refusing it at the point the user types it turns a silent no-op into an
/// error next to the input box. The expansions must stay in step with
/// upstream: file patterns become `**/{p}`, a trailing-slash pattern becomes
/// both `**/{dir}` and `**/{dir}/**`.
fn compile_like_the_engine(pattern: &str) -> std::result::Result<(), globset::Error> {
    match pattern.strip_suffix('/') {
        Some(dir) => {
            globset::Glob::new(&format!("**/{dir}"))?;
            globset::Glob::new(&format!("**/{dir}/**"))?;
        }
        None => {
            globset::Glob::new(&format!("**/{pattern}"))?;
        }
    }
    Ok(())
}

/// Whether a pattern matches every path in the drive.
///
/// Such a pattern silently stops the whole drive from syncing: files simply
/// never upload again, with no error raised and nothing in the UI to explain
/// it. That was unreachable while exclusions were only set by the folder
/// browser, but the per-drive editor lets a user type `*`, so refuse it here —
/// in Rust, next to the rest of the pattern rules, rather than in the dialog.
///
/// Deliberately conservative: only patterns made ENTIRELY of `*` and `/`
/// separators qualify. Anything carrying a literal character (`a*b`,
/// `build/*.log`) constrains the match and is the user's call.
fn matches_everything(pattern: &str) -> bool {
    !pattern.is_empty() && pattern.chars().all(|c| matches!(c, '*' | '/' | '\\'))
}

/// List all active exclusion patterns for a drive, each paired with the form
/// to show the user (a literal exclusion reads back as its file name).
///
/// Grabs the per-drive Arc from the drives map (microsecond outer lock),
/// then locks the manager to read patterns. Returns an empty list if the
/// drive does not exist.
#[tauri::command]
pub async fn list_exclude_patterns(label: String, app_state: tauri::State<'_, AppState>) -> Result<Vec<ExcludePatternEntry>> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        debug!(label = %label, "Drive not found, returning empty patterns");
        return Ok(Vec::new());
    };

    let manager = arc.lock().await;
    let patterns = manager.list_exclude_patterns();
    debug!(
        label = %label,
        count = patterns.len(),
        "Listed exclude patterns",
    );
    Ok(entries_from_patterns(patterns))
}

/// Add an exclusion pattern to a drive.
///
/// Validates the pattern (rejects empty, whitespace-only, or path-traversal
/// patterns), then delegates to `Drive::add_exclude_pattern`. Returns `true`
/// if the pattern was added, `false` if it already existed.
#[tauri::command]
pub async fn add_exclude_pattern(label: String, pattern: String, app_state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool> {
    let trimmed = validate_pattern(&pattern)?;

    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;
    let added = manager.add_exclude_pattern(&trimmed).map_err(AppError::Hcfs)?;
    drop(manager);
    if added {
        info!(label = %label, pattern = %trimmed, "Added exclude pattern");
    } else {
        debug!(
            label = %label,
            pattern = %trimmed,
            "Exclude pattern already exists",
        );
    }
    trigger_sync_after_exclude_edit(&app, &label).await;
    Ok(added)
}

/// Remove an exclusion pattern from a drive.
///
/// Delegates to `Drive::remove_exclude_pattern`. Returns `true` if the
/// pattern was removed, `false` if it was not found.
#[tauri::command]
pub async fn remove_exclude_pattern(label: String, pattern: String, app_state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;
    let removed = manager.remove_exclude_pattern(&pattern).map_err(AppError::Hcfs)?;
    drop(manager);
    if removed {
        info!(label = %label, pattern = %pattern, "Removed exclude pattern");
    } else {
        debug!(
            label = %label,
            pattern = %pattern,
            "Exclude pattern not found for removal",
        );
    }
    trigger_sync_after_exclude_edit(&app, &label).await;
    Ok(removed)
}

/// Apply a batch of inclusion/exclusion pattern changes, then trigger sync.
///
/// Removes exclusion patterns for paths the user wants included, adds patterns
/// for paths the user wants excluded. Replaces the paired loops in
/// `RemoteFolderBrowser.tsx`.
///
/// Semantics are **best-effort, not atomic**: the changes are applied under the
/// drive lock in order, and a drive-side `add`/`remove` failure returns `Err`
/// immediately, leaving the changes applied so far in place (there is no
/// rollback — SQLite-style transactional patterns don't apply to the in-memory
/// exclude set). An invalid exclude *pattern* is the one exception: it is
/// logged and skipped rather than aborting the batch. On `Err` the caller
/// should re-fetch the selection to see which changes landed.
#[tauri::command]
pub async fn apply_sync_selection(
    app_state: tauri::State<'_, AppState>,
    app: AppHandle,
    label: String,
    include: Vec<String>,
    exclude: Vec<String>,
) -> Result<()> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;
    apply_selection_on_manager(&manager, &label, &include, &exclude)?;
    drop(manager);

    info!(
        label = %label,
        included = include.len(),
        excluded = exclude.len(),
        "Applied sync selection"
    );

    trigger_sync_after_exclude_edit(&app, &label).await;

    Ok(())
}

/// Apply the folder browser's selection to one drive.
///
/// Both lists hold FILE PATHS the user ticked or unticked, never globs, so
/// each unticked path is escaped before it becomes a rule and each re-ticked
/// path removes that same escaped line (and the raw line an older build
/// wrote). Validation runs on the escaped form, which is the line written:
/// `..` survives escaping, so traversal is still refused, while a bracket in
/// a name no longer trips the compile check. An invalid entry is logged and
/// skipped rather than aborting the batch; a drive-side write failure aborts.
fn apply_selection_on_manager(manager: &DriveManager, label: &str, include: &[String], exclude: &[String]) -> Result<()> {
    for path in include {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            warn!(pattern = %path, "Skipping empty include entry in batch");
            continue;
        }
        let removed = remove_literal_exclusion(manager, trimmed).map_err(AppError::Hcfs)?;
        if !removed {
            debug!(label = %label, path = %trimmed, "Include entry matched no stored exclude rule (already included)");
        }
    }

    for path in exclude {
        match validate_pattern(&literal_pattern(path)) {
            Ok(_) => {
                let _ = exclude_path_literally(manager, path.trim()).map_err(AppError::Hcfs)?;
            }
            Err(e) => warn!(path = %path, error = %e, "Skipping invalid exclude entry in batch"),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{compile_like_the_engine, matches_everything, validate_pattern};
    use proptest::prelude::*;

    #[test]
    fn test_validate_empty_pattern_rejected() {
        let result = validate_pattern("");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_whitespace_only_rejected() {
        let result = validate_pattern("   ");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_traversal_pattern_rejected() {
        // Leading, nested, trailing, bare, and Windows-separator forms must
        // all be rejected — a bare `contains("../")` check would only catch the
        // first two.
        for bad in ["../secret", "foo/../bar", "foo/..", "..", "..\\secret", "a\\..\\b"] {
            assert!(validate_pattern(bad).is_err(), "expected rejection for {bad:?}");
        }
    }

    #[test]
    fn test_validate_embedded_newline_rejected() {
        // The consumer (`ExcludeRules::parse`) splits on `lines()`, so an
        // interior newline would smuggle a second pattern (here a bare `..`)
        // onto its own line. A trailing newline is fine — `trim()` removes it.
        assert!(validate_pattern("foo\n..\nbar").is_err());
        assert!(validate_pattern("foo\nbar").is_err());
        assert!(validate_pattern("foo\r\nbar").is_err());
        assert_eq!(validate_pattern("foo\n").unwrap(), "foo");
    }

    #[test]
    fn test_validate_normal_pattern_accepted() {
        // A leading `..` only counts as traversal when it is a whole path
        // component; `..foo` / `foo..bar` are ordinary glob text.
        assert_eq!(validate_pattern("*.log").unwrap(), "*.log");
        assert_eq!(validate_pattern("node_modules/").unwrap(), "node_modules/");
        assert_eq!(validate_pattern(".DS_Store").unwrap(), ".DS_Store");
        assert_eq!(validate_pattern("..foo").unwrap(), "..foo");
        assert_eq!(validate_pattern("foo..bar").unwrap(), "foo..bar");
    }

    /// A pattern that matches everything silently stops the whole drive from
    /// syncing — the user's files simply never upload again, with no error and
    /// nothing in the UI to explain it. Now that exclusions are user-editable
    /// this is reachable by typing one character, so refuse it outright.
    #[test]
    fn catch_all_patterns_are_rejected() {
        for pattern in ["*", "**", "/", "**/*", "*/", "  **  ", "**/**"] {
            assert!(
                validate_pattern(pattern).is_err(),
                "{pattern:?} matches the entire drive and must be refused"
            );
        }
    }

    #[test]
    fn ordinary_patterns_are_still_accepted() {
        for pattern in ["node_modules/", "*.tmp", "dist/", "target/", "*.pack.gz", "build/*.log", "a*b"] {
            assert!(validate_pattern(pattern).is_ok(), "{pattern:?} must remain valid");
        }
    }

    /// A pattern the engine cannot compile is stored, listed back as active,
    /// and excludes nothing — a silent no-op the user has no way to see.
    /// Refuse it here instead, and say what a working pattern looks like.
    #[test]
    fn uncompilable_globs_are_rejected_rather_than_silently_matching_nothing() {
        for pattern in ["[", "[abc", "a[b", "log[0-9", "bad[/"] {
            assert!(compile_like_the_engine(pattern).is_err(), "{pattern:?} must fail to compile");
            match validate_pattern(pattern) {
                Ok(accepted) => panic!("{pattern:?} does not compile but was accepted as {accepted:?}"),
                Err(e) => {
                    let msg = e.to_string();
                    assert!(msg.contains("Not a valid pattern"), "{pattern:?} must say why it was refused: {msg}");
                }
            }
        }
    }

    /// Character classes and `?` are legitimate glob syntax — the compile
    /// check must reject only what actually fails to parse.
    #[test]
    fn well_formed_glob_syntax_survives_the_compile_check() {
        for pattern in ["log[0-9].txt", "?.tmp", "cache[abc]/", "{a,b}.log", "*.pack.gz"] {
            assert!(validate_pattern(pattern).is_ok(), "{pattern:?} is valid glob syntax and must be accepted");
        }
    }

    #[test]
    fn test_validate_trims_whitespace() {
        assert_eq!(validate_pattern("  *.tmp  ").unwrap(), "*.tmp");
    }

    proptest! {
        /// Full contract, both directions: an accepted pattern equals the
        /// trimmed input and carries neither a newline nor a `..` component, and
        /// any rejection is justified by emptiness, a newline, a `..`
        /// component, matching the entire drive, or failing to compile as a
        /// glob. `(?s)` makes `.` match newlines so the shrinker can reach the
        /// multi-line case the default `.*` (newline-excluding) strategy never
        /// generates. The `invalid` oracle mirrors `validate_pattern`'s
        /// rejection conditions exactly — extend BOTH together.
        #[test]
        fn validated_pattern_is_single_line_trimmed_without_dotdot(s in "(?s).*") {
            let invalid = |t: &str| {
                t.is_empty()
                    || t.contains(['\n', '\r'])
                    || t.split(['/', '\\']).any(|p| p == "..")
                    || matches_everything(t)
                    || compile_like_the_engine(t).is_err()
            };
            if let Ok(out) = validate_pattern(&s) {
                prop_assert_eq!(out.as_str(), s.trim());
                prop_assert!(!invalid(&out));
            } else {
                prop_assert!(invalid(s.trim()));
            }
        }
    }
}

#[cfg(test)]
mod selection_tests {
    use super::apply_selection_on_manager;
    use hcfs_client::engine::DriveManager;
    use std::path::Path;

    const PICKED: &str = "Photos [2024]/IMG [1].jpg";
    const SIBLING: &str = "Photos 2/IMG 1.jpg";

    fn temp_manager() -> (tempfile::TempDir, DriveManager) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_dir = tmp.path().join(".hippius");
        std::fs::create_dir_all(&config_dir).expect("config dir");
        let manager = DriveManager::new(tmp.path().to_path_buf(), config_dir);
        (tmp, manager)
    }

    #[test]
    fn an_unticked_file_is_excluded_by_name_not_as_a_glob() {
        let (_tmp, manager) = temp_manager();

        apply_selection_on_manager(&manager, "drive", &[], &[PICKED.to_string()]).expect("apply");

        assert!(manager.is_excluded(Path::new(PICKED), false));
        assert!(
            !manager.is_excluded(Path::new(SIBLING), false),
            "a bracket must not become a character class"
        );
    }

    #[test]
    fn re_ticking_a_file_removes_its_rule_and_a_raw_line_from_an_older_build() {
        let (_tmp, manager) = temp_manager();
        manager.add_exclude_pattern(PICKED).expect("legacy raw line");
        apply_selection_on_manager(&manager, "drive", &[], &[PICKED.to_string()]).expect("apply");
        assert_eq!(manager.list_exclude_patterns().len(), 2, "escaped line sits beside the legacy one");

        apply_selection_on_manager(&manager, "drive", &[PICKED.to_string()], &[]).expect("apply");

        assert!(manager.list_exclude_patterns().is_empty());
        assert!(!manager.is_excluded(Path::new(PICKED), false));
    }

    #[test]
    fn a_traversal_entry_is_skipped_without_aborting_the_batch() {
        let (_tmp, manager) = temp_manager();

        apply_selection_on_manager(&manager, "drive", &[], &["../secret".to_string(), "ok.txt".to_string()]).expect("apply");

        assert_eq!(manager.list_exclude_patterns(), vec!["ok.txt"]);
    }
}
