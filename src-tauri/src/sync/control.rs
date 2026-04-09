//! Active sync operations: staging, conflict resolution, triggering, and
//! drive active-status queries.

use tracing::{debug, info};

use crate::error::Result;
use crate::sync::lifecycle::remove_drive;
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
            .ok_or_else(|| crate::error::AppError::Other(format!("No active drive with label '{label}'")))?
    };

    // RAII guard: sets review_mode for this drive, resets on drop unless commit()ed.
    let review_guard = ReviewModeGuard::new(sync.clone(), label);

    let m = first_arc.try_lock().map_err(|_| "Sync is in progress, please wait".to_string())?;

    if !m.is_unlocked() {
        return Err(crate::error::AppError::Other("Drive is not unlocked".into()));
    }

    let changes = m.stage_with_paths().await?;
    review_guard.commit();
    Ok(changes)
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

    // Validate resolution values before proceeding
    for (file_id, resolution) in &resolutions {
        if !matches!(resolution.as_str(), "keep_local" | "accept_remote" | "keep_both" | "skip") {
            return Err(crate::error::AppError::Other(format!(
                "Invalid resolution '{resolution}' for file {file_id}"
            )));
        }
    }

    // Mark syncing in shared state
    sync.update_state(&label, |s| {
        s.is_syncing = true;
    });

    let _ = app.emit(
        crate::sync::events::SYNC_STARTED,
        crate::sync::events::LabelPayload { label: label.clone() },
    );

    // Suppress file watcher during sync to prevent feedback loops
    sync.begin_sync();

    let result = {
        let drive_arc = {
            let guard = sync.drives.lock().await;
            guard.get(&label).map(|slot| slot.manager.clone())
        };
        match drive_arc {
            Some(arc) => {
                let mut m = arc.lock().await;
                if m.is_unlocked() {
                    Some(m.sync_with_resolutions(resolutions).await)
                } else {
                    None
                }
            }
            None => None,
        }
    };

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
        Some(Ok(outcome)) => {
            info!(
                "Reviewed sync completed: uploaded={}, downloaded={}, deleted_local={}, deleted_remote={}, conflicts_resolved={}, conflicts_skipped={}",
                outcome.files_uploaded,
                outcome.files_downloaded,
                outcome.files_deleted_locally,
                outcome.files_deleted_remotely,
                outcome.conflicts_resolved,
                outcome.conflicts_skipped,
            );
            let _ = app.emit(
                crate::sync::events::SYNC_COMPLETED,
                crate::sync::events::SyncCompletedPayload::from_outcome(&label, &outcome),
            );
            Ok(())
        }
        Some(Err(e)) => {
            let _ = app.emit(
                crate::sync::events::SYNC_ERROR,
                crate::sync::events::SyncErrorPayload {
                    label: label.clone(),
                    error: e.clone(),
                    retry_in_secs: 0,
                    consecutive_failures: 0,
                },
            );
            Err(crate::error::AppError::from(e))
        }
        None => {
            let msg = "Drive not initialized or not unlocked";
            let _ = app.emit(
                crate::sync::events::SYNC_ERROR,
                crate::sync::events::SyncErrorPayload {
                    label: label.clone(),
                    error: msg.to_string(),
                    retry_in_secs: 0,
                    consecutive_failures: 0,
                },
            );
            Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::DriveNotUnlocked))
        }
    }
}

/// Cancel the review dialog and resume auto-sync without syncing.
#[tauri::command]
pub async fn cancel_review(app: tauri::AppHandle) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    sync.clear_all_reviews();
    info!("Review cancelled, auto-sync resumed");
    Ok(())
}

#[tauri::command]
pub async fn trigger_sync_now(app: AppHandle) -> Result<()> {
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();
    trigger_sync(&sync).await;
    Ok(())
}

/// Remove a drive and wait until it is truly torn down, with a timeout.
///
/// Calls `remove_drive` internally, then waits for `AppState::drive_removed_notify`
/// to be signalled (fired by `remove_drive` / `pause_drive` immediately after the
/// drive is removed from the registry). Falls back to a timeout guard so the
/// caller is never blocked indefinitely. Replaces the 200ms polling loop with
/// an event-driven wake-up, eliminating both latency and unnecessary CPU cycles.
#[tauri::command]
pub async fn remove_drive_and_wait(app: AppHandle, label: String, timeout_ms: u64) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    remove_drive(app.clone(), label.clone()).await?;

    loop {
        // Capture notification intent BEFORE checking — avoids lost wakeups
        // when `remove_drive` fires `notify_waiters()` between our check and
        // the `select!` park.
        let notified = app_state.drive_removed_notify.notified();

        // Check immediately — the drive may already be gone.
        let still_active = match app_state.sync.drives.try_lock() {
            Ok(guard) => guard.contains_key(&label),
            // Lock contention means a sync cycle is in progress; treat as active.
            Err(_) => true,
        };
        if !still_active {
            return Ok(());
        }

        let remaining = timeout.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Err(crate::error::AppError::Other(format!(
                "Timed out waiting for drive '{label}' to stop after {timeout_ms}ms"
            )));
        }

        // Wait for an explicit notification from remove_drive/pause_drive, or
        // fall through to re-check when the timeout expires.
        tokio::select! {
            () = notified => { /* re-check loop */ }
            () = tokio::time::sleep(remaining) => { /* timeout — re-check and return error */ }
        }
    }
}
