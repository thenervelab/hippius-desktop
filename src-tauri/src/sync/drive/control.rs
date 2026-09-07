//! Active sync operations: staging, conflict resolution, triggering, and
//! drive active-status queries.

use tracing::{debug, info};

use crate::error::Result;
use hcfs_client::engine::manager::StagedChanges;
use hcfs_client::engine::runner::{ReviewModeGuard, trigger_sync};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

/// Delay after a reviewed sync before re-enabling the file watcher.
/// Gives trailing filesystem events from the sync cycle time to drain
/// so they don't immediately re-trigger another sync.
const WATCHER_REENABLE_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// Stage changes and return a preview of what will sync.
/// Pauses auto-sync while the user reviews.
///
/// The `label` parameter identifies which drive to stage changes for.
/// This must match a label that was registered via `set_sync_path`.
#[tauri::command]
pub async fn stage_changes(app: tauri::AppHandle, label: String) -> Result<StagedChanges> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let first_arc = {
        let guard = sync.drives.lock().await;
        guard
            .get(&label)
            .map(|slot| slot.manager.clone())
            // The label isn't in the active-drive map → NotFound (entity missing).
            .ok_or_else(|| crate::error::AppError::NotFound(format!("No active drive with label '{label}'")))?
    };

    // RAII guard: sets review_mode for this drive, resets on drop unless commit()ed.
    let review_guard = ReviewModeGuard::new(sync.clone(), label);

    // try_lock fails iff a sync cycle currently holds the manager → the dedicated
    // NotReady(SyncInProgress) (same Display text, structured SYNC_IN_PROGRESS subkind),
    // not a String→Other via From<String>.
    let m = first_arc
        .try_lock()
        .map_err(|_| crate::error::AppError::NotReady(crate::error::NotReadyKind::SyncInProgress))?;

    if !m.is_unlocked() {
        // Exactly the dedicated NotReady(DriveNotUnlocked) state — its Display is the
        // same "Drive is not unlocked" and the FE knows the DRIVE_NOT_UNLOCKED subkind
        // (dispatchTauriError). stage_changes' caller doesn't route through
        // isExpectedNoSessionError, so this stays surfaced while gaining the structured kind.
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::DriveNotUnlocked));
    }

    let changes = m.stage_with_paths().await?;
    review_guard.commit();
    Ok(changes)
}

/// Validate a frontend-supplied conflict-resolution map.
///
/// Every value must be one of the four resolution verbs hcfs-client
/// understands. Extracted as a pure free function so the validation contract is
/// unit-testable without a Tauri `AppHandle` or a live drive (project axiom 111
/// — exercise the logic through a testable surface, not a mocked runtime).
///
/// # Errors
/// Returns [`crate::error::AppError::Validation`] naming the offending value and
/// its file id on the first invalid entry. An empty map is vacuously valid.
pub(crate) fn validate_resolutions(resolutions: &HashMap<String, String>) -> Result<()> {
    for (file_id, resolution) in resolutions {
        if !matches!(resolution.as_str(), "keep_local" | "accept_remote" | "keep_both" | "skip") {
            // Rejected frontend-supplied input → Validation.
            return Err(crate::error::AppError::Validation(format!(
                "Invalid resolution '{resolution}' for file {file_id}"
            )));
        }
    }
    Ok(())
}

/// Shared failure arm for "the drive isn't registered / isn't unlocked":
/// resume auto-sync for the label (the review flow is over for a drive that
/// cannot sync), surface the failure through the shared bridge helper
/// (notification + per-label defensive clears), and hand back the typed
/// NotReady error. This runs BEFORE any reviewed-sync side effect is applied,
/// so there is nothing else to unwind.
fn fail_drive_unavailable(app: &AppHandle, label: &str) -> crate::error::AppError {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    app_state.sync.clear_drive_review(label);

    crate::sync::tauri_bridge::handle_sync_error(
        app,
        crate::sync::events::SyncErrorPayload {
            label: label.to_string(),
            error: "Drive not initialized or not unlocked".to_string(),
            retry_in_secs: 0,
            consecutive_failures: 0,
        },
        // User-initiated reviewed sync: a real failure always notifies.
        crate::sync::tauri_bridge::FailureNotify::Always,
    );
    crate::error::AppError::NotReady(crate::error::NotReadyKind::DriveNotUnlocked)
}

/// Sync with user-provided conflict resolutions, then resume auto-sync.
///
/// The `label` parameter identifies which drive to resolve conflicts for.
/// `resolutions` maps hex-encoded FileId to a resolution string
/// (one of: "keep_local", "accept_remote", "keep_both", "skip").
#[tauri::command]
#[expect(
    clippy::implicit_hasher,
    reason = "Tauri commands cannot be generic; the hasher must be concrete because #[tauri::command] generates a non-generic handler"
)]
pub async fn sync_with_conflict_resolutions(app: AppHandle, label: String, resolutions: HashMap<String, String>) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Validate resolution values before proceeding (pure, unit-tested below).
    validate_resolutions(&resolutions)?;

    // Acquire the drive manager BEFORE any side effect (is_syncing, the
    // SYNC_STARTED emit, watcher suppression). The auto-sync loop holds this
    // same per-drive lock for an ENTIRE cycle (`run_sync_cycle` in
    // hcfs-client), which on a large drive can run for tens of minutes — a
    // blocking `lock().await` here silently queued the user's "Sync Now"
    // click behind the in-flight cycle with the button spinner as the only
    // (misleading) feedback. `try_lock` mirrors `stage_changes`: contention
    // surfaces immediately as NotReady(SyncInProgress) with no UI/watcher
    // side effects (review mode is re-armed — see the Err arm below), so the
    // FE keeps the review dialog (and the user's chosen resolutions) and
    // tells them to retry shortly.
    let drive_arc = {
        let guard = sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    let Some(drive_arc) = drive_arc else {
        return Err(fail_drive_unavailable(&app, &label));
    };
    let Ok(mut m) = drive_arc.try_lock() else {
        // Manager held by an in-flight auto-sync cycle. Re-arm review mode
        // (best-effort — `set_drive_review` refuses during the post-review
        // cooldown) so the loop pauses at the NEXT cycle boundary instead of
        // immediately grabbing the lock for another long cycle: the user's
        // retry then wins deterministically once the current cycle ends,
        // rather than racing the 5s tick. If the user instead dismisses the
        // dialog, cancel_review clears this; if they walk away, the engine's
        // 5-minute review timeout does.
        let rearmed = sync.set_drive_review(&label);
        debug!(label, rearmed, "reviewed sync found the drive manager busy; returning SyncInProgress");
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::SyncInProgress));
    };
    if !m.is_unlocked() {
        return Err(fail_drive_unavailable(&app, &label));
    }

    // The reviewed sync is now committed to run — only from this point on are
    // the UI/watcher side effects applied.
    sync.update_state(&label, |s| {
        s.is_syncing = true;
    });

    // Emit the SAME SyncStartedPayload shape the auto-sync bridge emits, so FE
    // listeners that read the plan fields get an empty plan (the reviewed sync's
    // plan isn't known until sync_with_resolutions runs) rather than `undefined`
    // from a bare LabelPayload.
    let _ = app.emit(
        crate::sync::events::SYNC_STARTED,
        crate::sync::events::SyncStartedPayload {
            label: label.clone(),
            uploads: 0,
            downloads: 0,
            local_deletes: 0,
            remote_deletes: 0,
            upload_files: Vec::new(),
            download_files: Vec::new(),
            local_delete_files: Vec::new(),
            remote_delete_files: Vec::new(),
        },
    );

    // Suppress file watcher during sync to prevent feedback loops
    sync.begin_sync();

    let result = m.sync_with_resolutions(resolutions).await;
    drop(m);

    // Re-enable file watcher after a short delay to ignore trailing FS events.
    //
    // NOTE: The spawned task handle is intentionally dropped. `end_sync()` is a
    // lock-free atomic decrement on `syncs_in_progress` and is safe to call on
    // a torn-down runner, so orphaning this task during shutdown is safe — and
    // in fact required, since `begin_sync()` was already called above and the
    // counter MUST be balanced even if the process is winding down.
    //
    // `SyncRunner` does not currently expose an awaitable cancellation token
    // (only `request_cancel()` / `is_cancelled()` over an `AtomicBool`), so a
    // `tokio::select!` against cancellation is not possible today. If hcfs-client
    // ever exposes a `CancellationToken` accessor, switch this to a select so
    // the delay can be short-circuited on shutdown.
    {
        let sync_for_delay = sync.clone();
        tokio::spawn(async move {
            tokio::time::sleep(WATCHER_REENABLE_DELAY).await;
            debug!("Re-enabling file watcher after reviewed sync");
            sync_for_delay.end_sync();
        });
    }

    // Resume auto-sync for this drive
    sync.clear_drive_review(&label);

    // Update per-drive UI state. `is_syncing` flips to false immediately
    // because the sync cycle IS done from the user's perspective.
    // `syncs_in_progress` (the global watcher-suppression counter) stays
    // elevated for another WATCHER_REENABLE_DELAY via the spawned task
    // above — that's intentional: the two track different things.
    //   is_syncing        = "is this drive's sync cycle running?" (UI)
    //   syncs_in_progress = "should the file watcher suppress events?" (internal)
    sync.update_state(&label, |s| {
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    });

    match result {
        Ok(outcome) => {
            info!(
                "Reviewed sync completed: uploaded={}, downloaded={}, deleted_local={}, deleted_remote={}, conflicts_resolved={}, conflicts_skipped={}",
                outcome.files_uploaded,
                outcome.files_downloaded,
                outcome.files_deleted_locally,
                outcome.files_deleted_remotely,
                outcome.conflicts_resolved,
                outcome.conflicts_skipped,
            );
            // Route through the shared bridge helper so the reviewed-sync
            // completion runs the SAME per-label cleanup as the auto-sync
            // loop (preparing-clear, banner-clear, failure-counter recompute)
            // and ships the completion notification with its per-file detail,
            // instead of emitting the completion event directly and skipping
            // all of it. A reviewed sync has no cycle-level failure count, so
            // `files_failed = 0`.
            crate::sync::tauri_bridge::handle_sync_completed(&app, crate::sync::events::SyncCompletedPayload::from_outcome(&label, &outcome), 0);
            Ok(())
        }
        Err(e) => {
            // Route through the shared bridge helper so a cancel during a
            // reviewed sync is dropped (not surfaced as a spurious "Sync
            // Failed") and the per-label defensive clears run — same as the
            // auto-sync path.
            crate::sync::tauri_bridge::handle_sync_error(
                &app,
                crate::sync::events::SyncErrorPayload {
                    label: label.clone(),
                    error: e.clone(),
                    retry_in_secs: 0,
                    consecutive_failures: 0,
                },
                // User-initiated reviewed sync: a real failure always notifies
                // (not the auto-loop's per-label rate-limited path).
                crate::sync::tauri_bridge::FailureNotify::Always,
            );
            Err(crate::error::AppError::from(e))
        }
    }
}

/// Cancel ONE drive's review dialog and resume that drive's auto-sync without
/// syncing. Scoped to `label` via `clear_drive_review` — `clear_all_reviews`
/// (which iterates every drive and arms a per-drive cooldown on each) is
/// reserved for true global resets (logout/teardown in `lifecycle.rs`).
/// Cancelling one drive's review must not suppress conflict dialogs on the
/// others (multi-drive correctness).
#[tauri::command]
pub async fn cancel_review(app: tauri::AppHandle, label: String) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    sync.clear_drive_review(&label);
    info!("Review cancelled for '{}', auto-sync resumed", label);
    Ok(())
}

#[tauri::command]
pub async fn trigger_sync_now(app: AppHandle) -> Result<()> {
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();
    trigger_sync(&sync).await;
    Ok(())
}

/// Pure helper: pick the on-disk path for `label` out of a list of sync-path rows.
///
/// Extracted so the lookup is unit-testable without touching the Tauri state,
/// the SQLite pool, or the opener plugin.
pub(crate) fn resolve_drive_path(paths: Vec<crate::sync::paths::SyncPathResult>, label: &str) -> Result<String> {
    paths
        .into_iter()
        .find(|p| p.label == label)
        .map(|p| p.path)
        // No row for the label → NotFound (entity missing).
        .ok_or_else(|| crate::error::AppError::NotFound(format!("No sync path with label '{label}'")))
}

/// Reveal the on-disk folder for a configured drive in the OS file
/// manager (Finder on macOS, Explorer on Windows, the default file
/// manager on Linux).
///
/// Looks up the `sync_paths` row by `(owner, label)` for the currently
/// logged-in account, then reveals it through [`crate::utils::reveal`].
/// Path resolution lives in Rust so the frontend never reads the
/// `sync_paths` table just to figure out which folder backs a label.
///
/// Errors:
/// - `NotReady` (no logged-in account)
/// - `NotFound("No sync path with label '...'")` when the label is unknown
/// - `Other("Failed to reveal ...")` when the file manager cannot be opened
#[tauri::command]
pub async fn reveal_drive_in_finder(state: tauri::State<'_, crate::app_state::AppState>, label: String) -> Result<()> {
    let pool = state.pool()?;
    let account_id = state.current_account_id()?;

    let paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id).await?;
    let path = resolve_drive_path(paths, &label)?;

    // `reveal_path` now WAITS on xdg-open for up to 3s on Linux, so calling it
    // inline would park a Tokio worker for that whole budget.
    let target = std::path::PathBuf::from(&path);
    match tokio::task::spawn_blocking(move || crate::utils::reveal::reveal_path(&target)).await {
        Ok(inner) => inner?,
        Err(join_err) => return Err(crate::error::AppError::Other(format!("Reveal cancelled: {join_err}"))),
    }

    info!("Revealed drive '{}' at '{}' in file manager", label, path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::paths::SyncPathResult;

    fn row(label: &str, path: &str) -> SyncPathResult {
        SyncPathResult {
            path: path.to_string(),
            is_public: false,
            label: label.to_string(),
            is_paused: false,
        }
    }

    #[test]
    fn resolve_drive_path_matches_by_label() {
        let rows = vec![
            row("default", "/Users/me/Hippius"),
            row("photos", "/Users/me/Pictures"),
            row("docs", "/Users/me/Documents"),
        ];
        assert_eq!(resolve_drive_path(rows, "photos").unwrap(), "/Users/me/Pictures");
    }

    #[test]
    fn resolve_drive_path_errors_on_unknown_label() {
        let rows = vec![row("default", "/Users/me/Hippius")];
        let err = resolve_drive_path(rows, "missing").unwrap_err();
        // The error message must mention the missing label so the FE
        // toast and the logs are unambiguous.
        assert!(err.to_string().contains("missing"));
    }

    #[test]
    fn resolve_drive_path_errors_on_empty_list() {
        let err = resolve_drive_path(Vec::new(), "anything").unwrap_err();
        assert!(err.to_string().contains("anything"));
    }

    #[test]
    fn reveal_drive_in_finder_routes_through_utils_reveal() {
        let src = include_str!("control.rs");
        let start = src.find("pub async fn reveal_drive_in_finder(").expect("command");
        let rest = &src[start..];
        let end = rest.find("#[cfg(test)]").unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(
            body.contains("crate::utils::reveal::reveal_path("),
            "reveal_drive_in_finder must share the Linux xdg-open fallback with Drive kebabs"
        );
        assert!(
            !body.contains("tauri_plugin_opener::reveal_item_in_dir"),
            "do not call the opener plugin from this command; utils::reveal owns the platform split"
        );
        assert!(
            body.contains("spawn_blocking"),
            "reveal_path waits on xdg-open for up to 3s; calling it inline parks a Tokio worker \
             for that budget, the same reason reveal_path_in_file_manager offloads it"
        );
    }

    fn resolutions(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
    }

    #[test]
    fn validate_resolutions_accepts_every_valid_verb() {
        // All four verbs hcfs-client understands must pass.
        let map = resolutions(&[("a", "keep_local"), ("b", "accept_remote"), ("c", "keep_both"), ("d", "skip")]);
        assert!(validate_resolutions(&map).is_ok());
    }

    #[test]
    fn validate_resolutions_accepts_empty_map() {
        // A drive with no conflicts hands in an empty map; that is vacuously valid.
        assert!(validate_resolutions(&HashMap::new()).is_ok());
    }

    #[test]
    fn validate_resolutions_rejects_invalid_verb_naming_value_and_file() {
        // The error must name BOTH the bad value and its file id so the FE
        // toast and the logs are unambiguous about which entry was wrong.
        let map = resolutions(&[("deadbeef", "overwrite")]);
        let err = validate_resolutions(&map).unwrap_err();
        // Pin the taxonomy: a rejected resolution verb is Validation, not Other.
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "invalid resolution must surface as Validation, got {err:?}"
        );
        let msg = err.to_string();
        assert!(msg.contains("overwrite"), "error must name the bad value; got {msg}");
        assert!(msg.contains("deadbeef"), "error must name the file id; got {msg}");
    }

    #[test]
    fn validate_resolutions_rejects_when_one_entry_in_a_valid_set_is_bad() {
        // A single bad entry among valid ones must still fail closed —
        // partial application of resolutions would risk the wrong merge.
        let map = resolutions(&[("a", "keep_local"), ("b", "definitely_not_a_verb")]);
        assert!(validate_resolutions(&map).is_err());
    }
}
