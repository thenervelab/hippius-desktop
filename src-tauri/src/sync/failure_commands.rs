//! IPC commands for per-file sync failure resolution.
//!
//! These commands let the frontend skip, exclude, or retry files
//! that have repeatedly failed to sync.

use crate::error::Result;

/// Skip a file for this session only.
///
/// Adds the file path to the drive's exclude patterns (so the engine
/// skips it on the next cycle) and records it as a session-skip so
/// the pattern can be removed on teardown/restart.
#[tauri::command]
pub async fn sp_skip_file(label: String, path: String, state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    state.file_failures.skip_file(&label, &path);

    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    // The exclude pattern is the actual sync-time enforcement of a skip (the
    // in-memory session-skip set is consulted only on teardown, not during a
    // sync cycle), so a failed write must surface — otherwise the FE reports
    // "skipped" while the file resurfaces next cycle. Same bug class the
    // `sp_exclude_file` comment documents. Missing drive stays tolerant: a skip
    // is a session-scoped best-effort op, unlike permanent exclude.
    if let Some(arc) = drive_arc {
        let m = arc.lock().await;
        m.add_exclude_pattern(&path)
            .map_err(|e| crate::error::AppError::Hcfs(format!("add_exclude_pattern failed: {e}")))?;
    }

    state.sync.emit_snapshot(true);
    Ok(())
}

/// Permanently exclude a file from sync.
///
/// Adds the file path to the drive's exclude patterns. Unlike
/// `sp_skip_file`, this is NOT recorded as a session-skip, so
/// the pattern persists across restarts.
#[tauri::command]
pub async fn sp_exclude_file(label: String, path: String, state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    state.file_failures.clear_failure(&label, &path);

    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    // Fail loudly when the drive isn't loaded: the previous `if let Some` made
    // "Exclude Permanently" silently return Ok when the drive had been stopped
    // between the failure event and the click, so the FE reported success but no
    // exclude pattern was written and the file resurfaced on the next sync.
    // (`sp_skip_file` differs: it records a session-skip regardless, so its
    // drive-side write is genuinely supplementary.)
    let Some(arc) = drive_arc else {
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::DriveNotInitialized));
    };
    {
        let m = arc.lock().await;
        m.add_exclude_pattern(&path)
            .map_err(|e| crate::error::AppError::Hcfs(format!("add_exclude_pattern failed: {e}")))?;
    }

    state.sync.emit_snapshot(true);
    Ok(())
}

/// Retry a previously skipped or failed file.
///
/// Resets the failure counter and removes the file from
/// session-skip and exclude patterns. The file will be
/// picked up on the next sync cycle.
#[tauri::command]
pub async fn sp_retry_file(label: String, path: String, state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    state.file_failures.clear_failure(&label, &path);
    state.file_failures.unskip_file(&label, &path);

    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    // A failed removal leaves the file excluded after the user clicked Retry,
    // so it would never re-sync with no signal — propagate it. Missing drive
    // stays tolerant (the failure counter / session-skip were already cleared).
    if let Some(arc) = drive_arc {
        let m = arc.lock().await;
        m.remove_exclude_pattern(&path)
            .map_err(|e| crate::error::AppError::Hcfs(format!("remove_exclude_pattern failed: {e}")))?;
    }

    state.sync.emit_snapshot(true);
    Ok(())
}

/// Clean up session-skip patterns on teardown.
///
/// Called from `stop_sync` to remove exclude patterns that
/// were added via `sp_skip_file`. Permanent excludes (from
/// `sp_exclude_file`) are left untouched.
pub async fn cleanup_session_skips(state: &crate::app_state::AppState) {
    let pairs = state.file_failures.clear_all_skipped();
    for (label, path) in pairs {
        let drive_arc = {
            let guard = state.sync.drives.lock().await;
            guard.get(&label).map(|slot| slot.manager.clone())
        };
        if let Some(arc) = drive_arc {
            let m = arc.lock().await;
            let _ = m.remove_exclude_pattern(&path);
        }
    }
    state.file_failures.reset();
}
