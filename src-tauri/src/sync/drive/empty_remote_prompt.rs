//! The empty-drive prompt: what the desktop does when hcfs refuses a drive's
//! empty server listing (`SyncError::SuspiciousEmptyRemote`), and the IPC
//! commands that answer it.
//!
//! The bridge routes each refusal here ([`report`]); the per-drive state
//! (`sync::empty_remote`) absorbs hcfs's per-retry repeats, and a changed
//! report is published off the bridge's thread, since whether this account
//! may confirm comes from the database. The first publish of an episode
//! saves the notification.
//!
//! ## Why the desktop checks membership before hcfs does
//!
//! The answer is hcfs's marker file, written through a `DriveManager` built
//! just for the request (lock-free: the syncing manager's lock is held for a
//! whole cycle). That manager has no client, so hcfs cannot tell a member
//! from the owner when the marker is written; it refuses a member's marker
//! only when the next cycle reads it. Membership comes from `sync_paths`
//! (`resolve_drive_identity`), so a member is refused at request time, with
//! a typed kind the prompt can show.

use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};
use crate::sync::empty_remote::{EmptyRemoteEntry, Recorded};
use crate::sync::events::{self, EmptyRemotePayload};
use hcfs_client::engine::manager::DriveManager;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::{info, warn};

/// Confirm a drive really is empty on Hippius: the next cycle applies the
/// empty listing and deletes this device's copies of its files.
///
/// # Errors
///
/// `NotReady` with subkind `EMPTY_REMOTE_MEMBER_CANNOT_CONFIRM` for a
/// shared drive this account is a member of, or `EMPTY_REMOTE_NOTHING_HELD`
/// when hcfs is no longer refusing the drive's listing; `Hcfs` when the
/// confirmation cannot be written.
#[tauri::command]
pub async fn confirm_empty_remote(app: AppHandle, label: String) -> Result<()> {
    let state = app.state::<AppState>();
    let pool = state.pool()?;
    let account_id = state.current_account_id()?;

    let identity = crate::sync::identity::resolve_drive_identity(pool, &account_id, &label).await?;
    check_confirmable(state.empty_remote.entry(&label), identity.is_member)?;

    let sync_root = PathBuf::from(crate::sync::config::get_sync_path_for_label(pool, &account_id, &label).await?);
    let config_dir = crate::sync::mnemonic::config_dir_for_folder(&account_id, &label)?;
    tokio::task::spawn_blocking(move || DriveManager::new(sync_root, config_dir).confirm_empty_remote())
        .await
        .map_err(|e| AppError::Other(format!("empty drive confirmation task failed: {e}")))?
        .map_err(AppError::Hcfs)?;
    // After the write: a cycle starting between the two would otherwise be
    // read as having ignored an answer it could not have seen.
    state.empty_remote.note_answered(&label);
    info!(label = %label, "Confirmed an empty drive; the next cycle removes the local copies");

    // hcfs has no per-drive trigger; a round syncs every drive, which is
    // what the heartbeat would do shortly anyway. Detached: a whole cycle
    // must not hold the IPC open.
    let sync = std::sync::Arc::clone(&state.sync);
    tauri::async_runtime::spawn(async move {
        let _ = hcfs_client::engine::runner::trigger_sync(&sync).await;
    });
    Ok(())
}

/// Every drive whose empty listing hcfs is refusing, for the prompt to
/// hydrate on start or reload.
///
/// # Errors
///
/// Never in practice; `Result` for the IPC convention.
#[tauri::command]
pub async fn get_empty_remote_drives(state: tauri::State<'_, AppState>) -> Result<Vec<EmptyRemotePayload>> {
    let drives = state.empty_remote.all();
    Ok(drives.iter().map(|(label, entry)| EmptyRemotePayload::new(label, *entry)).collect())
}

/// Whether a confirmation may be written for a drive in `entry`'s state.
///
/// The member check comes first, as hcfs's own: the prompt never offers a
/// member the confirmation, so a member reaching here gets the reason, not
/// a refresh.
pub(crate) fn check_confirmable(entry: Option<EmptyRemoteEntry>, is_member: bool) -> Result<()> {
    if is_member {
        return Err(AppError::NotReady(NotReadyKind::EmptyRemoteMemberCannotConfirm));
    }
    if entry.is_none() {
        return Err(AppError::NotReady(NotReadyKind::EmptyRemoteNothingHeld));
    }
    Ok(())
}

/// hcfs refused `label`'s empty server listing with `synced_count` files in
/// its baseline. Records the report and, when it is new or changed,
/// publishes it off this thread.
pub(crate) fn report<R: Runtime>(app: &AppHandle<R>, label: &str, synced_count: usize) {
    let state = app.state::<AppState>();
    if state.empty_remote.record(label, synced_count) == Recorded::Unchanged {
        return;
    }
    warn!(label = %label, synced_count, "hcfs refused an empty server listing; nothing was deleted");

    // Without an account there is no drive to resolve; the next report
    // (hcfs retries with backoff) publishes it.
    let Ok(account_id) = state.current_account_id() else {
        return;
    };
    tauri::async_runtime::spawn(publish(app.clone(), account_id, label.to_string()));
}

/// Resolve whether this account may confirm `label`'s prompt, show it, and
/// save the episode's notification when this is its first showing.
async fn publish<R: Runtime>(app: AppHandle<R>, account_id: String, label: String) {
    let state = app.state::<AppState>();
    let Ok(pool) = state.pool().cloned() else {
        warn!(label = %label, "No database to resolve the empty drive's owner; shown on the next report");
        return;
    };
    // Unpublished on failure rather than guessed: the wrong guess either
    // offers a member a removal hcfs refuses, or tells an owner the drive
    // is someone else's. The next report retries.
    let identity = match crate::sync::identity::resolve_drive_identity(&pool, &account_id, &label).await {
        Ok(identity) => identity,
        Err(e) => {
            warn!(label = %label, error = %e, "Could not resolve the empty drive's owner; shown on the next report");
            return;
        }
    };

    let mut shown = None;
    let notify = state.empty_remote.publish(&label, !identity.is_member, |entry| {
        shown = Some(entry);
        let _ = app.emit(events::EMPTY_REMOTE_HELD, EmptyRemotePayload::new(&label, entry));
    });
    if let (true, Some(entry)) = (notify, shown) {
        save_notification(&app, &pool, &account_id, &label, entry).await;
    }
}

/// Save the episode's notification for `owner` (unless that account turned
/// Files notifications off), then tell the UI a row was added.
async fn save_notification<R: Runtime>(app: &AppHandle<R>, pool: &sqlx::SqlitePool, owner: &str, label: &str, entry: EmptyRemoteEntry) {
    let description = crate::sync::empty_remote::empty_remote_notification_text(label, entry);
    match crate::notifications::credits::create_empty_remote_notification(pool, owner, label, &description).await {
        Ok(Some(_)) => {
            let payload = events::LabelPayload { label: label.to_string() };
            let _ = app.emit(events::EMPTY_REMOTE_NOTIFY, payload);
        }
        Ok(None) => tracing::debug!(label = %label, "Files notifications are off; empty drive notification not saved"),
        Err(e) => warn!(label = %label, error = %e, "Could not save the empty drive notification"),
    }
}

/// A cycle for `label` started: an answer given before it is checked
/// against what it reports.
pub(crate) fn begin_cycle<R: Runtime>(app: &AppHandle<R>, label: &str) {
    app.state::<AppState>().empty_remote.begin_cycle(label);
}

/// `label`'s episode is over: hcfs accepted a listing (the files came back,
/// or the confirmation was applied), or the drive was removed. Takes the
/// prompt down. `try_state`: also called from hcfs's plan callback, which
/// can race app teardown and must not panic across the hcfs boundary.
pub(crate) fn end_episode<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    state.empty_remote.end(label, || {
        info!(label = %label, "Empty drive prompt cleared");
        emit_cleared(app, label);
    });
}

/// `label` stopped syncing: take its prompt down until a cycle reports it
/// again, keeping the episode so a resume does not notify again.
pub(crate) fn hide<R: Runtime>(app: &AppHandle<R>, label: &str) {
    app.state::<AppState>().empty_remote.hide(label, || emit_cleared(app, label));
}

fn emit_cleared<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let _ = app.emit(events::EMPTY_REMOTE_CLEARED, events::LabelPayload { label: label.to_string() });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: EmptyRemoteEntry = EmptyRemoteEntry {
        synced_count: 12,
        can_confirm: true,
    };

    fn subkind(result: Result<()>) -> serde_json::Value {
        let error = result.expect_err("refused");
        serde_json::to_value(error).expect("serialize")["subkind"].clone()
    }

    #[test]
    fn an_owner_may_confirm_a_refused_listing() {
        assert!(check_confirmable(Some(ENTRY), false).is_ok());
    }

    #[test]
    fn a_member_is_refused_whatever_the_state() {
        assert_eq!(subkind(check_confirmable(Some(ENTRY), true)), "EMPTY_REMOTE_MEMBER_CANNOT_CONFIRM");
        assert_eq!(subkind(check_confirmable(None, true)), "EMPTY_REMOTE_MEMBER_CANNOT_CONFIRM");
    }

    /// A mock app with an `AppState` and a channel receiving every
    /// `EMPTY_REMOTE_CLEARED` payload.
    fn app_hearing_clears() -> (tauri::App<tauri::test::MockRuntime>, std::sync::mpsc::Receiver<String>) {
        use tauri::Listener;

        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        let (tx, rx) = std::sync::mpsc::channel();
        app.handle().listen_any(events::EMPTY_REMOTE_CLEARED, move |event| {
            let _ = tx.send(event.payload().to_string());
        });
        (app, rx)
    }

    /// Record and publish a refusal for `label`, as a report does once the
    /// owner is resolved.
    fn shown(app: &tauri::App<tauri::test::MockRuntime>, label: &str) {
        let state = app.state::<AppState>();
        assert_eq!(state.empty_remote.record(label, 12), Recorded::Publish);
        state.empty_remote.publish(label, true, |_| {});
    }

    #[test]
    fn a_completed_cycle_or_a_removal_takes_the_prompt_down() {
        let (app, cleared) = app_hearing_clears();
        shown(&app, "photos");

        end_episode(app.handle(), "photos");

        let payload = cleared.recv_timeout(std::time::Duration::from_secs(5)).expect("the UI is told");
        assert_eq!(payload, r#"{"label":"photos"}"#);
        assert!(app.state::<AppState>().empty_remote.all().is_empty());

        end_episode(app.handle(), "photos");
        assert!(cleared.try_recv().is_err(), "nothing to take down twice");
    }

    #[test]
    fn a_stopped_drive_hides_its_prompt_and_keeps_its_episode() {
        let (app, cleared) = app_hearing_clears();
        shown(&app, "photos");

        hide(app.handle(), "photos");

        cleared.recv_timeout(std::time::Duration::from_secs(5)).expect("the UI is told");
        let state = app.state::<AppState>();
        assert_eq!(state.empty_remote.record("photos", 12), Recorded::Publish, "shown again on resume");
        assert!(!state.empty_remote.publish("photos", true, |_| {}), "without a second notification");
    }

    #[test]
    fn a_report_without_an_account_is_recorded_but_not_shown() {
        // The owner cannot be resolved; the next report retries.
        let (app, _cleared) = app_hearing_clears();

        report(app.handle(), "photos", 12);

        let state = app.state::<AppState>();
        assert!(state.empty_remote.all().is_empty());
        assert_eq!(state.empty_remote.record("photos", 12), Recorded::Publish, "still owed a showing");
    }

    #[test]
    fn a_drive_no_longer_refused_cannot_be_confirmed() {
        // A stale prompt must not leave a marker the next empty listing
        // would spend without asking.
        assert_eq!(subkind(check_confirmable(None, false)), "EMPTY_REMOTE_NOTHING_HELD");
    }
}
