//! Tauri IPC commands for managing per-drive exclusion patterns.
//!
//! These commands expose hcfs-client's glob-based file/directory exclusion
//! API. Patterns are stored in `.hippius/{label}/exclude` (one per line,
//! gitignore-style) and are applied during `scan_local_files`.

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use hcfs_client::engine::runner::trigger_sync;
use tauri::AppHandle;
use tracing::{debug, info, warn};

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
    Ok(trimmed)
}

/// List all active exclusion patterns for a drive.
///
/// Grabs the per-drive Arc from the drives map (microsecond outer lock),
/// then locks the manager to read patterns. Returns an empty list if the
/// drive does not exist.
#[tauri::command]
pub async fn list_exclude_patterns(label: String, app_state: tauri::State<'_, AppState>) -> Result<Vec<String>> {
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
    Ok(patterns)
}

/// Add an exclusion pattern to a drive.
///
/// Validates the pattern (rejects empty, whitespace-only, or path-traversal
/// patterns), then delegates to `Drive::add_exclude_pattern`. Returns `true`
/// if the pattern was added, `false` if it already existed.
#[tauri::command]
pub async fn add_exclude_pattern(label: String, pattern: String, app_state: tauri::State<'_, AppState>) -> Result<bool> {
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
    if added {
        info!(label = %label, pattern = %trimmed, "Added exclude pattern");
    } else {
        debug!(
            label = %label,
            pattern = %trimmed,
            "Exclude pattern already exists",
        );
    }
    Ok(added)
}

/// Remove an exclusion pattern from a drive.
///
/// Delegates to `Drive::remove_exclude_pattern`. Returns `true` if the
/// pattern was removed, `false` if it was not found.
#[tauri::command]
pub async fn remove_exclude_pattern(label: String, pattern: String, app_state: tauri::State<'_, AppState>) -> Result<bool> {
    let drive_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    let Some(arc) = drive_arc else {
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };

    let manager = arc.lock().await;
    let removed = manager.remove_exclude_pattern(&pattern).map_err(AppError::Hcfs)?;
    if removed {
        info!(label = %label, pattern = %pattern, "Removed exclude pattern");
    } else {
        debug!(
            label = %label,
            pattern = %pattern,
            "Exclude pattern not found for removal",
        );
    }
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

    for path in &include {
        // Trim for parity with the exclude branch (validate_pattern trims before
        // storing), so an entry with surrounding whitespace actually matches the
        // stored rule instead of silently no-op'ing, and observe the returned
        // bool so a no-match is logged rather than vanishing. A remove can only
        // delete a stored rule — it cannot escape
        // the sync root — so the full validate_pattern (`..`/newline rejection)
        // the add side needs is unnecessary here.
        let trimmed = path.trim();
        if trimmed.is_empty() {
            warn!(pattern = %path, "Skipping empty include entry in batch");
            continue;
        }
        let removed = manager.remove_exclude_pattern(trimmed).map_err(AppError::Hcfs)?;
        if !removed {
            debug!(label = %label, pattern = %trimmed, "Include entry matched no stored exclude rule (already included)");
        }
    }
    for path in &exclude {
        match validate_pattern(path) {
            Ok(trimmed) => {
                let _ = manager.add_exclude_pattern(&trimmed).map_err(AppError::Hcfs)?;
            }
            // Unlike `add_exclude_pattern`, a batch tolerates a bad entry rather
            // than aborting the whole selection — but log it so a silently
            // dropped exclusion is observable instead of vanishing.
            Err(e) => warn!(pattern = %path, error = %e, "Skipping invalid exclude pattern in batch"),
        }
    }

    drop(manager);

    info!(
        label = %label,
        included = include.len(),
        excluded = exclude.len(),
        "Applied sync selection"
    );

    // Trigger sync to download newly included files
    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>().sync.clone();
        let _ = trigger_sync(&s).await;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_pattern;
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

    #[test]
    fn test_validate_trims_whitespace() {
        assert_eq!(validate_pattern("  *.tmp  ").unwrap(), "*.tmp");
    }

    proptest! {
        /// Full contract, both directions: an accepted pattern equals the
        /// trimmed input and carries neither a newline nor a `..` component, and
        /// any rejection is justified by emptiness, a newline, or a `..`
        /// component. `(?s)` makes `.` match newlines so the shrinker can reach
        /// the multi-line case the default `.*` (newline-excluding) strategy
        /// never generates. The `invalid` oracle mirrors `validate_pattern`'s
        /// three rejection conditions exactly.
        #[test]
        fn validated_pattern_is_single_line_trimmed_without_dotdot(s in "(?s).*") {
            let invalid = |t: &str| t.is_empty() || t.contains(['\n', '\r']) || t.split(['/', '\\']).any(|p| p == "..");
            if let Ok(out) = validate_pattern(&s) {
                prop_assert_eq!(out.as_str(), s.trim());
                prop_assert!(!invalid(&out));
            } else {
                prop_assert!(invalid(s.trim()));
            }
        }
    }
}
