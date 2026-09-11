//! Create an empty folder inside a drive this device syncs.
//!
//! The counterpart to `remote_rename::create_remote_folder`, which does the
//! same thing for a drive that is only browsed. The split is not
//! cosmetic: a synced drive HAS a directory, so the folder is made on disk
//! and the engine carries it up — its folder entity is registered by the
//! same backfill that handles every other empty directory. A browsed drive
//! has no directory to make, so the entity is registered with the server
//! directly.
//!
//! Making the directory is therefore the whole operation. Nothing here
//! writes sync state by hand.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use hcfs_client::engine::runner::trigger_sync;
use tracing::info;

use crate::error::{AppError, Result};

use super::rename::{resolve_rename_root, validate_new_name};

/// Split a caller-supplied drive-relative parent into its segments.
///
/// The parent comes from the frontend, so it is untrusted: `..` would
/// place the new folder outside the drive entirely, and an absolute path
/// would ignore the root. Both are refused here rather than relied on
/// being caught by a later canonicalize, because the directory would
/// already have been created by then.
fn parent_segments(parent: &str) -> Result<Vec<String>> {
    let normalized = parent.replace('\\', "/");
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(AppError::Validation("That folder path is not inside the drive.".into()));
        }
        out.push(segment.to_string());
    }
    Ok(out)
}

/// Where the new folder goes, and what to call it back to the frontend.
///
/// Pure so the path arithmetic — the half that can put a folder somewhere
/// it should not be — is testable without touching a filesystem.
fn plan_new_folder(sync_root: &Path, parent: &str, name: &str) -> Result<(PathBuf, String)> {
    let segments = parent_segments(parent)?;
    let mut target = sync_root.to_path_buf();
    for segment in &segments {
        target.push(segment);
    }
    target.push(name);

    // Belt and braces over `parent_segments`: a component that is not a
    // plain name at this point means the arithmetic above let something
    // through, and creating the directory is not reversible.
    if target.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::Validation("That folder path is not inside the drive.".into()));
    }

    let mut relative = segments;
    relative.push(name.to_string());
    Ok((target, relative.join("/")))
}

/// Create an empty folder in a synced drive.
///
/// `label` names the drive; `None` uses the default one, which is what the
/// Overview page and the drive list pass — there is no folder open there,
/// so "here" is the main drive. `parent_path` is drive-relative and empty
/// for the drive's own root.
///
/// Returns the new folder's drive-relative path.
#[tauri::command]
pub async fn create_sync_folder(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    label: Option<String>,
    parent_path: Option<String>,
    name: String,
) -> Result<String> {
    let account_id = state.require_session_account(&account_id)?;
    // The same validator the rename dialog uses, so a name this app
    // refuses to rename TO is also one it refuses to create.
    let name = validate_new_name(&name)?.to_string();

    let pool = state.pool()?;
    let label_to_path: HashMap<String, String> = crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "create_sync_folder")
        .await
        .into_iter()
        .map(|sp| (sp.label, sp.path))
        .collect();
    let (sync_path, _guard_label) = resolve_rename_root(label.as_deref(), &label_to_path)?;

    let (target, relative) = plan_new_folder(Path::new(&sync_path), parent_path.as_deref().unwrap_or_default(), &name)?;

    // Fail closed on an unreadable parent: creating into a directory we
    // cannot stat is how a folder lands somewhere unintended.
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Validation("That folder path is not inside the drive.".into()))?;
    if !parent.is_dir() {
        return Err(AppError::NotFound("That folder is no longer here — refresh and try again.".into()));
    }
    // `create_dir` rather than `create_dir_all`: the parent is supposed to
    // exist already, and silently building a tree would hide a stale path.
    match tokio::fs::create_dir(&target).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(AppError::Validation(format!("\"{name}\" already exists here.")));
        }
        Err(e) => return Err(AppError::Io(e)),
    }

    // Pick it up now rather than waiting for the watcher debounce, exactly
    // as the rename command does.
    let _ = trigger_sync(&state.sync).await;

    info!(path = %relative, "Created a folder in a synced drive");
    Ok(relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/drive")
    }

    #[test]
    fn places_a_folder_at_the_drive_root() {
        let (target, relative) = plan_new_folder(&root(), "", "Photos").expect("plan");
        assert_eq!(target, PathBuf::from("/drive/Photos"));
        assert_eq!(relative, "Photos");
    }

    #[test]
    fn places_a_folder_inside_an_open_subfolder() {
        let (target, relative) = plan_new_folder(&root(), "Trips/2024", "Spain").expect("plan");
        assert_eq!(target, PathBuf::from("/drive/Trips/2024/Spain"));
        assert_eq!(relative, "Trips/2024/Spain");
    }

    /// The parent comes from the frontend. `..` would put the folder
    /// outside the drive, and by the time a canonicalize noticed, the
    /// directory would already exist.
    #[test]
    fn refuses_a_parent_that_climbs_out_of_the_drive() {
        for parent in ["..", "../elsewhere", "Trips/../../etc"] {
            assert!(plan_new_folder(&root(), parent, "x").is_err(), "{parent} was allowed");
        }
    }

    /// Windows separators and stray slashes are tidied rather than
    /// refused — they are how the path arrives from some callers, not an
    /// attempt to escape.
    #[test]
    fn tolerates_separators_and_empty_segments() {
        let (target, relative) = plan_new_folder(&root(), "/Trips//2024/", "Spain").expect("plan");
        assert_eq!(target, PathBuf::from("/drive/Trips/2024/Spain"));
        assert_eq!(relative, "Trips/2024/Spain");

        let (win, _) = plan_new_folder(&root(), r"Trips\2024", "Spain").expect("plan");
        assert_eq!(win, PathBuf::from("/drive/Trips/2024/Spain"));
    }

    /// The name itself is validated by `validate_new_name` before this is
    /// reached, so the relative path is always the parent plus one plain
    /// segment.
    #[test]
    fn the_relative_path_is_what_the_listing_will_show() {
        let (_, relative) = plan_new_folder(&root(), "A/B", "C").expect("plan");
        assert_eq!(relative, "A/B/C");
    }
}
