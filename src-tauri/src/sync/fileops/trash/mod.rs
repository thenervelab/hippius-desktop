//! Drive Trash: Move to Trash with Undo, Delete forever on a synced item,
//! and the Trash page's list, restore, delete forever and empty.
//!
//! Everything here is behind the server's `drive_trash` capability; each
//! command refuses without it, and the webview hides every Trash surface
//! until it is on. With it off, Delete stays today's permanent delete
//! (`files::delete_files`).
//!
//! Every call is hcfs-client's typed Trash call (`run`), so the contract
//! is hcfs-shared's. The sync engine sends a delete made in Finder to
//! Trash itself (or deletes it for good with "Skip Trash when deleting",
//! `setting`); an in-app delete never goes through the engine, so it can
//! offer Undo and report progress. With the drive's sync lock held it
//! trashes the item on the server, then moves the local copy into the
//! hold (`hold`), so the next cycle sees "both deleted" and sends nothing.
//! Delete forever does the same, then deletes the items forever and drops
//! the held copies. See "Drive Trash" in `.claude/rules/sync-engine.md`.
//!
//! No size limit anywhere: `run` carries any number of files through the
//! server's batches, reports progress on [`PROGRESS_EVENT`], and every step
//! is safe to repeat, so a stopped run resumes by running it again.

pub mod hold;
pub mod run;
pub mod setting;
pub mod wire;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::drive_move::{DriveLock, entry_path, list_move_destinations_inner, lock_drive, resolve_side, unsettled_folder};
use crate::sync::files::move_entries::{basename_of, join_path, keep_both_name, parent_of};
use crate::sync::files::{DeleteFilesResult, FileDeleteError, FileDeleteRequest};
use crate::sync::identity::{DriveIdentity, resolve_drive_identity_or_own};
use hcfs_client::client::HcfsClient;
use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem};
use run::{FileToTrash, KeepBoth};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tracing::{info, warn};
use wire::{RestoreConflict, TrashItemKind, TrashItemState, TrashRefusal, TrashRestoreMode};

/// Progress of a running Trash operation, for its toast.
pub const PROGRESS_EVENT: &str = "trash_progress";

/// What Rust says when the server has Trash switched off.
const UNAVAILABLE: &str = "Trash isn't available yet.";

/// What a Delete forever refuses in a drive where this account may not.
pub const NOT_YOURS_TO_DELETE: &str = "Only the drive's owner or a manager can delete items forever.";

/// One step of progress: `done` of `total` files (items for delete).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashProgress {
    pub job_id: String,
    /// `trash`, `restore`, `delete` or `empty`.
    pub action: &'static str,
    pub done: u64,
    pub total: u64,
}

struct Progress {
    app: Option<tauri::AppHandle>,
    job_id: String,
    action: &'static str,
    total: u64,
}

impl Progress {
    fn report(&self, done: u64) {
        if let Some(app) = &self.app {
            let _ = app.emit(
                PROGRESS_EVENT,
                TrashProgress {
                    job_id: self.job_id.clone(),
                    action: self.action,
                    done,
                    total: self.total,
                },
            );
        }
    }
}

/// One item moved into a hold, for Undo.
#[derive(Clone, Debug)]
struct HeldItem {
    label: String,
    root: PathBuf,
    rel: String,
    held: PathBuf,
    /// The Trash items it became; empty when the server named none, which
    /// leaves the item in Trash on Undo.
    item_ids: Vec<String>,
}

/// The holds whose Undo toast is still up, by token.
#[derive(Default)]
pub struct TrashHolds(std::sync::Mutex<HashMap<String, Vec<HeldItem>>>);

impl TrashHolds {
    fn put(&self, token: &str, items: Vec<HeldItem>) {
        if let Ok(mut holds) = self.0.lock() {
            holds.insert(token.to_string(), items);
        }
    }

    fn take(&self, token: &str) -> Option<Vec<HeldItem>> {
        self.0.lock().ok().and_then(|mut holds| holds.remove(token))
    }
}

/// One item to move to Trash, as the webview names a row to delete.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashFileRequest {
    pub name: String,
    pub source: Option<String>,
    pub label: Option<String>,
}

/// What Move to Trash did.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MoveToTrashResult {
    pub trashed: u32,
    pub failed: Vec<FileDeleteError>,
    /// The hold to pass to `undo_move_to_trash` or `release_trash_hold`.
    pub hold: Option<String>,
    /// Every trashed item can be brought back by Undo.
    pub undoable: bool,
    /// Days until the server deletes the items forever, for the toast.
    pub retention_days: u32,
    /// Every row that went to Trash, held here or not: (row, drive, items).
    #[serde(skip)]
    trashed_items: Vec<(usize, String, Vec<String>)>,
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

/// Refuse unless the server keeps a Trash; answers its retention in days.
async fn require_trash(state: &AppState, account_id: &str) -> Result<u32> {
    let caps = crate::shares::capabilities::fetch_capabilities(state, account_id).await?;
    if !caps.drive_trash {
        return Err(AppError::Validation(UNAVAILABLE.into()));
    }
    Ok(wire::retention_days(caps.trash_retention_days))
}

/// The drive-scoped hcfs client a label's Trash calls go through.
async fn drive_client(state: &AppState, account_id: &str, label: &str) -> Result<(DriveIdentity, HcfsClient)> {
    let pool = state.pool()?;
    let identity = resolve_drive_identity_or_own(pool, account_id, label).await?;
    let client = crate::sync::remote::build_client(pool, account_id, &identity).await?;
    Ok((identity, client))
}

fn refusal(refusal: TrashRefusal) -> AppError {
    AppError::Validation(refusal.sentence())
}

/// Which delete a run is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// Move to Trash, with Undo.
    Trash,
    /// Delete forever: through Trash, then deleted from it at once.
    Forever,
}

// ---------------------------------------------------------------------------
// Move to Trash
// ---------------------------------------------------------------------------

/// Move synced files and folders to Trash. No confirm: Undo
/// (`undo_move_to_trash`) brings them back while its toast is up, and the
/// Trash page after that.
#[tauri::command]
pub async fn move_to_trash(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    job_id: String,
    files: Vec<TrashFileRequest>,
) -> Result<MoveToTrashResult> {
    let account_id = state.require_session_account(&account_id)?;
    let retention_days = require_trash(&state, &account_id).await?;
    let progress = Progress {
        app: Some(app.clone()),
        job_id,
        action: "trash",
        total: 0,
    };
    let (mut result, folder_labels) = move_to_trash_inner(&state, &progress, &account_id, &files, Kind::Trash).await?;
    result.retention_days = retention_days;
    after_local_removal(&state, &app, &account_id, folder_labels).await;
    Ok(result)
}

/// A sync round, and the forced folder reconcile a removed directory needs
/// (as `delete_files` runs it).
async fn after_local_removal(state: &AppState, app: &tauri::AppHandle, account_id: &str, folder_labels: Vec<String>) {
    let _ = hcfs_client::engine::runner::trigger_sync(&state.sync).await;
    for label in folder_labels {
        crate::sync::folder_entries_materialize::spawn_folder_entity_sync(
            app.clone(),
            account_id.to_string(),
            label,
            crate::sync::folder_entries_materialize::FolderEntitySyncTrigger::Forced,
        );
    }
}

/// One row to trash, read from disk and the server.
struct Target {
    index: usize,
    rel: String,
    is_dir: bool,
    size: u64,
    files: Vec<FileToTrash>,
    /// Delete forever of a file not on Hippius yet: only the local copy.
    local_only: bool,
}

async fn move_to_trash_inner(
    state: &AppState,
    progress: &Progress,
    account_id: &str,
    files: &[TrashFileRequest],
    kind: Kind,
) -> Result<(MoveToTrashResult, Vec<String>)> {
    let pool = state.pool()?;
    let label_to_path: HashMap<String, String> = crate::sync::folders::get_all_sync_paths_or_warn(pool, account_id, "move_to_trash")
        .await
        .into_iter()
        .map(|sp| (sp.label, sp.path))
        .collect();

    let mut result = MoveToTrashResult::default();
    let fail = |result: &mut MoveToTrashResult, index: usize, error: String| {
        result.failed.push(FileDeleteError {
            name: files[index].name.clone(),
            error,
        });
    };
    // Group by drive; an explicitly named drive must exist (never the
    // default drive in its place, as `delete_files`).
    let mut by_label: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, file) in files.iter().enumerate() {
        let label = file.label.clone().unwrap_or_else(|| "default".to_string());
        if label_to_path.contains_key(&label) {
            by_label.entry(label).or_default().push(index);
        } else {
            fail(&mut result, index, "This item's drive isn't synced on this computer.".into());
        }
    }

    let token = hold::new_token(now_millis());
    let mut held_all = Vec::new();
    let mut folder_labels = Vec::new();
    for (label, indexes) in by_label {
        let root_str = label_to_path[&label].clone();
        let root = PathBuf::from(&root_str);
        let drive = DriveRequest {
            label: &label,
            root: &root,
            root_str: &root_str,
            token: &token,
            kind,
        };
        match trash_in_drive(state, account_id, &drive, files, &indexes, progress).await {
            Ok(outcome) => {
                result.trashed += outcome.trashed;
                result
                    .trashed_items
                    .extend(outcome.trashed_items.into_iter().map(|(index, ids)| (index, label.clone(), ids)));
                for (index, error) in outcome.failed {
                    fail(&mut result, index, error);
                }
                if outcome.held.iter().any(|h| h.held.is_dir()) {
                    folder_labels.push(label.clone());
                }
                held_all.extend(outcome.held);
            }
            Err(e) => {
                warn!(error = %e, "Move to Trash: a drive could not be read");
                for index in indexes {
                    fail(&mut result, index, e.to_string());
                }
            }
        }
    }

    if !held_all.is_empty() {
        result.undoable = result.trashed as usize == held_all.len() && held_all.iter().all(|h| !h.item_ids.is_empty());
        result.hold = Some(token.clone());
        state.trash_holds.put(&token, held_all);
    }
    info!(
        trashed = result.trashed,
        failed = result.failed.len(),
        forever = kind == Kind::Forever,
        "Move to Trash completed"
    );
    Ok((result, folder_labels))
}

#[derive(Default)]
struct DriveOutcome {
    trashed: u32,
    failed: Vec<(usize, String)>,
    held: Vec<HeldItem>,
    /// Every row that went to Trash, and its items.
    trashed_items: Vec<(usize, Vec<String>)>,
}

struct DriveRequest<'a> {
    label: &'a str,
    root: &'a Path,
    root_str: &'a str,
    token: &'a str,
    kind: Kind,
}

/// Move one drive's rows to Trash: read them, trash them on the server with
/// the drive's sync lock held, then hold the local copies.
#[allow(clippy::too_many_lines)]
async fn trash_in_drive(
    state: &AppState,
    account_id: &str,
    drive: &DriveRequest<'_>,
    files: &[TrashFileRequest],
    indexes: &[usize],
    progress_base: &Progress,
) -> Result<DriveOutcome> {
    let DriveRequest {
        label,
        root,
        root_str,
        token,
        kind,
    } = *drive;
    let mnemonic = crate::sync::remote::session_mnemonic(state)?;
    let (side, _) = resolve_side(state, account_id, label, &mnemonic).await?;
    drop(mnemonic);
    let (ss58, fh) = (side.identity.wire_ss58.clone(), side.identity.wire_folder_hash.clone());
    let swept = hold::sweep_stale(root, now_millis());
    if swept > 0 {
        info!(swept, "Move to Trash: stale holds removed");
    }

    let mut out = DriveOutcome::default();
    let mut targets = Vec::new();
    let mut parents: HashMap<String, Vec<hcfs_shared::network::RemoteFileEntry>> = HashMap::new();
    for &index in indexes {
        let file = &files[index];
        let rel = crate::sync::files::pathops::derive_relative_name(root_str, file.source.as_deref(), &file.name)
            .replace('\\', "/")
            .trim_matches('/')
            .to_string();
        let name = basename_of(&rel).to_string();
        if rel.is_empty() || crate::sync::files::pathops::ensure_within(root, &root.join(&rel)).is_err() {
            out.failed.push((index, "This item isn't inside its drive's folder.".into()));
            continue;
        }
        let abs = root.join(&rel);
        let Ok(meta) = abs.symlink_metadata() else {
            out.failed.push((index, format!("\"{name}\" is no longer in this folder.")));
            continue;
        };
        let wire = join_path(side.wire_root.trim_matches('/'), &rel);
        if meta.is_dir() {
            let tree = crate::sync::remote_rename::collect_folder_tree(&side.client, &ss58, &fh, &wire, &side.key).await?;
            // Undo needs the local copy to match Hippius. Delete forever
            // removes both whatever they hold.
            if kind == Kind::Trash && unsettled_folder(root, &rel, &tree) {
                out.failed.push((
                    index,
                    format!("\"{name}\" has changes that are still syncing. Try again when sync finishes."),
                ));
                continue;
            }
            targets.push(Target {
                index,
                rel,
                is_dir: true,
                size: tree.files.iter().map(|f| f.size_bytes).sum(),
                files: tree
                    .files
                    .iter()
                    .map(|f| FileToTrash {
                        path_hash: f.path_hash,
                        revision_id: f.revision_id,
                    })
                    .collect(),
                local_only: false,
            });
            continue;
        }
        let parent = parent_of(&wire).to_string();
        if !parents.contains_key(&parent) {
            let (_, listed) = crate::sync::remote_rename::browse_directory(&side.client, &ss58, &fh, &parent).await?;
            parents.insert(parent.clone(), listed);
        }
        let found = parents[&parent]
            .iter()
            .find(|entry| entry_path(entry, &side.key).as_deref() == Some(wire.as_str()));
        match (found, kind) {
            (Some(entry), _) => targets.push(Target {
                index,
                rel,
                is_dir: false,
                size: entry.size_bytes,
                files: vec![FileToTrash {
                    path_hash: entry.path_hash,
                    revision_id: entry.revision_id,
                }],
                local_only: false,
            }),
            (None, Kind::Forever) => targets.push(Target {
                index,
                rel,
                is_dir: false,
                size: meta.len(),
                files: Vec::new(),
                local_only: true,
            }),
            (None, Kind::Trash) => out.failed.push((index, format!("\"{name}\" hasn't finished uploading yet."))),
        }
    }
    if targets.is_empty() {
        return Ok(out);
    }

    let total: u64 = targets.iter().map(|t| t.files.len().max(1) as u64).sum();
    let progress = Progress {
        app: progress_base.app.clone(),
        job_id: progress_base.job_id.clone(),
        action: progress_base.action,
        total,
    };
    progress.report(0);
    let mut done_before = 0u64;

    // No cycle runs between the server's answer and the hold, so the engine
    // never sees the item gone on one side only.
    let lock = lock_drive(state, label).await;
    let mut trashed: Vec<(&Target, Vec<String>)> = Vec::new();

    for target in targets.iter().filter(|t| t.local_only) {
        trashed.push((target, Vec::new()));
        done_before += 1;
    }

    let loose: Vec<&Target> = targets.iter().filter(|t| !t.is_dir && !t.local_only).collect();
    if !loose.is_empty() {
        let batch: Vec<FileToTrash> = loose.iter().flat_map(|t| t.files.clone()).collect();
        let base = done_before;
        let sent = run::trash_files(&side.client, &ss58, &fh, &batch, |n| progress.report(base + n)).await;
        done_before += batch.len() as u64;
        match sent {
            Ok(outcome) => {
                let kept: HashMap<&str, &str> = outcome.kept.iter().map(|(id, code)| (id.as_str(), code.as_str())).collect();
                for target in loose {
                    let id = wire::file_id(&target.files[0].path_hash);
                    match kept.get(id.as_str()) {
                        Some(code) => out.failed.push((target.index, kept_sentence(&target.rel, code))),
                        None => trashed.push((target, outcome.item_of_file.get(&id).cloned().into_iter().collect())),
                    }
                }
            }
            Err(r) => {
                for target in loose {
                    out.failed.push((target.index, r.sentence()));
                }
            }
        }
    }

    for target in targets.iter().filter(|t| t.is_dir) {
        let wire_rel = join_path(side.wire_root.trim_matches('/'), &target.rel);
        // The item's id is picked here and recorded before the first call,
        // so trashing the folder again after a stop continues the same item.
        let item_id = hold::resumed_item(root, &target.rel).unwrap_or_else(run::new_item_id);
        let remember = |item: &str| {
            if let Err(e) = hold::remember_item(root, &target.rel, item) {
                warn!(error = %e, "Move to Trash: the resume journal could not be written");
            }
        };
        remember(&item_id);
        let base = done_before;
        let sent = run::trash_folder(&side.client, &ss58, &fh, &wire_rel, &target.files, &item_id, remember, |n| {
            progress.report(base + n);
        })
        .await;
        done_before += target.files.len().max(1) as u64;
        match sent {
            Ok(outcome) => {
                hold::forget_item(root, &target.rel);
                if let Some((_, code)) = outcome.kept.first() {
                    // Part of the folder stayed live: leave the folder to the
                    // engine, which removes what was trashed and keeps the rest.
                    out.failed.push((target.index, kept_sentence(&target.rel, code)));
                } else {
                    trashed.push((target, outcome.folder_item.into_iter().collect()));
                }
            }
            Err(r) => {
                // The item is gone (restored or deleted forever elsewhere):
                // nothing to continue. Otherwise the journal keeps it, and
                // trashing the folder again resumes it.
                if r.is("item_not_found") {
                    hold::forget_item(root, &target.rel);
                }
                out.failed.push((target.index, r.sentence()));
            }
        }
    }
    progress.report(total);

    let can_hold = !matches!(lock, DriveLock::Busy);
    for (target, item_ids) in trashed {
        out.trashed += 1;
        out.trashed_items.push((target.index, item_ids.clone()));
        crate::sync::files::invalidate_dir_stats_for_change(root, &root.join(&target.rel));
        state.sync.update_state(label, |st| {
            st.add_activity(SyncActivityItem {
                file_name: std::sync::Arc::from(target.rel.as_str()),
                action: SyncActivityAction::Deleted,
                timestamp: chrono::Utc::now().timestamp(),
                size_bytes: target.size,
                label: std::sync::Arc::from(label),
            });
        });
        if !can_hold && !target.local_only {
            // A cycle held the lock past the wait: it removes the local copy
            // itself once it sees the item gone from Hippius.
            continue;
        }
        match hold::hold(root, &target.rel, token) {
            Ok(held) => out.held.push(HeldItem {
                label: label.to_string(),
                root: root.to_path_buf(),
                rel: target.rel.clone(),
                held,
                item_ids,
            }),
            Err(e) => warn!(error = %e, "Move to Trash: the local copy could not be held; sync removes it"),
        }
    }
    drop(lock);
    Ok(out)
}

/// Why the server kept a file, in words.
fn kept_sentence(rel: &str, code: &str) -> String {
    let name = basename_of(rel);
    match code {
        "conflict" => format!("\"{name}\" changed on another device, so it was kept."),
        _ => format!("Hippius couldn't move \"{name}\" to Trash."),
    }
}

/// What Undo brought back.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UndoTrashResult {
    pub restored: u32,
    /// Items that stayed in Trash (their name was taken meanwhile).
    pub left_in_trash: u32,
}

/// Undo a Move to Trash: restore the items on the server and put the held
/// copies back, so sync downloads nothing.
#[tauri::command]
pub async fn undo_move_to_trash(state: tauri::State<'_, AppState>, account_id: String, hold: String) -> Result<UndoTrashResult> {
    let account_id = state.require_session_account(&account_id)?;
    let Some(items) = state.trash_holds.take(&hold) else {
        return Ok(UndoTrashResult::default());
    };
    let outcome = undo_inner(&state, &account_id, &items).await;
    let roots: HashSet<PathBuf> = items.iter().map(|i| i.root.clone()).collect();
    for root in roots {
        hold::release(&root, &hold);
    }
    let _ = hcfs_client::engine::runner::trigger_sync(&state.sync).await;
    outcome
}

async fn undo_inner(state: &AppState, account_id: &str, items: &[HeldItem]) -> Result<UndoTrashResult> {
    let mut by_label: BTreeMap<&str, Vec<&HeldItem>> = BTreeMap::new();
    for item in items {
        by_label.entry(item.label.as_str()).or_default().push(item);
    }
    let mut result = UndoTrashResult::default();
    for (label, held) in by_label {
        let (identity, client) = drive_client(state, account_id, label).await?;
        let ids: Vec<String> = held.iter().flat_map(|h| h.item_ids.clone()).collect();
        let lock = lock_drive(state, label).await;
        let answer = if ids.is_empty() {
            run::RestoreAnswer::default()
        } else {
            run::restore_in_place(
                &client,
                &identity.wire_ss58,
                &identity.wire_folder_hash,
                &ids,
                RestoreConflict::Fail,
                |_| {},
            )
            .await
            .map_err(refusal)?
        };
        for item in held {
            let back = !item.item_ids.is_empty() && item.item_ids.iter().all(|id| answer.restored.contains(id));
            if !back {
                result.left_in_trash += 1;
                continue;
            }
            result.restored += 1;
            if matches!(lock, DriveLock::Busy) {
                continue;
            }
            match hold::put_back(&item.root, &item.rel, &item.held) {
                Ok(true) => crate::sync::files::invalidate_dir_stats_for_change(&item.root, &item.root.join(&item.rel)),
                // Taken meanwhile, or the rename failed: sync downloads the
                // restored item instead.
                Ok(false) => {}
                Err(e) => warn!(error = %e, "Undo: a held copy could not be put back; sync downloads it"),
            }
        }
        drop(lock);
    }
    Ok(result)
}

/// The Undo toast closed: the held copies are no longer needed (the items
/// are in Hippius Trash).
#[tauri::command]
pub async fn release_trash_hold(state: tauri::State<'_, AppState>, hold: String) -> Result<()> {
    if let Some(items) = state.trash_holds.take(&hold) {
        release_held(items, hold).await?;
    }
    Ok(())
}

async fn release_held(items: Vec<HeldItem>, token: String) -> Result<()> {
    let roots: HashSet<PathBuf> = items.into_iter().map(|i| i.root).collect();
    tokio::task::spawn_blocking(move || {
        for root in roots {
            hold::release(&root, &token);
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))
}

// ---------------------------------------------------------------------------
// Delete forever, from a drive
// ---------------------------------------------------------------------------

/// Delete synced files and folders forever while the server has Trash.
///
/// Not `delete_files`: the engine would send that local delete to Trash.
/// Each item is trashed on the server and its local copy held, as Move to
/// Trash does, then the items are deleted forever and the held copies
/// dropped. A file not on Hippius yet only loses its local copy. Refused,
/// touching nothing, in a drive where this account may not delete forever
/// (an Editor of somebody else's drive).
#[tauri::command]
pub async fn delete_files_forever(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    job_id: String,
    files: Vec<FileDeleteRequest>,
) -> Result<DeleteFilesResult> {
    let account_id = state.require_session_account(&account_id)?;
    require_trash(&state, &account_id).await?;
    let rules = setting::delete_rules(&state, &account_id).await?;
    let allowed: HashSet<String> = rules.drives.iter().filter(|d| d.can_delete_forever).map(|d| d.label.clone()).collect();

    let mut failed = Vec::new();
    let mut deleted_flags = vec![false; files.len()];
    let mut requests = Vec::new();
    let mut request_index = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let label = file.label.clone().unwrap_or_else(|| "default".to_string());
        if allowed.contains(&label) {
            request_index.push(index);
            requests.push(TrashFileRequest {
                name: file.name.clone(),
                source: file.source.clone(),
                label: file.label.clone(),
            });
        } else {
            failed.push(FileDeleteError {
                name: file.name.clone(),
                error: NOT_YOURS_TO_DELETE.into(),
            });
        }
    }

    let progress = Progress {
        app: Some(app.clone()),
        job_id,
        action: "delete",
        total: 0,
    };
    let (moved, folder_labels) = move_to_trash_inner(&state, &progress, &account_id, &requests, Kind::Forever).await?;
    failed.extend(moved.failed);
    let held = moved.hold.as_deref().and_then(|token| state.trash_holds.take(token)).unwrap_or_default();

    // Delete forever what went to Trash, by drive, held here or not (a
    // cycle that kept the lock removes an unheld copy itself). A refusal
    // leaves those items in Trash, where the Trash page can still delete or
    // restore them.
    let mut by_label: BTreeMap<&str, Vec<(usize, &Vec<String>)>> = BTreeMap::new();
    for (index, label, ids) in &moved.trashed_items {
        by_label.entry(label.as_str()).or_default().push((*index, ids));
    }
    for (label, items) in by_label {
        let ids: Vec<String> = items.iter().flat_map(|(_, ids)| ids.iter().cloned()).collect();
        let outcome = if ids.is_empty() {
            Ok(0)
        } else {
            match drive_client(&state, &account_id, label).await {
                Ok((identity, client)) => run::delete_forever(&client, &identity.wire_ss58, &identity.wire_folder_hash, &ids, |_| {}).await,
                Err(e) => {
                    warn!(error = %e, "Delete forever: the drive could not be reached");
                    Err(TrashRefusal::no_answer())
                }
            }
        };
        for (index, _) in items {
            match &outcome {
                Ok(_) => deleted_flags[request_index[index]] = true,
                Err(r) => failed.push(FileDeleteError {
                    name: requests[index].name.clone(),
                    error: format!("It's in Trash. {}", r.sentence()),
                }),
            }
        }
    }
    let deleted = deleted_flags.iter().filter(|d| **d).count() as u32;
    if let Some(token) = moved.hold {
        release_held(held, token).await?;
    }
    after_local_removal(&state, &app, &account_id, folder_labels).await;

    let tokens = crate::sync::files::links_to_turn_off(&files, &deleted_flags);
    let (links_turned_off, links_failed) = crate::sync::files::turn_off_links(&state, &account_id, tokens).await;
    info!(deleted, failed = failed.len(), "Delete forever completed");
    Ok(DeleteFilesResult {
        deleted,
        failed,
        links_turned_off,
        links_failed,
    })
}

// ---------------------------------------------------------------------------
// The Trash page
// ---------------------------------------------------------------------------

/// One row of the Trash page.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashRow {
    pub label: String,
    pub drive_name: String,
    pub shared: bool,
    /// The drive is synced on this computer.
    pub synced: bool,
    pub can_delete_forever: bool,
    pub item_id: String,
    pub is_folder: bool,
    pub name: String,
    /// Where it was, relative to the drive; empty for the drive's top.
    pub parent_path: String,
    pub path: String,
    /// The item's path exactly as the server stores it, which a keep-both
    /// restore is signed over. `None` for a file stored without one.
    pub stored_path: Option<String>,
    pub file_count: u64,
    pub total_bytes: u64,
    /// Unix seconds.
    pub trashed_at: i64,
    /// Unix seconds: when the server deletes it forever.
    pub purge_at: i64,
    pub trashed_by: Option<String>,
    pub name_taken: bool,
    /// `trashing` (a folder still being moved in), `ready` or `restoring`.
    pub state: &'static str,
    /// While `restoring`: how the restore started (`inPlace` or `rename`),
    /// which is how it must finish.
    pub restore_mode: Option<&'static str>,
    /// While `restoring` as a copy: the path it is going to.
    pub restore_new_path: Option<String>,
}

fn state_word(state: TrashItemState) -> &'static str {
    match state {
        TrashItemState::Trashing => "trashing",
        TrashItemState::Restoring => "restoring",
        TrashItemState::Ready | TrashItemState::Purging => "ready",
    }
}

fn mode_word(mode: TrashRestoreMode) -> &'static str {
    match mode {
        TrashRestoreMode::InPlace => "inPlace",
        TrashRestoreMode::Rename => "rename",
    }
}

/// A drive the Trash page can filter by or empty.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashDrive {
    pub label: String,
    pub name: String,
    pub shared: bool,
    pub can_delete_forever: bool,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashListing {
    pub items: Vec<TrashRow>,
    pub drives: Vec<TrashDrive>,
    /// Some drive's Trash could not be read; the list is partial.
    pub incomplete: bool,
    /// Days an item stays in Trash before the server deletes it forever.
    pub retention_days: u32,
}

/// Every item in Trash across this account's drives and the drives shared
/// with it as an Editor or Manager, newest first.
#[tauri::command]
pub async fn list_trash(state: tauri::State<'_, AppState>, account_id: String) -> Result<TrashListing> {
    let account_id = state.require_session_account(&account_id)?;
    let retention_days = require_trash(&state, &account_id).await?;
    list_trash_inner(&state, &account_id, retention_days).await
}

/// `retention_days`: the capabilities' answer, used when no listing names
/// one.
async fn list_trash_inner(state: &AppState, account_id: &str, retention_days: u32) -> Result<TrashListing> {
    let drives = list_move_destinations_inner(state, account_id).await?;
    let reads = drives.iter().map(|drive| async {
        let (identity, client) = drive_client(state, account_id, &drive.label).await.ok()?;
        Some(list_drive(state, account_id, &client, &drive.label, &identity).await)
    });
    let answers = futures_util::future::join_all(reads).await;

    let mut listing = TrashListing {
        retention_days,
        ..TrashListing::default()
    };
    let mut listed_retention = None;
    for (drive, answer) in drives.iter().zip(answers) {
        listing.drives.push(TrashDrive {
            label: drive.label.clone(),
            name: drive.name.clone(),
            shared: drive.shared,
            can_delete_forever: drive.manager,
        });
        let items = match answer {
            Some(Ok((items, retention))) => {
                listed_retention = listed_retention.or(Some(retention));
                items
            }
            Some(Err(r)) if r.is_unavailable() => continue,
            Some(Err(r)) => {
                warn!(status = r.status, code = ?r.code, "Trash: a drive's Trash could not be read");
                listing.incomplete = true;
                continue;
            }
            None => {
                listing.incomplete = true;
                continue;
            }
        };
        listing.items.extend(items.into_iter().map(|(item, path)| TrashRow {
            label: drive.label.clone(),
            drive_name: drive.name.clone(),
            shared: drive.shared,
            synced: drive.sync_path.is_some(),
            can_delete_forever: drive.manager,
            item_id: item.item_id,
            is_folder: item.kind == TrashItemKind::Folder,
            name: basename_of(&path).to_string(),
            parent_path: parent_of(&path).to_string(),
            path,
            stored_path: item.relative_path,
            file_count: item.file_count,
            total_bytes: item.total_bytes,
            trashed_at: item.trashed_at,
            purge_at: item.purge_at,
            trashed_by: item.trashed_by,
            name_taken: item.name_taken,
            state: state_word(item.state),
            restore_mode: item.restore_mode.map(mode_word),
            restore_new_path: item.restore_new_path,
        }));
    }
    listing
        .items
        .sort_by(|a, b| b.trashed_at.cmp(&a.trashed_at).then_with(|| a.name.cmp(&b.name)));
    if let Some(days) = listed_retention {
        listing.retention_days = days;
    }
    Ok(listing)
}

/// Every page of one drive's Trash, each row with its plaintext path, and
/// the retention the listing named.
async fn list_drive(
    state: &AppState,
    account_id: &str,
    client: &HcfsClient,
    label: &str,
    identity: &DriveIdentity,
) -> std::result::Result<(Vec<(wire::TrashItem, String)>, u32), TrashRefusal> {
    let (rows, retention) = run::list_all(client, &identity.wire_ss58, &identity.wire_folder_hash).await?;
    // A row with no plaintext path is opened with the drive key, read once
    // and only when a row needs it.
    let mut key: Option<Option<hcfs_crypto::FileKey>> = None;
    let mut named = Vec::with_capacity(rows.len());
    for item in rows {
        if item.state == TrashItemState::Purging {
            continue;
        }
        let mut path = item.relative_path.clone().filter(|p| !p.trim_matches('/').is_empty());
        if path.is_none()
            && let Some(sealed) = &item.encrypted_path
        {
            if key.is_none() {
                key = Some(drive_key(state, account_id, label, identity).await);
            }
            if let Some(Some(k)) = &key {
                path = hcfs_crypto::decrypt_small(sealed, k).ok().and_then(|b| String::from_utf8(b).ok());
            }
        }
        let path = path
            .or_else(|| item.file_name.clone())
            .unwrap_or_else(|| "Untitled".to_string())
            .replace('\\', "/")
            .trim_matches('/')
            .to_string();
        named.push((item, path));
    }
    Ok((named, retention))
}

async fn drive_key(state: &AppState, account_id: &str, label: &str, identity: &DriveIdentity) -> Option<hcfs_crypto::FileKey> {
    let mnemonic = crate::sync::remote::session_mnemonic(state).ok()?;
    let keys = crate::sync::remote::drive_key_material_for_label(state, account_id, label, &mnemonic, identity)
        .await
        .ok()?;
    keys.encryption_key().ok()
}

/// One item to restore, and what to do when its name is taken.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RestoreItemRequest {
    pub label: String,
    pub item_id: String,
    /// Its original path, as listed.
    pub path: String,
    /// The listing's `storedPath`.
    #[serde(default)]
    pub stored_path: Option<String>,
    pub is_folder: bool,
    /// For progress only.
    #[serde(default)]
    pub file_count: u64,
    /// `ask` (report a clash), `keepBoth` or `skip`.
    #[serde(default = "ask")]
    pub on_clash: String,
    /// The listing's `restoreMode` and `restoreNewPath`: a restore already
    /// under way finishes the way it started, whatever was chosen.
    #[serde(default)]
    pub restore_mode: Option<String>,
    #[serde(default)]
    pub restore_new_path: Option<String>,
}

fn ask() -> String {
    "ask".into()
}

/// How one restore went.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RestoreItemResult {
    pub label: String,
    pub item_id: String,
    /// `restored`, `clash` (name taken, nothing restored), `skipped`,
    /// `notFound` or `failed`.
    pub status: String,
    pub error: Option<String>,
    /// Where it is now, relative to its drive.
    pub path: String,
}

/// How a request is carried out.
#[derive(Debug, PartialEq, Eq)]
enum RestorePlan {
    InPlace,
    /// Keep both; `Some` path to finish a copy already under way.
    KeepBoth(Option<String>),
    Skip,
}

fn restore_plan(item: &RestoreItemRequest) -> RestorePlan {
    match (item.restore_mode.as_deref(), &item.restore_new_path) {
        (Some("rename"), Some(path)) => RestorePlan::KeepBoth(Some(path.clone())),
        (Some("inPlace"), _) => RestorePlan::InPlace,
        _ => match item.on_clash.as_str() {
            "keepBoth" => RestorePlan::KeepBoth(None),
            "skip" => RestorePlan::Skip,
            _ => RestorePlan::InPlace,
        },
    }
}

/// Restore items from Trash to where they were.
#[tauri::command]
pub async fn restore_trash_items(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    job_id: String,
    items: Vec<RestoreItemRequest>,
) -> Result<Vec<RestoreItemResult>> {
    let account_id = state.require_session_account(&account_id)?;
    require_trash(&state, &account_id).await?;
    let progress = Progress {
        app: Some(app),
        job_id,
        action: "restore",
        total: items.iter().map(|i| i.file_count.max(1)).sum(),
    };
    let results = restore_inner(&state, &account_id, &items, &progress).await?;
    if results.iter().any(|r| r.status == "restored") {
        let _ = hcfs_client::engine::runner::trigger_sync(&state.sync).await;
    }
    Ok(results)
}

async fn restore_inner(state: &AppState, account_id: &str, items: &[RestoreItemRequest], progress: &Progress) -> Result<Vec<RestoreItemResult>> {
    let mut by_label: BTreeMap<&str, Vec<&RestoreItemRequest>> = BTreeMap::new();
    for item in items {
        by_label.entry(item.label.as_str()).or_default().push(item);
    }
    let mut results = Vec::with_capacity(items.len());
    let mut done = 0u64;
    let answer = |item: &RestoreItemRequest, status: &str, error: Option<String>, path: String| RestoreItemResult {
        label: item.label.clone(),
        item_id: item.item_id.clone(),
        status: status.to_string(),
        error,
        path,
    };
    for (label, list) in by_label {
        let in_place: Vec<&RestoreItemRequest> = list.iter().copied().filter(|i| restore_plan(i) == RestorePlan::InPlace).collect();
        if !in_place.is_empty() {
            let ids: Vec<String> = in_place.iter().map(|i| i.item_id.clone()).collect();
            let base = done;
            let sent = match drive_client(state, account_id, label).await {
                Ok((identity, client)) => {
                    run::restore_in_place(
                        &client,
                        &identity.wire_ss58,
                        &identity.wire_folder_hash,
                        &ids,
                        RestoreConflict::Fail,
                        |n| progress.report(base + n),
                    )
                    .await
                }
                Err(e) => {
                    warn!(error = %e, "Restore: the drive could not be reached");
                    Err(TrashRefusal::no_answer())
                }
            };
            match sent {
                Ok(outcome) => {
                    for item in in_place {
                        let status = if outcome.restored.contains(&item.item_id) {
                            "restored"
                        } else if outcome.clashed.contains(&item.item_id) {
                            "clash"
                        } else if outcome.missing.contains(&item.item_id) {
                            "notFound"
                        } else {
                            "failed"
                        };
                        let error = (status == "failed").then(|| "Hippius couldn't restore it.".to_string());
                        results.push(answer(item, status, error, item.path.clone()));
                    }
                }
                Err(r) => {
                    for item in in_place {
                        results.push(answer(item, "failed", Some(r.sentence()), item.path.clone()));
                    }
                }
            }
            done += in_place_files(&list);
        }

        for item in list.iter().copied().filter(|i| restore_plan(i) == RestorePlan::Skip) {
            results.push(answer(item, "skipped", None, item.path.clone()));
        }

        for item in list.iter().copied() {
            let RestorePlan::KeepBoth(path) = restore_plan(item) else {
                continue;
            };
            let base = done;
            progress.report(base);
            match restore_keep_both(state, account_id, label, item, path).await {
                Ok(Some(path)) => results.push(answer(item, "restored", None, path)),
                Ok(None) => results.push(answer(item, "clash", None, item.path.clone())),
                Err(e) => {
                    let gone = TrashRefusal::coded(404, "item_not_found").sentence();
                    let status = if e.to_string().contains(&gone) { "notFound" } else { "failed" };
                    results.push(answer(item, status, Some(e.to_string()), item.path.clone()));
                }
            }
            done += item.file_count.max(1);
            progress.report(done);
        }
    }
    progress.report(progress.total);
    Ok(results)
}

fn in_place_files(list: &[&RestoreItemRequest]) -> u64 {
    list.iter()
        .filter(|i| restore_plan(i) == RestorePlan::InPlace)
        .map(|i| i.file_count.max(1))
        .sum()
}

/// "Keep both": the first free "name (N)" beside where it was, and every
/// file of the item restored under it by hcfs-client's planner. `Ok(None)`
/// when the name is taken even after a second pick (or, finishing a copy
/// under way, its name is). `finish`: the path of a copy under way.
async fn restore_keep_both(
    state: &AppState,
    account_id: &str,
    label: &str,
    item: &RestoreItemRequest,
    finish: Option<String>,
) -> Result<Option<String>> {
    let Some(item_path) = item.stored_path.clone() else {
        return Err(refusal(TrashRefusal::coded(400, "no_stored_path")));
    };
    let mnemonic = crate::sync::remote::session_mnemonic(state)?;
    let (side, keys) = resolve_side(state, account_id, label, &mnemonic).await?;
    drop(mnemonic);
    // hcfs-client signs with ed25519-dalek 3; the key is the same seed.
    let signing_key = ed25519_dalek_v3::SigningKey::from_bytes(&keys.signing_key()?.to_bytes());
    let (ss58, fh) = (side.identity.wire_ss58.as_str(), side.identity.wire_folder_hash.as_str());

    if let Some(new_path) = finish {
        return match run::restore_as(&side.client, ss58, fh, &item.item_id, &item_path, &new_path, &side.key, &signing_key)
            .await
            .map_err(refusal)?
        {
            KeepBoth::Restored { .. } => Ok(Some(new_path)),
            KeepBoth::NameTaken => Ok(None),
        };
    }

    let old_path = item.path.trim_matches('/').to_string();
    let parent = parent_of(&old_path).to_string();
    let (folders, listed) = crate::sync::remote_rename::browse_directory(&side.client, ss58, fh, &parent).await?;
    let mut taken: HashSet<String> = folders.iter().map(|f| basename_of(f).to_lowercase()).collect();
    for entry in &listed {
        if let Some(path) = entry_path(entry, &side.key).or_else(|| entry.file_name.clone()) {
            taken.insert(basename_of(&path).to_lowercase());
        }
    }
    if let Some(root) = &side.root
        && let Ok(entries) = std::fs::read_dir(root.join(&parent))
    {
        taken.extend(entries.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()));
    }
    // A name can be taken between the pick and the restore (another device,
    // a file in Trash restored meanwhile): pick once more past it.
    for _ in 0..2 {
        let new_name = keep_both_name(basename_of(&old_path), item.is_folder, |c| taken.contains(&c.to_lowercase()))
            .ok_or_else(|| AppError::Validation("No free name was found for it.".into()))?;
        let new_path = join_path(&parent, &new_name);
        match run::restore_as(&side.client, ss58, fh, &item.item_id, &item_path, &new_path, &side.key, &signing_key)
            .await
            .map_err(refusal)?
        {
            KeepBoth::Restored { .. } => return Ok(Some(new_path)),
            KeepBoth::NameTaken => {
                taken.insert(new_name.to_lowercase());
            }
        }
    }
    Ok(None)
}

/// One Trash item, by drive.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemRef {
    pub label: String,
    pub item_id: String,
}

/// What delete forever or empty did.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashDeleteResult {
    pub deleted: u32,
    /// One sentence per drive that refused.
    pub failed: Vec<String>,
}

/// Delete Trash items forever.
#[tauri::command]
pub async fn delete_trash_items_forever(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    job_id: String,
    items: Vec<TrashItemRef>,
) -> Result<TrashDeleteResult> {
    let account_id = state.require_session_account(&account_id)?;
    require_trash(&state, &account_id).await?;
    let progress = Progress {
        app: Some(app),
        job_id,
        action: "delete",
        total: items.len() as u64,
    };
    let mut by_label: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for item in &items {
        by_label.entry(item.label.as_str()).or_default().push(item.item_id.clone());
    }
    let mut result = TrashDeleteResult::default();
    let mut done = 0u64;
    for (label, ids) in by_label {
        let base = done;
        let sent = match drive_client(&state, &account_id, label).await {
            Ok((identity, client)) => {
                run::delete_forever(&client, &identity.wire_ss58, &identity.wire_folder_hash, &ids, |n| {
                    progress.report(base + n);
                })
                .await
            }
            Err(e) => {
                warn!(error = %e, "Delete forever: the drive could not be reached");
                Err(TrashRefusal::no_answer())
            }
        };
        match sent {
            Ok(_) => result.deleted += ids.len() as u32,
            Err(r) => result.failed.push(r.sentence()),
        }
        done += ids.len() as u64;
    }
    Ok(result)
}

/// Empty Trash: every drive given, or every drive this account may empty.
#[tauri::command]
pub async fn empty_trash(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    job_id: String,
    labels: Option<Vec<String>>,
) -> Result<TrashDeleteResult> {
    let account_id = state.require_session_account(&account_id)?;
    require_trash(&state, &account_id).await?;
    let drives: Vec<String> = match labels {
        Some(labels) => labels,
        None => list_move_destinations_inner(&state, &account_id)
            .await?
            .into_iter()
            .filter(|d| d.manager)
            .map(|d| d.label)
            .collect(),
    };
    let progress = Progress {
        app: Some(app),
        job_id,
        action: "empty",
        total: drives.len() as u64,
    };
    let mut result = TrashDeleteResult::default();
    for (index, label) in drives.iter().enumerate() {
        let sent = match drive_client(&state, &account_id, label).await {
            Ok((identity, client)) => run::empty(&client, &identity.wire_ss58, &identity.wire_folder_hash).await,
            Err(e) => {
                warn!(error = %e, "Empty Trash: the drive could not be reached");
                Err(TrashRefusal::no_answer())
            }
        };
        match sent {
            Ok(n) => result.deleted += n as u32,
            Err(r) if r.is_unavailable() => {}
            Err(r) => result.failed.push(r.sentence()),
        }
        progress.report(index as u64 + 1);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(on_clash: &str, mode: Option<&str>, new_path: Option<&str>) -> RestoreItemRequest {
        RestoreItemRequest {
            label: "docs".into(),
            item_id: "ab".repeat(16),
            path: "Work/Old".into(),
            stored_path: Some("Work/Old".into()),
            is_folder: true,
            file_count: 3,
            on_clash: on_clash.into(),
            restore_mode: mode.map(str::to_string),
            restore_new_path: new_path.map(str::to_string),
        }
    }

    #[test]
    fn a_restore_under_way_finishes_the_way_it_started() {
        assert_eq!(restore_plan(&request("ask", None, None)), RestorePlan::InPlace);
        assert_eq!(restore_plan(&request("keepBoth", None, None)), RestorePlan::KeepBoth(None));
        assert_eq!(restore_plan(&request("skip", None, None)), RestorePlan::Skip);
        assert_eq!(
            restore_plan(&request("ask", Some("rename"), Some("Work/Old (1)"))),
            RestorePlan::KeepBoth(Some("Work/Old (1)".into())),
            "a copy under way goes on under its own name"
        );
        assert_eq!(
            restore_plan(&request("keepBoth", Some("inPlace"), None)),
            RestorePlan::InPlace,
            "the server refuses any other way (restore_mode_mismatch)"
        );
    }

    #[test]
    fn listing_states_cross_ipc_as_words() {
        assert_eq!(state_word(TrashItemState::Trashing), "trashing");
        assert_eq!(state_word(TrashItemState::Ready), "ready");
        assert_eq!(state_word(TrashItemState::Restoring), "restoring");
        assert_eq!(mode_word(TrashRestoreMode::InPlace), "inPlace");
        assert_eq!(mode_word(TrashRestoreMode::Rename), "rename");
    }
}
