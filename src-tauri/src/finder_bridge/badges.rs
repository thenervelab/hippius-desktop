//! The Finder badge feed: what badge a path shows, and when to push one.
//!
//! Two paths feed the extension, for two different reasons:
//!
//! - **Pull.** Finder asks the extension for a badge per item it is about to
//!   show, and the extension forwards a `BADGE_QUERY` for anything it has no
//!   cached answer for. [`answer_badge_query`] resolves that from what the
//!   engine already holds in memory — no disk walk, no network — and answers
//!   with one `STATUS` line. This is the steady state, and the only path that
//!   scales: a drive can hold six-figure file counts, and the app→extension
//!   channel is a bounded broadcast that drops frames on lag, so pushing every
//!   synced path would paint a random subset.
//! - **Push.** [`push`] sends a `STATUS` unprompted for a single path the user
//!   is watching: a file lands, a file fails, a share is minted or revoked.
//!   When a plan starts, [`refresh_root`] sends one `REFRESH_ROOT` line so the
//!   extension re-queries the URLs Finder is already showing — a per-file
//!   plan push would overflow the 256-slot broadcast.
//!
//! The decision itself is [`resolve_badge`], a pure function over
//! [`PathFacts`], so the whole priority table is unit-tested on every platform.

use std::path::{Path, PathBuf};

use hcfs_client::engine::progress::state::FileStatus;
use hcfs_client::engine::runner::SyncRunner;
use tauri::Manager;
use tracing::debug;

use crate::app_state::AppState;
use crate::finder_bridge::protocol::BadgeState;
use crate::finder_bridge::resolve::{ShareTarget, resolve_share_target};

/// How the current sync session sees a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transfer {
    /// Not in the session, or already completed.
    Idle,
    /// Queued or moving bytes right now.
    Active,
    /// The engine gave up on it this cycle.
    Failed,
}

/// Everything [`resolve_badge`] needs, gathered by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathFacts {
    /// The path is under a registered drive root.
    pub in_drive: bool,
    /// The path is a directory (the drive root counts).
    pub is_dir: bool,
    /// The session's view — for a directory, of everything under it.
    pub transfer: Transfer,
    /// A share minted on this device is on record for the path.
    pub shared: bool,
    /// The engine's last-synced set contains the path.
    pub synced: bool,
}

/// The badge for a path, given the facts.
///
/// Priority: nothing outside a drive; then what is happening beats what has
/// happened (in flight, then failed); then a live share beats the plain
/// synced mark; a folder inside a drive is synced unless something under it
/// says otherwise; a file is synced only if the engine says so.
pub fn resolve_badge(facts: PathFacts) -> BadgeState {
    if !facts.in_drive {
        return BadgeState::Clear;
    }
    match facts.transfer {
        Transfer::Active => BadgeState::Syncing,
        Transfer::Failed => BadgeState::Error,
        Transfer::Idle if facts.shared => BadgeState::Shared,
        Transfer::Idle if facts.is_dir || facts.synced => BadgeState::Synced,
        Transfer::Idle => BadgeState::Clear,
    }
}

/// The badge a file-synced callback's `action` maps to, if any. hcfs-client
/// passes `"uploaded"` / `"downloaded"` / `"deleted"` / `"conflict"`; an
/// action this table does not know pushes nothing rather than guessing.
pub fn badge_for_synced_action(action: &str) -> Option<BadgeState> {
    match action {
        "uploaded" | "downloaded" => Some(BadgeState::Synced),
        "conflict" => Some(BadgeState::Error),
        "deleted" => Some(BadgeState::Clear),
        _ => None,
    }
}

/// The registered drive roots, `(label, root)`, from the engine's own map.
///
/// In memory rather than the `sync_paths` table: this runs once per visible
/// Finder row and per transferred file.
pub fn label_roots(sync: &SyncRunner) -> Vec<(String, PathBuf)> {
    let guard = sync.label_roots.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.iter().map(|(label, root)| (label.clone(), root.clone())).collect()
}

/// The root registered for `label`, if the drive is up.
pub fn label_root(sync: &SyncRunner, label: &str) -> Option<PathBuf> {
    let guard = sync.label_roots.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.get(label).cloned()
}

/// What the current session says about `rel` in drive `label`. A directory
/// (`is_dir`) aggregates everything under it: any active file makes it
/// active, else any failed file makes it failed.
pub fn transfer_state(sync: &SyncRunner, label: &str, rel: &str, is_dir: bool) -> Transfer {
    let state = sync.progress.lock_state();
    let Some(session) = state.current_session.as_ref() else {
        return Transfer::Idle;
    };
    if !is_dir {
        return match session.files.get(rel) {
            Some(file) if &*file.label == label => transfer_of(&file.status),
            _ => Transfer::Idle,
        };
    }
    // The drive root ("") contains every file of the label; any other folder
    // contains the paths under `rel/`.
    let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
    let mut seen_failed = false;
    for (path, file) in &session.files {
        if &*file.label != label || !path.starts_with(&prefix) {
            continue;
        }
        match transfer_of(&file.status) {
            Transfer::Active => return Transfer::Active,
            Transfer::Failed => seen_failed = true,
            Transfer::Idle => {}
        }
    }
    if seen_failed { Transfer::Failed } else { Transfer::Idle }
}

fn transfer_of(status: &FileStatus) -> Transfer {
    match status {
        FileStatus::Completed => Transfer::Idle,
        FileStatus::Error => Transfer::Failed,
        FileStatus::Pending
        | FileStatus::Uploading
        | FileStatus::Downloading
        | FileStatus::Encrypting
        | FileStatus::Decrypting
        | FileStatus::Deleting => Transfer::Active,
    }
}

/// Whether the engine's last-synced set for `label` holds `rel`. Reads the
/// cache in place — cloning a six-figure map per Finder row is what this
/// function exists to avoid.
pub fn is_synced(sync: &SyncRunner, label: &str, rel: &str) -> bool {
    let cache = sync.synced_paths_cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.get(label).is_some_and(|paths| paths.contains_key(rel))
}

/// Answer one `BADGE_QUERY`: gather the facts for `path` from the engine's
/// in-memory state and the share sidecar, decide, and push the `STATUS`.
/// Best-effort throughout — a missing bridge or an unreadable path answers
/// `clear` or nothing, never an error the extension could not act on.
pub async fn answer_badge_query(app: tauri::AppHandle, path: PathBuf) {
    let state = app.state::<AppState>();
    let Some(bridge) = state.finder_bridge().cloned() else {
        return;
    };
    let facts = gather_facts(&state, &path).await;
    let badge = resolve_badge(facts);
    debug!(path = %path.display(), ?facts, ?badge, "finder badge query answered");
    bridge.set_badge(badge, path);
}

async fn gather_facts(state: &AppState, path: &Path) -> PathFacts {
    let roots = label_roots(&state.sync);
    let ShareTarget::InDrive { label, relative_path } = resolve_share_target(path, &roots) else {
        return PathFacts {
            in_drive: false,
            is_dir: false,
            transfer: Transfer::Idle,
            shared: false,
            synced: false,
        };
    };
    let is_dir = tokio::fs::metadata(path).await.is_ok_and(|meta| meta.is_dir());
    let transfer = transfer_state(&state.sync, &label, &relative_path, is_dir);
    let synced = !is_dir && is_synced(&state.sync, &label, &relative_path);
    // `resolve_badge` only consults `shared` when the session is idle, so
    // skip the SQLite round-trip while a transfer is in flight or failed.
    let shared = match transfer {
        Transfer::Active | Transfer::Failed => false,
        Transfer::Idle if is_dir => is_folder_shared_on_record(state, &label, &relative_path).await,
        Transfer::Idle => is_shared_on_record(state, &label, &relative_path).await,
    };
    PathFacts {
        in_drive: true,
        is_dir,
        transfer,
        shared,
        synced,
    }
}

/// The share sidecar's answer for the active account; `false` when there is
/// no session or the DB is unavailable, because a badge is a hint.
async fn is_shared_on_record(state: &AppState, label: &str, relative_path: &str) -> bool {
    let (Ok(pool), Ok(account_id)) = (state.pool(), state.current_account_id()) else {
        return false;
    };
    let owner = crate::auth::account_key::account_key(&account_id);
    crate::shares::origin::is_shared(pool, &owner, label, relative_path)
        .await
        .unwrap_or(false)
}

async fn is_folder_shared_on_record(state: &AppState, label: &str, relative_path: &str) -> bool {
    let (Ok(pool), Ok(account_id)) = (state.pool(), state.current_account_id()) else {
        return false;
    };
    let owner = crate::auth::account_key::account_key(&account_id);
    crate::shares::origin::is_folder_shared(pool, &owner, label, relative_path)
        .await
        .unwrap_or(false)
}

/// Push `badge` for `rel` in drive `label`, if the bridge is up and the drive
/// is registered. Silent otherwise: this is called from engine callbacks that
/// must never fail a transfer over a badge.
pub fn push<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str, rel: &str, badge: BadgeState) {
    // `try_state`, not `state`: the engine callbacks run under test mock apps
    // that manage no `AppState`, and a badge is never worth a panic.
    if let Some(state) = app.try_state::<AppState>() {
        push_from_state(&state, label, rel, badge);
    }
}

/// [`push`] for callers that hold the state rather than an app handle (the
/// share commands).
pub fn push_from_state(state: &AppState, label: &str, rel: &str, badge: BadgeState) {
    let Some(bridge) = state.finder_bridge() else {
        return;
    };
    let Some(root) = label_root(&state.sync, label) else {
        return;
    };
    bridge.set_badge(badge, root.join(rel));
}

/// The badge a path returns to once its share is gone.
pub fn badge_after_unshare(state: &AppState, label: &str, rel: &str, is_dir: bool) -> BadgeState {
    resolve_badge(PathFacts {
        in_drive: true,
        is_dir,
        transfer: Transfer::Idle,
        shared: false,
        synced: !is_dir && is_synced(&state.sync, label, rel),
    })
}

/// Tell the extension to re-query the paths Finder is already showing under
/// this drive. One line, not one per planned file.
pub fn refresh_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(bridge) = state.finder_bridge() else {
        return;
    };
    let Some(root) = label_root(&state.sync, label) else {
        return;
    };
    bridge.refresh_root(root);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn facts(transfer: Transfer, shared: bool, synced: bool) -> PathFacts {
        PathFacts {
            in_drive: true,
            is_dir: false,
            transfer,
            shared,
            synced,
        }
    }

    #[test]
    fn outside_a_drive_is_never_badged() {
        // Even a path the session somehow claims to be moving: without a root
        // there is nothing for the badge to be relative to.
        let outside = PathFacts {
            in_drive: false,
            is_dir: false,
            transfer: Transfer::Active,
            shared: true,
            synced: true,
        };
        assert_eq!(resolve_badge(outside), BadgeState::Clear);
    }

    #[test]
    fn what_is_happening_beats_what_has_happened() {
        assert_eq!(resolve_badge(facts(Transfer::Active, true, true)), BadgeState::Syncing);
        assert_eq!(resolve_badge(facts(Transfer::Failed, true, true)), BadgeState::Error);
    }

    #[test]
    fn a_live_share_beats_the_plain_synced_mark() {
        assert_eq!(resolve_badge(facts(Transfer::Idle, true, true)), BadgeState::Shared);
        assert_eq!(resolve_badge(facts(Transfer::Idle, false, true)), BadgeState::Synced);
    }

    #[test]
    fn an_unsynced_file_in_a_drive_shows_nothing() {
        // Excluded, or not yet scanned: claiming "synced" here is the one lie
        // a badge must not tell.
        assert_eq!(resolve_badge(facts(Transfer::Idle, false, false)), BadgeState::Clear);
    }

    #[test]
    fn a_quiet_folder_inside_a_drive_is_synced() {
        let folder = PathFacts {
            in_drive: true,
            is_dir: true,
            transfer: Transfer::Idle,
            shared: false,
            synced: false,
        };
        assert_eq!(resolve_badge(folder), BadgeState::Synced);
        let busy = PathFacts {
            transfer: Transfer::Active,
            ..folder
        };
        assert_eq!(resolve_badge(busy), BadgeState::Syncing);
    }

    #[test]
    fn synced_actions_map_to_a_badge_and_unknown_ones_to_none() {
        assert_eq!(badge_for_synced_action("uploaded"), Some(BadgeState::Synced));
        assert_eq!(badge_for_synced_action("downloaded"), Some(BadgeState::Synced));
        assert_eq!(badge_for_synced_action("conflict"), Some(BadgeState::Error));
        assert_eq!(badge_for_synced_action("deleted"), Some(BadgeState::Clear));
        assert_eq!(badge_for_synced_action("failed"), None);
    }

    #[test]
    fn a_folder_returns_to_synced_after_its_share_is_gone() {
        // No session, not a file in the synced cache: a quiet folder in a
        // drive still reads as synced (the idle-directory rule).
        let facts = PathFacts {
            in_drive: true,
            is_dir: true,
            transfer: Transfer::Idle,
            shared: false,
            synced: false,
        };
        assert_eq!(resolve_badge(facts), BadgeState::Synced);
    }

    fn runner() -> Arc<SyncRunner> {
        use hcfs_client::engine::{NoopCallbacks, NoopEventHandler};
        Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ))
    }

    /// Seed a session with uploads for `label`, then set the given statuses.
    fn seed_session(sync: &SyncRunner, label: &str, files: &[(&str, FileStatus)]) {
        let list = hcfs_client::engine::progress::state::SessionFileList {
            upload_files: Some(files.iter().map(|(p, _)| (*p).to_string()).collect()),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        crate::sync::progress::merge_into_session(sync, files.len() as u32, 0, 0, 0, Some(list), Some(label.to_string())).expect("session");
        let mut state = sync.progress.lock_state();
        let session = state.current_session.as_mut().expect("session exists");
        for (path, status) in files {
            session.files.get_mut(*path).expect("seeded file").status = status.clone();
        }
    }

    #[test]
    fn transfer_state_reads_the_session_per_label_and_aggregates_folders() {
        let sync = runner();
        seed_session(
            &sync,
            "docs",
            &[
                ("a.txt", FileStatus::Uploading),
                ("sub/b.txt", FileStatus::Error),
                ("sub/c.txt", FileStatus::Completed),
            ],
        );

        assert_eq!(transfer_state(&sync, "docs", "a.txt", false), Transfer::Active);
        assert_eq!(transfer_state(&sync, "docs", "sub/b.txt", false), Transfer::Failed);
        assert_eq!(transfer_state(&sync, "docs", "sub/c.txt", false), Transfer::Idle);
        assert_eq!(transfer_state(&sync, "docs", "missing.txt", false), Transfer::Idle);
        // Same rel path under another label is another drive's file.
        assert_eq!(transfer_state(&sync, "pics", "a.txt", false), Transfer::Idle);

        // `sub/` holds a failed and a completed file: failed. The root holds
        // an active one too: active wins.
        assert_eq!(transfer_state(&sync, "docs", "sub", true), Transfer::Failed);
        assert_eq!(transfer_state(&sync, "docs", "", true), Transfer::Active);
        // A folder that merely shares a name prefix is not a parent.
        assert_eq!(transfer_state(&sync, "docs", "su", true), Transfer::Idle);
    }

    #[test]
    fn is_synced_reads_the_cache_for_the_exact_label_and_path() {
        use hcfs_client::engine::types::SyncedFileInfo;
        use std::collections::HashMap;
        let sync = runner();
        let mut paths = HashMap::new();
        paths.insert(
            "sub/b.txt".to_string(),
            SyncedFileInfo {
                path_hash: [0; 32],
                arion_cid: Arc::from(""),
                uploaded_at: 1,
                updated_at: 1,
            },
        );
        sync.update_synced_paths_cache("docs", paths);

        assert!(is_synced(&sync, "docs", "sub/b.txt"));
        assert!(!is_synced(&sync, "docs", "sub"));
        assert!(!is_synced(&sync, "pics", "sub/b.txt"));
    }

    #[test]
    fn label_roots_reflect_the_engine_map() {
        let sync = runner();
        assert!(label_roots(&sync).is_empty());
        sync.register_label_root("docs".into(), PathBuf::from("/Users/me/Docs"));
        assert_eq!(label_roots(&sync), vec![("docs".to_string(), PathBuf::from("/Users/me/Docs"))]);
        assert_eq!(label_root(&sync, "docs"), Some(PathBuf::from("/Users/me/Docs")));
        assert_eq!(label_root(&sync, "pics"), None);
    }
}
