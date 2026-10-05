//! IPC commands answering a held mass delete: restore the files, remove
//! them, or read the current holds.
//!
//! ## Why the desktop validates before hcfs does
//!
//! hcfs's `confirm_mass_delete` records the side and count it is given and
//! does not compare them with the hold at all (the cycle applies a tolerance
//! later). A dialog left open while the hold grew would therefore release a
//! larger delete than the user agreed to. Both commands check the side and
//! count against the hold the prompt was shown (`AppState.mass_delete_holds`)
//! and refuse with the same typed kinds hcfs's own refusals map to, so the
//! FE handles one set: nothing held, hold changed (with the new count), a
//! restore under way, a member who cannot restore.
//!
//! Membership is read from `sync_paths` (the authoritative identity), not
//! from the hold state: a throwaway `Drive` has no client, so hcfs cannot
//! refuse a member's local-side restore at request time.
//!
//! ## Lock-free
//!
//! Both requests are marker files in the drive's config directory. A
//! `DriveManager` built just for the request writes them without the syncing
//! manager's lock, which the engine holds for a whole cycle (minutes on a
//! large drive). The next cycle applies them; a sync round is triggered
//! straight away so the user does not wait for the heartbeat.

use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};
use crate::sync::events::MassDeleteHoldPayload;
use crate::sync::mass_delete_hold::{HoldEntry, HoldPhase};
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::sync::{MassDeleteRequestError, MassDeleteSide};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tracing::info;

/// Which answer the user gave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HoldAnswer {
    /// Put the files back on the side that lost them.
    Restore,
    /// Let the deletes go ahead.
    Remove,
}

/// Restore a drive's held mass delete: the next cycle downloads the files
/// missing here (`side = "server"`) or uploads the ones missing from Hippius
/// (`side = "local"`). `count` is the count the prompt showed.
///
/// # Errors
///
/// `Validation` for an unknown side; `NotReady` with subkind
/// `MASS_DELETE_NOTHING_HELD`, `MASS_DELETE_HOLD_CHANGED` (carrying `held`),
/// `MASS_DELETE_RESTORE_IN_PROGRESS` or `MASS_DELETE_MEMBER_CANNOT_RESTORE`;
/// `Hcfs` when the request cannot be written.
#[tauri::command]
pub async fn restore_mass_delete(app: AppHandle, label: String, side: String, count: usize) -> Result<()> {
    answer_hold(&app, &label, &side, count, HoldAnswer::Restore).await
}

/// Remove a drive's held mass delete: the next cycle deletes the held files
/// from Hippius (`side = "server"`) or from this device (`side = "local"`).
///
/// # Errors
///
/// As [`restore_mass_delete`], except that a member may remove.
#[tauri::command]
pub async fn confirm_mass_delete(app: AppHandle, label: String, side: String, count: usize) -> Result<()> {
    answer_hold(&app, &label, &side, count, HoldAnswer::Remove).await
}

/// Every drive's current hold, for the prompt to hydrate on start or reload.
///
/// # Errors
///
/// Never in practice; `Result` for the IPC convention.
#[tauri::command]
pub async fn get_mass_delete_holds(state: tauri::State<'_, AppState>) -> Result<Vec<MassDeleteHoldPayload>> {
    Ok(state.mass_delete_holds.all().iter().map(MassDeleteHoldPayload::from).collect())
}

/// Validate the answer against the hold, write it for the next cycle, and
/// start a sync round.
async fn answer_hold(app: &AppHandle, label: &str, side: &str, count: usize, answer: HoldAnswer) -> Result<()> {
    let side = parse_side(side)?;
    let state = app.state::<AppState>();
    let pool = state.pool()?;
    let account_id = state.current_account_id()?;

    let identity = crate::sync::identity::resolve_drive_identity(pool, &account_id, label).await?;
    let can_restore = !(identity.is_member && side == MassDeleteSide::Local);
    let entry = state.mass_delete_holds.entry(label, side);
    validate_answer(entry, side, count, answer, can_restore).map_err(request_error)?;

    let sync_root = PathBuf::from(crate::sync::config::get_sync_path_for_label(pool, &account_id, label).await?);
    let config_dir = crate::sync::mnemonic::config_dir_for_folder(&account_id, label)?;
    tokio::task::spawn_blocking(move || write_answer(sync_root, config_dir, side, count, answer))
        .await
        .map_err(|e| AppError::Other(format!("mass delete request task failed: {e}")))?
        .map_err(request_error)?;
    info!(label = %label, side = side.as_str(), count, ?answer, "Answered a held mass delete");

    // hcfs has no per-drive trigger; a round syncs every drive, which is
    // what the heartbeat would do shortly anyway. Detached: a whole cycle
    // must not hold the IPC open.
    let sync = std::sync::Arc::clone(&state.sync);
    tauri::async_runtime::spawn(async move {
        let _ = hcfs_client::engine::runner::trigger_sync(&sync).await;
    });
    Ok(())
}

/// Parse the side the FE sends (`"server"` / `"local"`).
fn parse_side(side: &str) -> Result<MassDeleteSide> {
    side.parse()
        .map_err(|_| AppError::Validation(format!("Unknown mass delete side {side:?}")))
}

/// Check an answer against the hold the prompt was shown.
///
/// Exact count: the prompt always shows the latest hold (a changed one is
/// re-emitted), so any difference means the user agreed to something else.
/// A member's local-side restore is refused first, as hcfs does, so the
/// prompt hides Restore whatever the hold's state.
pub(crate) fn validate_answer(
    entry: Option<HoldEntry>,
    side: MassDeleteSide,
    count: usize,
    answer: HoldAnswer,
    can_restore: bool,
) -> std::result::Result<(), MassDeleteRequestError> {
    if answer == HoldAnswer::Restore && !can_restore {
        return Err(MassDeleteRequestError::MemberCannotRestore);
    }
    let Some(entry) = entry else {
        return Err(MassDeleteRequestError::NothingHeld { side });
    };
    if entry.phase == HoldPhase::Restoring {
        return Err(MassDeleteRequestError::RestoreInProgress { side });
    }
    if entry.count != count {
        return Err(MassDeleteRequestError::HoldChanged {
            side,
            held: entry.count,
            shown: count,
        });
    }
    Ok(())
}

/// Write the answer as hcfs's marker for the drive's next cycle, on a
/// manager built just for this (never initialized, so lock-free).
pub(crate) fn write_answer(
    sync_root: PathBuf,
    config_dir: PathBuf,
    side: MassDeleteSide,
    count: usize,
    answer: HoldAnswer,
) -> std::result::Result<(), MassDeleteRequestError> {
    let manager = DriveManager::new(sync_root, config_dir);
    match answer {
        HoldAnswer::Restore => manager.restore_mass_delete(side, count).map(|_| ()),
        HoldAnswer::Remove => manager.confirm_mass_delete(side, count),
    }
}

/// Map hcfs's typed refusal to the `NotReady` subkinds the FE matches on.
pub(crate) fn request_error(error: MassDeleteRequestError) -> AppError {
    match error {
        MassDeleteRequestError::NothingHeld { .. } => AppError::NotReady(NotReadyKind::MassDeleteNothingHeld),
        MassDeleteRequestError::HoldChanged { held, .. } => AppError::NotReady(NotReadyKind::MassDeleteHoldChanged { held }),
        MassDeleteRequestError::RestoreInProgress { .. } => AppError::NotReady(NotReadyKind::MassDeleteRestoreInProgress),
        MassDeleteRequestError::MemberCannotRestore => AppError::NotReady(NotReadyKind::MassDeleteMemberCannotRestore),
        MassDeleteRequestError::Failed { message } => AppError::Hcfs(message),
        // `#[non_exhaustive]`: a future kind still fails, with hcfs's text.
        other => AppError::Hcfs(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use MassDeleteSide::{Local, Server};

    fn held(count: usize) -> Option<HoldEntry> {
        Some(HoldEntry {
            phase: HoldPhase::Held,
            count,
            synced_count: 300,
            empty_root: false,
        })
    }

    fn subkind(error: MassDeleteRequestError) -> serde_json::Value {
        serde_json::to_value(request_error(error)).expect("serialize")
    }

    #[test]
    fn the_shown_hold_is_accepted_for_either_answer() {
        assert_eq!(validate_answer(held(150), Server, 150, HoldAnswer::Restore, true), Ok(()));
        assert_eq!(
            validate_answer(held(150), Local, 150, HoldAnswer::Remove, false),
            Ok(()),
            "a member may remove"
        );
    }

    #[test]
    fn a_hold_that_changed_is_refused_with_the_new_count() {
        let refused = validate_answer(held(180), Server, 150, HoldAnswer::Remove, true);
        assert_eq!(
            refused,
            Err(MassDeleteRequestError::HoldChanged {
                side: Server,
                held: 180,
                shown: 150
            }),
            "removing must never cover more files than the user was shown"
        );
        assert!(
            validate_answer(held(120), Server, 150, HoldAnswer::Remove, true).is_err(),
            "nor different ones"
        );
    }

    #[test]
    fn nothing_held_and_restoring_are_refused() {
        assert_eq!(
            validate_answer(None, Local, 150, HoldAnswer::Remove, true),
            Err(MassDeleteRequestError::NothingHeld { side: Local })
        );

        let restoring = held(150).map(|e| HoldEntry {
            phase: HoldPhase::Restoring,
            ..e
        });
        assert_eq!(
            validate_answer(restoring, Server, 150, HoldAnswer::Remove, true),
            Err(MassDeleteRequestError::RestoreInProgress { side: Server })
        );
    }

    #[test]
    fn a_member_cannot_restore_the_local_side() {
        assert_eq!(
            validate_answer(held(150), Local, 150, HoldAnswer::Restore, false),
            Err(MassDeleteRequestError::MemberCannotRestore)
        );
    }

    #[test]
    fn refusals_map_to_the_subkinds_the_frontend_matches() {
        assert_eq!(
            subkind(MassDeleteRequestError::NothingHeld { side: Server })["subkind"],
            "MASS_DELETE_NOTHING_HELD"
        );
        let changed = subkind(MassDeleteRequestError::HoldChanged {
            side: Server,
            held: 9,
            shown: 4,
        });
        assert_eq!(changed["subkind"], "MASS_DELETE_HOLD_CHANGED");
        assert_eq!(changed["held"], 9);
        assert_eq!(
            subkind(MassDeleteRequestError::RestoreInProgress { side: Local })["subkind"],
            "MASS_DELETE_RESTORE_IN_PROGRESS"
        );
        assert_eq!(
            subkind(MassDeleteRequestError::MemberCannotRestore)["subkind"],
            "MASS_DELETE_MEMBER_CANNOT_RESTORE"
        );
        assert_eq!(subkind(MassDeleteRequestError::Failed { message: "disk full".into() })["kind"], "Hcfs");
    }

    #[test]
    fn unknown_sides_are_a_validation_error() {
        assert_eq!(parse_side("server").ok(), Some(Server));
        assert_eq!(parse_side("local").ok(), Some(Local));
        assert!(matches!(parse_side("both"), Err(AppError::Validation(_))));
    }

    /// The fixture hcfs writes after a cycle that held `count` server-side
    /// deletes (`mass_delete_held.json`: ids are 64 hex digits each).
    fn write_held_record(config_dir: &std::path::Path, count: usize) {
        let ids: Vec<String> = (0..count).map(|n| format!("{n:064x}")).collect();
        let record = serde_json::json!([{ "side": "server", "state": "held", "synced_count": 300, "held_at": 1, "ids": ids }]);
        std::fs::write(config_dir.join("mass_delete_held.json"), record.to_string()).expect("write held record");
    }

    /// End to end against hcfs's real marker files: a restore writes its
    /// marker, a removal withdraws it and writes the confirmation, and a
    /// restore of a hold that grew past hcfs's tolerance is refused by hcfs
    /// itself with the same typed kind.
    #[test]
    fn answers_write_hcfs_markers_without_the_drive_lock() {
        let root = tempfile::tempdir().expect("root");
        let config = tempfile::tempdir().expect("config");
        write_held_record(config.path(), 150);
        let write = |count, answer| write_answer(root.path().into(), config.path().into(), Server, count, answer);

        write(150, HoldAnswer::Restore).expect("restore accepted");
        assert!(config.path().join("restore_mass_delete_server").exists(), "restore marker written");

        write(150, HoldAnswer::Remove).expect("removal accepted");
        assert!(!config.path().join("restore_mass_delete_server").exists(), "the latest answer wins");
        assert!(config.path().join("confirm_mass_delete").exists(), "confirmation marker written");

        assert!(matches!(
            write(100, HoldAnswer::Restore),
            Err(MassDeleteRequestError::HoldChanged { held: 150, .. })
        ));

        let empty = tempfile::tempdir().expect("empty config");
        let nothing = write_answer(root.path().into(), empty.path().into(), Local, 5, HoldAnswer::Restore);
        assert_eq!(nothing, Err(MassDeleteRequestError::NothingHeld { side: Local }));
    }
}
