//! "Skip Trash when deleting", and who may delete forever where.
//!
//! The setting is per account (a `user_preferences` row, the key the
//! webview used before Rust owned it, so a saved choice carries over). It
//! decides two things, kept the same on purpose:
//!
//! - **Delete in the app** removes for good, after a confirm, instead of
//!   moving to Trash.
//! - **A delete in Finder** (a local delete the sync engine sends): the
//!   engine sends it to Trash unless the drive's config directory holds
//!   hcfs-client's `delete_permanently` marker. This module writes that
//!   marker through `DriveManager::set_delete_to_trash`, for every drive on
//!   a change and for each drive as it starts.
//!
//! Both apply to the account's OWN drives only. In a drive shared with it,
//! deletes always go to Trash: an Editor may not delete forever there, and
//! a Manager's permanent delete stays the deliberate "Delete forever",
//! never the side effect of a setting or a delete in Finder.

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use serde::Serialize;
use std::path::PathBuf;
use tracing::{info, warn};

/// The `user_preferences` key, per account.
pub fn skip_trash_key(account_id: &str) -> String {
    format!("drive_skip_trash:{account_id}")
}

/// Read a stored value: JSON `true` is on, anything else (absent, `false`,
/// unreadable) is off, the default.
pub fn parse_skip_trash(stored: Option<&str>) -> bool {
    stored.and_then(|v| serde_json::from_str::<bool>(v).ok()).unwrap_or(false)
}

/// Whether the engine sends a drive's local deletes to Trash: always on a
/// drive shared with this account, else unless Skip Trash is on.
pub fn engine_deletes_to_trash(skip_trash: bool, is_member: bool) -> bool {
    is_member || !skip_trash
}

pub async fn read_skip_trash(pool: &sqlx::SqlitePool, account_id: &str) -> bool {
    match crate::utils::preferences::get_user_preference_internal(pool, &skip_trash_key(account_id)).await {
        Ok(value) => parse_skip_trash(value.as_deref()),
        Err(e) => {
            warn!(error = %e, "Skip Trash could not be read; deletes go to Trash");
            false
        }
    }
}

/// Write the engine's marker for one drive: lock-free, through a
/// never-initialized `DriveManager` over its config directory, as the
/// large-delete answers are written. The engine reads it at the start of
/// each cycle, so a running cycle keeps its route.
pub(crate) fn write_engine_setting(sync_root: PathBuf, config_dir: PathBuf, to_trash: bool) -> std::result::Result<(), String> {
    let manager = hcfs_client::engine::manager::DriveManager::new(sync_root, config_dir);
    manager.set_delete_to_trash(to_trash)
}

/// The drive init funnel's call: bring the drive's engine setting in line
/// with the account's before its first cycle. Never fails the init.
pub(crate) async fn apply_to_drive(pool: &sqlx::SqlitePool, account_id: &str, is_member: bool, sync_root: PathBuf, config_dir: PathBuf) {
    let to_trash = engine_deletes_to_trash(read_skip_trash(pool, account_id).await, is_member);
    match tokio::task::spawn_blocking(move || write_engine_setting(sync_root, config_dir, to_trash)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => warn!(error = %e, "The drive's Trash setting could not be written"),
        Err(e) => warn!(error = %e, "The drive's Trash setting could not be written"),
    }
}

/// Save Skip Trash and apply it to every drive synced here.
#[tauri::command]
pub async fn set_skip_trash(state: tauri::State<'_, AppState>, account_id: String, skip: bool) -> Result<()> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    crate::utils::preferences::save_user_preference_internal(pool, &skip_trash_key(&account_id), if skip { "true" } else { "false" }).await?;
    let mut drives = Vec::new();
    for row in crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "set_skip_trash").await {
        if row.label == "migration" {
            continue;
        }
        let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &row.label).await?;
        let config_dir = crate::sync::mnemonic::config_dir_for_folder(&account_id, &row.label)?;
        drives.push((PathBuf::from(row.path), config_dir, engine_deletes_to_trash(skip, identity.is_member)));
    }
    let failed = tokio::task::spawn_blocking(move || {
        drives
            .into_iter()
            .filter(|(root, dir, to_trash)| write_engine_setting(root.clone(), dir.clone(), *to_trash).is_err())
            .count()
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;
    info!(skip, failed, "Skip Trash saved");
    if failed > 0 {
        return Err(AppError::Validation(
            "The setting was saved, but some drives couldn't take it yet. It applies when they next start.".into(),
        ));
    }
    Ok(())
}

/// One drive's delete rules, for the webview to pick the words and the
/// confirm before it asks Rust (which checks again).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveDeleteRule {
    pub label: String,
    /// The account owns the drive or manages it.
    pub can_delete_forever: bool,
    /// Delete removes for good here (Skip Trash on, own drive).
    pub skips_trash: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrashDeleteRules {
    pub skip_trash: bool,
    pub drives: Vec<DriveDeleteRule>,
}

pub fn rule_for(label: &str, own: bool, manager: bool, skip_trash: bool) -> DriveDeleteRule {
    DriveDeleteRule {
        label: label.to_string(),
        can_delete_forever: own || manager,
        skips_trash: own && skip_trash,
    }
}

/// Pure: the rules of every drive this account can delete in, synced here
/// or browsed from the server. An own drive browsed from the server is
/// still the account's: Delete forever and Skip Trash work there as on a
/// synced one. A drive shared with the account never skips Trash, and only
/// a Manager may delete forever there.
pub fn rules_for_drives(drives: &[crate::sync::drive_move::MoveDestination], skip_trash: bool) -> Vec<DriveDeleteRule> {
    drives.iter().map(|d| rule_for(&d.label, !d.shared, d.manager, skip_trash)).collect()
}

/// Pure: whether Delete forever may run in `label`. A drive the rules do
/// not list (a folder shared on its own, a Viewer's drive, one added since)
/// may not: there only Move to Trash, which can be undone.
pub fn may_delete_forever(rules: &[DriveDeleteRule], label: &str) -> bool {
    rules.iter().any(|r| r.label == label && r.can_delete_forever)
}

pub(crate) async fn delete_rules(state: &AppState, account_id: &str) -> Result<TrashDeleteRules> {
    let skip_trash = read_skip_trash(state.pool()?, account_id).await;
    let drives = crate::sync::drive_move::list_move_destinations_inner(state, account_id).await?;
    Ok(TrashDeleteRules {
        skip_trash,
        drives: rules_for_drives(&drives, skip_trash),
    })
}

/// The delete rules of every drive this account can delete in: its own
/// drives (synced here or browsed from the server) and the drives shared
/// with it as an Editor or Manager. A drive shared as a Viewer, or a folder
/// shared on its own, is not listed: the webview offers only Move to Trash
/// there, and the server decides.
#[tauri::command]
pub async fn get_trash_delete_rules(state: tauri::State<'_, AppState>, account_id: String) -> Result<TrashDeleteRules> {
    let account_id = state.require_session_account(&account_id)?;
    delete_rules(&state, &account_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stored_value_is_the_json_the_webview_wrote() {
        assert_eq!(skip_trash_key("5Abc"), "drive_skip_trash:5Abc");
        assert!(parse_skip_trash(Some("true")));
        assert!(!parse_skip_trash(Some("false")));
        assert!(!parse_skip_trash(None), "off by default");
        assert!(!parse_skip_trash(Some("garbage")));
    }

    #[test]
    fn skip_trash_never_reaches_a_drive_shared_with_the_account() {
        assert!(!engine_deletes_to_trash(true, false), "own drive, Skip Trash on: permanent");
        assert!(engine_deletes_to_trash(false, false));
        assert!(engine_deletes_to_trash(true, true), "a shared drive always deletes to Trash");

        let own = rule_for("docs", true, true, true);
        assert!(own.can_delete_forever && own.skips_trash);
        let managed = rule_for("team", false, true, true);
        assert!(managed.can_delete_forever && !managed.skips_trash);
        let editor = rule_for("team", false, false, true);
        assert!(!editor.can_delete_forever && !editor.skips_trash);
    }

    fn drive(label: &str, remote: bool, shared: bool, manager: bool) -> crate::sync::drive_move::MoveDestination {
        crate::sync::drive_move::MoveDestination {
            label: label.into(),
            name: label.into(),
            remote,
            sync_path: (!remote).then(|| format!("/drives/{label}")),
            shared,
            manager,
        }
    }

    #[test]
    fn a_drive_browsed_from_the_server_keeps_the_rules_of_its_kind() {
        let drives = [
            drive("docs", false, false, true),
            drive("archive", true, false, true),
            drive("shared:5Owner~0123456789abcdef", true, true, false),
            drive("shared:5Boss~fedcba9876543210", true, true, true),
        ];
        let rules = rules_for_drives(&drives, true);
        let of = |label: &str| rules.iter().find(|r| r.label == label).cloned().unwrap();
        assert_eq!(
            of("archive"),
            of("docs").clone_with_label("archive"),
            "an own drive not synced here deletes the same way"
        );
        assert!(of("archive").can_delete_forever && of("archive").skips_trash);
        let editor = of("shared:5Owner~0123456789abcdef");
        assert!(!editor.can_delete_forever && !editor.skips_trash, "an Editor only moves to Trash");
        let manager = of("shared:5Boss~fedcba9876543210");
        assert!(
            manager.can_delete_forever && !manager.skips_trash,
            "Skip Trash never reaches a shared drive"
        );
    }

    impl DriveDeleteRule {
        fn clone_with_label(&self, label: &str) -> Self {
            Self {
                label: label.into(),
                ..self.clone()
            }
        }
    }

    #[test]
    fn the_setting_reaches_the_engine_through_its_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("drive");
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&config).unwrap();

        write_engine_setting(root.clone(), config.clone(), false).unwrap();
        assert!(config.join("delete_permanently").exists(), "hcfs-client's own marker name");
        let engine = hcfs_client::engine::manager::DriveManager::new(root.clone(), config.clone());
        assert!(!engine.delete_to_trash(), "the engine reads it as permanent");

        write_engine_setting(root.clone(), config.clone(), true).unwrap();
        assert!(!config.join("delete_permanently").exists());
        assert!(hcfs_client::engine::manager::DriveManager::new(root, config).delete_to_trash());
    }
}
