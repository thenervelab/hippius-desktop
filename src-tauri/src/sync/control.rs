//! Active sync operations: staging, conflict resolution, triggering, and
//! drive active-status queries.

use tracing::info;

use hcfs_client::engine::manager::StagedChanges;
use hcfs_client::engine::runner::{ReviewModeGuard, trigger_sync};
use crate::sync::lifecycle::stop_drive;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

/// Stage changes and return a preview of what will sync.
/// Pauses auto-sync while the user reviews.
#[tauri::command]
pub async fn stage_changes(app: tauri::AppHandle) -> Result<StagedChanges, crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // For V1, stage the first available drive
    let (label, first_arc) = {
        let guard = sync.drives.lock().await;
        match guard.iter().next() {
            Some((k, slot)) => (k.clone(), slot.manager.clone()),
            None => return Err(crate::error::AppError::Other("Drive not initialized".into())),
        }
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
/// `resolutions` maps hex-encoded FileId → resolution string
/// (one of: "keep_local", "accept_remote", "keep_both", "skip").
#[tauri::command]
pub async fn sync_with_conflict_resolutions(app: AppHandle, resolutions: HashMap<String, String>) -> Result<(), crate::error::AppError> {
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

    // For V1, use the first drive's label
    let label: String = {
        let guard = sync.drives.lock().await;
        guard.keys().next().cloned().unwrap_or_else(|| "default".to_string())
    };

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

    // Re-enable file watcher after a short delay to ignore trailing FS events
    {
        let sync_for_delay = sync.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            sync_for_delay.end_sync();
        });
    }

    // Resume auto-sync for this drive
    sync.clear_drive_review(&label);

    // Update shared state
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
pub async fn cancel_review(app: tauri::AppHandle) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    sync.clear_all_reviews();
    info!("Review cancelled, auto-sync resumed");
    Ok(())
}

#[tauri::command]
pub async fn trigger_sync_now(app: AppHandle) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();
    trigger_sync(&sync).await;
    Ok(())
}

/// Check whether the HCFS sync engine is active.
/// With optional label: checks if that specific drive is active.
/// Without label: checks if any drive is active.
#[tauri::command]
pub fn is_drive_active(state: tauri::State<'_, crate::app_state::AppState>, label: Option<String>) -> bool {
    match state.sync.drives.try_lock() {
        Ok(guard) => {
            if let Some(lbl) = label {
                guard.contains_key(&lbl)
            } else {
                !guard.is_empty()
            }
        }
        // If the lock is held, the drive is in use (sync in progress) → active
        Err(_) => true,
    }
}

/// Stop a drive and wait until it is truly inactive, with a timeout.
///
/// Calls `stop_drive` internally then polls `is_drive_active` every 200ms.
/// Returns `Ok(())` when the drive is gone, or an error on timeout.
/// Replaces the 1-second polling loop in `UpdateSyncFolder.tsx`.
#[tauri::command]
pub async fn stop_drive_and_wait(app: AppHandle, label: String, timeout_ms: u64) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    stop_drive(app.clone(), label.clone()).await?;

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    loop {
        if start.elapsed() >= timeout {
            return Err(crate::error::AppError::Other(format!(
                "Timed out waiting for drive '{label}' to stop after {timeout_ms}ms"
            )));
        }

        let active = {
            let app_state = app.state::<crate::app_state::AppState>();
            match app_state.sync.drives.try_lock() {
                Ok(guard) => guard.contains_key(&label),
                Err(_) => true,
            }
        };

        if !active {
            return Ok(());
        }

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}
