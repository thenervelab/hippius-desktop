//! IPC commands for per-file sync failure resolution.
//!
//! These commands let the frontend skip, exclude, or retry files
//! that have repeatedly failed to sync.
//!
//! The path is a file name, never a glob: every write and removal goes
//! through `sync::exclude_literal` so `[`, `{`, `*`, `?` and a leading `#`
//! in a name cannot change which file the rule matches.

use crate::app_state::AppState;
use crate::error::Result;
use crate::sync::exclude_literal::{exclude_path_literally, remove_literal_exclusion};
use serde::Deserialize;
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use tracing::warn;

/// Drop the persisted failure row for a file the user acted on from the
/// dialog. The row carries the dismissal stamp, so leaving it behind would
/// restore a dismissal at the next launch for a file the user asked to
/// retry. Logged out means there is no row to drop.
///
/// # Errors
/// Returns an error if the database write fails.
async fn clear_durable_failure(state: &AppState, label: &str, path: &str) -> Result<()> {
    let Ok(account_id) = state.current_account_id() else {
        return Ok(());
    };
    let owner = crate::auth::account_key::account_key(&account_id);
    let pool = state.pool()?;
    crate::sync::failure_repo::clear_failure(pool, &owner, label, path).await
}

/// Skip a file for this session only.
///
/// Adds the file path to the drive's exclude patterns (so the engine
/// skips it on the next cycle) and records it as a session-skip so
/// the pattern can be removed on teardown/restart.
#[tauri::command]
pub async fn sp_skip_file(label: String, path: String, state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    state.file_failures.skip_file(&label, &path);
    clear_durable_failure(&state, &label, &path).await?;

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
        exclude_path_literally(&m, &path).map_err(|e| crate::error::AppError::Hcfs(format!("add_exclude_pattern failed: {e}")))?;
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
    clear_durable_failure(&state, &label, &path).await?;

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
        exclude_path_literally(&m, &path).map_err(|e| crate::error::AppError::Hcfs(format!("add_exclude_pattern failed: {e}")))?;
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
    clear_durable_failure(&state, &label, &path).await?;

    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    // A failed removal leaves the file excluded after the user clicked Retry,
    // so it would never re-sync with no signal — propagate it. Missing drive
    // stays tolerant (the failure counter / session-skip were already cleared).
    if let Some(arc) = drive_arc {
        let m = arc.lock().await;
        remove_literal_exclusion(&m, &path).map_err(|e| crate::error::AppError::Hcfs(format!("remove_exclude_pattern failed: {e}")))?;
    }

    state.sync.emit_snapshot(true);
    Ok(())
}

/// One `(label, path)` pair the Sync Issues dialog listed when the user
/// pressed Dismiss.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissedFile {
    pub label: String,
    pub path: String,
}

/// Remember that the user dismissed these files from the Sync Issues dialog.
///
/// A dismissed file keeps failing and keeps its Failed badge, but it does not
/// reopen the dialog on its own, in this session or after a relaunch; only a
/// file the user has not seen does. Retry, Skip and Exclude forget the
/// dismissal. The in-memory tracker learns it first so the very next cycle
/// honours it; the durable write is what survives a restart.
///
/// # Errors
/// Returns an error if the database write fails.
#[tauri::command]
pub async fn sp_dismiss_failed_files(files: Vec<DismissedFile>, state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    let mut by_label: HashMap<String, Vec<String>> = HashMap::new();
    for file in files {
        state.file_failures.dismiss(&file.label, &file.path);
        by_label.entry(file.label).or_default().push(file.path);
    }

    let Ok(account_id) = state.current_account_id() else {
        return Ok(());
    };
    let owner = crate::auth::account_key::account_key(&account_id);
    let pool = state.pool()?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    for (label, paths) in &by_label {
        crate::sync::failure_repo::mark_dismissed(pool, &owner, label, paths, now_ms).await?;
    }
    Ok(())
}

/// Reinstate a drive's durable dismissals into the in-memory tracker.
///
/// Called from the drive-init funnel. Best-effort: a read failure is logged,
/// and the only consequence is the dialog reopening once for files the user
/// had already dismissed.
pub fn spawn_restore_dismissed_failures(app: AppHandle, account_id: String, label: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Ok(pool) = state.pool() else {
            return;
        };
        let owner = crate::auth::account_key::account_key(&account_id);
        match crate::sync::failure_repo::list_dismissed_paths(pool, &owner, &label).await {
            Ok(paths) if paths.is_empty() => {}
            Ok(paths) => state.file_failures.restore_dismissed(&label, paths),
            Err(e) => warn!(label = %label, error = %e, "Could not restore dismissed sync issues; the dialog may reopen once"),
        }
    });
}

/// Read every persisted file-failure record for a drive so the FE can show
/// *why* each failed file failed (and offer retry) in any listing view.
///
/// Scoped to the current account via the hashed `owner` key. Returns an empty
/// vec when logged out or when the drive has no recorded failures — a missing
/// account is a normal "nothing to show" state, not an error.
///
/// # Errors
/// Returns an error only if the database read itself fails.
#[tauri::command]
pub async fn get_drive_failures(
    label: String,
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<Vec<crate::sync::failure_repo::FileFailureRecord>> {
    let Ok(account_id) = state.current_account_id() else {
        return Ok(Vec::new());
    };
    let owner = crate::auth::account_key::account_key(&account_id);
    let pool = state.pool()?;
    crate::sync::failure_repo::list_failures_for_label(pool, &owner, &label).await
}

/// Retry a single failed file: clear its durable + in-memory failure state,
/// drop any session-skip / exclude pattern, and trigger a sync so it is
/// re-attempted now rather than waiting for the next cycle.
///
/// This is the "Retry" action behind a failed-file badge. It is a superset of
/// [`sp_retry_file`] that also deletes the persisted `sync_file_failures` row so
/// the reason/badge clears immediately.
///
/// # Errors
/// Returns an error if the database write fails.
#[tauri::command]
pub async fn retry_file_failure(label: String, path: String, state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    if let Ok(account_id) = state.current_account_id() {
        let owner = crate::auth::account_key::account_key(&account_id);
        let pool = state.pool()?;
        crate::sync::failure_repo::clear_failure(pool, &owner, &label, &path).await?;
    }

    // Mirror sp_retry_file's in-memory reset + exclude removal.
    state.file_failures.clear_failure(&label, &path);
    state.file_failures.unskip_file(&label, &path);
    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    if let Some(arc) = drive_arc {
        let m = arc.lock().await;
        let _ = remove_literal_exclusion(&m, &path);
    }

    hcfs_client::engine::runner::trigger_sync(&state.sync).await;
    state.sync.emit_snapshot(true);
    Ok(())
}

/// Retry every failed file on a drive — e.g. after a credit top-up fixes a
/// batch of `InsufficientBalance` failures at once. Clears all durable +
/// in-memory failures for the drive, removes their exclude patterns, and
/// triggers one sync.
///
/// # Errors
/// Returns an error if the database read/write fails.
#[tauri::command]
pub async fn retry_all_failures(label: String, state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    // Snapshot the persisted failures (we need their paths to drop excludes),
    // then delete them durably — both scoped to the current account.
    let records = if let Ok(account_id) = state.current_account_id() {
        let owner = crate::auth::account_key::account_key(&account_id);
        let pool = state.pool()?;
        let recs = crate::sync::failure_repo::list_failures_for_label(pool, &owner, &label).await?;
        crate::sync::failure_repo::clear_failures_for_label(pool, &owner, &label).await?;
        recs
    } else {
        Vec::new()
    };

    state.file_failures.clear_all_for_label(&label);
    for rec in &records {
        state.file_failures.unskip_file(&label, &rec.relative_path);
    }
    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    if let Some(arc) = drive_arc {
        let m = arc.lock().await;
        for rec in &records {
            let _ = remove_literal_exclusion(&m, &rec.relative_path);
        }
    }

    hcfs_client::engine::runner::trigger_sync(&state.sync).await;
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
            let _ = remove_literal_exclusion(&m, &path);
        }
    }
    state.file_failures.reset();
}
