//! Recent-files view and the per-drive synced-paths reads it shares with the
//! listing and rename paths.

use crate::error::Result;
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::types::{SyncActivityAction, SyncedFileInfo, build_synced_paths_from_state};
use serde::Serialize;
use std::collections::HashMap;

/// Build a map of relative paths → sync info for files whose
/// `path_hash` appears in the drive's persisted `synced` tree.
/// Returns `None` when the drive isn't available (e.g. logged out)
/// so the caller can fall back to "unknown".
///
/// Tries the live drive lock first (non-blocking). On success the cache
/// is also refreshed. When the lock is unavailable (sync in progress),
/// falls back to the last cached snapshot so the file browser still
/// shows accurate sync status instead of "unknown".
///
/// Waits up to [`FIRST_RECONCILE_WAIT_BUDGET`] for the per-drive
/// reconcile readiness gate so the cache contains authoritative
/// timestamps on cold start. See
/// [`synced_paths_and_excludes_for_label`] for the full rationale.
pub(super) async fn synced_paths_for_label(sync: &SyncRunner, label: &str) -> Option<HashMap<String, SyncedFileInfo>> {
    let _ = sync.wait_for_first_reconcile(label, FIRST_RECONCILE_WAIT_BUDGET).await;
    let arc = match acquire_drive_arc(sync, label) {
        DriveArcOutcome::Acquired(arc) => arc,
        DriveArcOutcome::CacheFallback => return sync.get_cached_synced_paths(label),
    };
    // `try_lock` (not `lock().await`) is essential here: the per-drive
    // mutex is held by the sync loop for the duration of a sync cycle,
    // and the file browser must remain responsive during that window.
    // Falling back to the cache on contention is a deliberate tradeoff:
    // slightly stale on-screen sync status > a 30-second listing freeze.
    match arc.try_lock() {
        Ok(manager) => match manager.load_sync_state().await {
            Ok(state) => {
                let paths = build_synced_paths_from_state(&state);
                sync.update_synced_paths_cache(label, paths.clone());
                Some(paths)
            }
            Err(_) => None,
        },
        Err(_) => sync.get_cached_synced_paths(label),
    }
}

/// Read both the synced-paths map and the exclusion patterns for `label`
/// behind a single outer-drives lock acquisition.
///
/// Before reading the cache, wait up to [`FIRST_RECONCILE_WAIT_BUDGET`]
/// for the per-drive readiness gate to settle. This closes the cold-
/// start race where `get_user_files` would observe a stale cache
/// (with `uploaded_at = 0` for any file the local `sync_state.json`
/// is missing timestamps for) before the background reconcile
/// finished its first attempt. Net effect: first Files-page render
/// after login shows correct upload dates instead of "—" until the
/// user logs out and back in. Per-drive wait, parallel across
/// drives because `get_user_files` fans out via `join_all`, so the
/// worst-case latency is bounded by the budget itself, not by drive
/// count.
pub(super) async fn synced_paths_and_excludes_for_label(sync: &SyncRunner, label: &str) -> (Option<HashMap<String, SyncedFileInfo>>, Vec<String>) {
    // Block reads until the first reconcile has settled (or the
    // budget elapses). We discard the outcome here — the cache
    // contents are what we read below; this wait only serves to
    // delay the read until those contents are trustworthy. A
    // `Timeout` / `NotRegistered` falls through to whatever stale
    // state we have, matching the existing graceful-degradation
    // contract.
    let _ = sync.wait_for_first_reconcile(label, FIRST_RECONCILE_WAIT_BUDGET).await;

    let arc = match acquire_drive_arc(sync, label) {
        DriveArcOutcome::Acquired(arc) => arc,
        DriveArcOutcome::CacheFallback => return (sync.get_cached_synced_paths(label), Vec::new()),
    };
    // `try_lock` (not `lock().await`) is essential — see synced_paths_for_label.
    match arc.try_lock() {
        Ok(manager) => {
            let synced = match manager.load_sync_state().await {
                Ok(state) => {
                    let paths = build_synced_paths_from_state(&state);
                    sync.update_synced_paths_cache(label, paths.clone());
                    Some(paths)
                }
                Err(_) => None,
            };
            let excludes = manager.list_exclude_patterns();
            (synced, excludes)
        }
        Err(_) => (sync.get_cached_synced_paths(label), Vec::new()),
    }
}

/// Maximum time `synced_paths_and_excludes_for_label` is willing to
/// wait for a drive's first reconcile to settle before reading the
/// cache. Sized to comfortably cover the production retry schedule
/// (0s / 2s / 5s = up to ~7s for the third attempt to start) with a
/// small margin: at 6s we accept that an extremely slow third
/// attempt may finish after we've returned and let the
/// `ACTIVITY_UPDATED` event refresh the FE — the worst case is
/// one extra refetch, not a stale forever read.
const FIRST_RECONCILE_WAIT_BUDGET: std::time::Duration = std::time::Duration::from_secs(6);

/// Outcome of locating a per-drive `DriveManager` Arc behind the outer
/// drives map. Either we got the Arc, or the outer/inner lookup failed and
/// the caller should fall back to the cache.
enum DriveArcOutcome {
    Acquired(std::sync::Arc<tokio::sync::Mutex<DriveManager>>),
    CacheFallback,
}

/// Single source of truth for the outer-drives map lookup that both the
/// synced-paths-only and synced-paths-plus-excludes helpers need. Locks
/// `sync.drives` non-blockingly (briefly), copies out the per-drive Arc,
/// and drops the outer lock immediately so concurrent listings don't
/// queue behind the sync loop.
fn acquire_drive_arc(sync: &SyncRunner, label: &str) -> DriveArcOutcome {
    match sync.drives.try_lock() {
        Ok(guard) => match guard.get(label) {
            Some(slot) => DriveArcOutcome::Acquired(slot.manager.clone()),
            None => DriveArcOutcome::CacheFallback,
        },
        Err(_) => DriveArcOutcome::CacheFallback,
    }
}

/// Return sync metadata (arion hashes, CIDs, timestamps) for all synced
/// files across all drives. Used internally by `get_user_files` to look
/// up arion hashes without needing to list every subfolder from disk.
/// Acquire each drive's synced-paths map: live per-drive lock first (cache
/// warmed on success), falling back to the cached snapshot when a drive is
/// mid-sync (or all drives are busy). Used by the bounded recent-files
/// lookup (`get_recent_files`).
async fn collect_label_maps(sync: &SyncRunner) -> Vec<(String, HashMap<String, SyncedFileInfo>)> {
    let drive_arcs: Vec<(String, std::sync::Arc<tokio::sync::Mutex<DriveManager>>)> = match sync.drives.try_lock() {
        Ok(guard) => guard.iter().map(|(k, slot)| (k.clone(), slot.manager.clone())).collect(),
        Err(_) => Vec::new(),
    };
    if drive_arcs.is_empty() {
        // All locks held by sync — use cached data.
        return match sync.synced_paths_cache.lock() {
            Ok(cache) => cache.iter().map(|(l, m)| (l.clone(), m.clone())).collect(),
            Err(_) => Vec::new(),
        };
    }
    let mut out = Vec::new();
    for (label, arc) in &drive_arcs {
        if let Ok(manager) = arc.try_lock() {
            if let Ok(st) = manager.load_sync_state().await {
                let paths = build_synced_paths_from_state(&st);
                sync.update_synced_paths_cache(label, paths.clone());
                out.push((label.clone(), paths));
            }
        } else if let Some(cached) = sync.get_cached_synced_paths(label) {
            // Drive is syncing — fall back to cached snapshot so arion
            // hashes remain visible while downloads are active.
            out.push((label.clone(), cached));
        }
    }
    out
}

/// Bounded variant of the synced-paths walk for the recent-files view.
///
/// A whole-corpus walk would materialize metadata (and several string/hash
/// allocations) for EVERY synced file across all drives, even though
/// `get_recent_files` only ever looks up at most `limit` (~50) keys.
/// This allocates a `MetadataBundle` only for keys in `wanted`, so the
/// per-row cost (hex-encoding the 32-byte hash, cloning the CID) is paid for
/// the activity window, not the whole corpus. Pure (no `SyncRunner`) so the
/// allocation bound is unit-testable.
fn bundles_for_wanted_keys(
    label_maps: Vec<(String, HashMap<String, SyncedFileInfo>)>,
    wanted: &std::collections::HashSet<String>,
) -> HashMap<String, MetadataBundle> {
    let mut out = HashMap::with_capacity(wanted.len());
    for (label, paths) in label_maps {
        for (rel_path, info) in paths {
            let key = format!("{rel_path}::{label}");
            if !wanted.contains(&key) {
                continue;
            }
            out.insert(
                key,
                MetadataBundle {
                    arion_hash: info.path_hash_hex(),
                    arion_cid: info.arion_cid.to_string(),
                    uploaded_at: info.uploaded_at,
                    updated_at: info.updated_at,
                },
            );
        }
    }
    out
}

/// A recent file ready for UI rendering. Matches the frontend `FormattedUserFile`
/// shape so the hook can pass it through without transformation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub actual_file_name: String,
    pub size: u64,
    pub created_at: i64,
    pub arion_hash: String,
    pub arion_cid: String,
    pub source: String,
    pub miner_ids: Vec<String>,
    pub is_assigned: bool,
    pub last_charged_at: i64,
    pub file_hash: String,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub file_type: String,
    pub is_erasure_coded: bool,
    pub main_req_hash: String,
    pub label: String,
}

/// Bundled per-file metadata from synced paths, used to enrich recent file entries.
/// Keyed by `"filename::label"` in the lookup map.
struct MetadataBundle {
    arion_hash: String,
    arion_cid: String,
    uploaded_at: i64,
    updated_at: i64,
}

/// Fetch recent files by joining sync activity, sync paths, and file metadata.
///
/// This replaces the 130-line orchestration in `use-recent-files/index.ts`.
/// All data joining, filtering, deduplication, and sorting happens in Rust.
#[tauri::command]
pub async fn get_recent_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    limit: Option<usize>,
) -> Result<Vec<RecentFile>> {
    // Account-scoped listing; authorize against the session account.
    let account_id = state.require_session_account(&account_id)?;
    let sync = &state.sync;
    let pool = state.pool()?;

    // 1. Get sync activity items
    let items = sync.get_sync_activity(limit, None);
    if items.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Get sync paths → build label→path lookup
    let sync_paths = crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "get_recent_files").await;
    let label_to_path: HashMap<String, String> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty() && !sp.label.is_empty())
        .map(|sp| (sp.label.clone(), sp.path.clone()))
        .collect();

    // 3. Filter deleted files FIRST so the metadata lookup below is bounded by
    //    the (<= limit) surviving activity rows, not the whole synced corpus.
    let deleted_names: std::collections::HashSet<String> = items
        .iter()
        .filter(|item| item.action == SyncActivityAction::Deleted)
        .map(|item| format!("{}::{}", item.file_name, item.label))
        .collect();

    let non_deleted: Vec<_> = items
        .iter()
        .filter(|item| item.action != SyncActivityAction::Deleted && !deleted_names.contains(&format!("{}::{}", item.file_name, item.label)))
        .collect();

    if non_deleted.is_empty() {
        return Ok(Vec::new());
    }

    // 4. Look up synced metadata for ONLY the surviving keys. Allocation scales
    //    with the activity window, not the total number of synced files.
    let wanted: std::collections::HashSet<String> = non_deleted.iter().map(|item| format!("{}::{}", item.file_name, item.label)).collect();
    let label_maps = collect_label_maps(&state.sync).await;
    let mut meta_map = bundles_for_wanted_keys(label_maps, &wanted);

    // 5. Map to RecentFile with path resolution and timestamp priority
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for item in &non_deleted {
        // Deduplicate by actualFileName + label (reuse key for meta_map lookup)
        let key = format!("{}::{}", item.file_name, item.label);
        if !seen.insert(key.clone()) {
            continue;
        }

        let sync_folder_path = label_to_path.get(item.label.as_ref());
        let source = match sync_folder_path {
            Some(path) if !item.file_name.is_empty() => format!("{path}/{}", item.file_name),
            _ => String::new(),
        };
        let display_name = item.file_name.rsplit('/').next().unwrap_or(&item.file_name).to_string();
        let display_name = if display_name.is_empty() { "Unknown".to_string() } else { display_name };

        let bundle = meta_map.remove(&key);
        let (arion_hash, arion_cid, uploaded_at_sec, updated_at_sec) = match bundle {
            Some(b) => (b.arion_hash, b.arion_cid, b.uploaded_at, b.updated_at),
            None => (String::new(), String::new(), 0, 0),
        };

        let activity_ms = if item.timestamp != 0 { item.timestamp * 1000 } else { now_ms };
        let created_at_ms = if uploaded_at_sec != 0 { uploaded_at_sec * 1000 } else { activity_ms };
        let last_charged_at_ms = if updated_at_sec != 0 {
            updated_at_sec * 1000
        } else if uploaded_at_sec != 0 {
            uploaded_at_sec * 1000
        } else {
            activity_ms
        };

        let file_type = {
            let mut chars = item.action.as_str().chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        };

        result.push(RecentFile {
            name: display_name,
            actual_file_name: item.file_name.to_string(),
            size: item.size_bytes,
            created_at: created_at_ms,
            arion_hash,
            arion_cid,
            source,
            miner_ids: Vec::new(),
            is_assigned: true,
            last_charged_at: last_charged_at_ms,
            file_hash: String::new(),
            is_folder: false,
            file_type,
            is_erasure_coded: false,
            main_req_hash: String::new(),
            label: item.label.to_string(),
        });
    }

    // 6. Sort by timestamp (newest first)
    result.sort_by_key(|b| std::cmp::Reverse(b.last_charged_at));

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bounded lookup must allocate a `MetadataBundle` only for keys in the
    /// `wanted` set, regardless of how large the synced corpus is. Seeds 1000
    /// synced files but asks for 3 keys (2 present, 1 absent) and asserts the
    /// result holds exactly the 2 present-and-wanted entries — not 1000.
    #[test]
    fn bundles_for_wanted_keys_allocates_only_for_wanted() {
        use std::collections::HashSet;
        use std::sync::Arc;

        let mut corpus: HashMap<String, SyncedFileInfo> = HashMap::new();
        for i in 0..1000 {
            corpus.insert(
                format!("file{i}.txt"),
                SyncedFileInfo {
                    path_hash: [0u8; 32],
                    arion_cid: Arc::from("cid"),
                    uploaded_at: 1,
                    updated_at: 2,
                },
            );
        }
        let label_maps = vec![("drive".to_string(), corpus)];

        let wanted: HashSet<String> = ["file3.txt::drive", "file7.txt::drive", "missing.txt::drive"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();

        let out = bundles_for_wanted_keys(label_maps, &wanted);

        assert_eq!(out.len(), 2, "only present-and-wanted keys produce bundles, not the whole corpus");
        assert!(out.contains_key("file3.txt::drive"));
        assert!(out.contains_key("file7.txt::drive"));
        assert!(!out.contains_key("missing.txt::drive"), "a wanted-but-absent key must not appear");
    }

    /// An empty wanted set yields an empty map — the recent-files path returns
    /// early on no surviving activity, but the helper must be safe regardless.
    #[test]
    fn bundles_for_wanted_keys_empty_wanted_is_empty() {
        use std::collections::HashSet;
        use std::sync::Arc;
        let mut corpus: HashMap<String, SyncedFileInfo> = HashMap::new();
        corpus.insert(
            "a.txt".to_string(),
            SyncedFileInfo {
                path_hash: [1u8; 32],
                arion_cid: Arc::from("x"),
                uploaded_at: 0,
                updated_at: 0,
            },
        );
        let out = bundles_for_wanted_keys(vec![("d".to_string(), corpus)], &HashSet::new());
        assert!(out.is_empty());
    }

    /// Regression test for the cold-start race: a `wait_for_first_reconcile`
    /// call against a registered-but-unsettled gate must block until the
    /// gate settles, NOT return immediately. Without this guard,
    /// `synced_paths_and_excludes_for_label` would observe an empty cache
    /// and `get_user_files` would return rows with `uploaded_at = 0`,
    /// rendering "—" in the UI until the user logged out and back in.
    #[tokio::test]
    async fn wait_for_first_reconcile_blocks_until_settle() {
        use hcfs_client::drive::ReconcileOutcome;
        use hcfs_client::engine::events::{NoopCallbacks, NoopEventHandler};
        use hcfs_client::engine::runner::{SyncRunner, WaitOutcome};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let sync = Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ));

        // Producer side: pre-register the gate (mirrors what
        // `spawn_reconcile_timestamps` does the moment the drive is
        // registered, before its background task starts running).
        let label = "drive-cold-start";
        let _gate = sync.first_reconcile_gate(label);

        // Settle the gate after a delay shorter than the wait budget.
        // The consumer must observe the outcome via the `changed()`
        // path on `watch::Receiver`, not the initial `borrow()`
        // fast path.
        let sync_settle = Arc::clone(&sync);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            sync_settle
                .first_reconcile_gate("drive-cold-start")
                .settle(ReconcileOutcome::Reconciled { duration_ms: 5 });
        });

        let start = Instant::now();
        let outcome = sync.wait_for_first_reconcile(label, Duration::from_millis(500)).await;
        let elapsed = start.elapsed();

        match outcome {
            WaitOutcome::Ready(ReconcileOutcome::Reconciled { duration_ms }) => {
                assert_eq!(duration_ms, 5);
            }
            other => panic!("expected Ready(Reconciled), got {other:?}"),
        }
        // The wait must have BLOCKED at least until the settle fired
        // (~40ms) — proving the cache-read isn't racing the producer.
        // Generous lower bound to absorb scheduler jitter.
        assert!(
            elapsed >= Duration::from_millis(20),
            "wait returned too quickly ({}ms) — the readiness gate is not actually blocking",
            elapsed.as_millis(),
        );
        // And the wait must NOT have run the full budget. If we hit
        // the budget, the settle didn't reach the awaiter.
        assert!(
            elapsed < Duration::from_millis(450),
            "wait exhausted budget ({}ms) — settle was missed",
            elapsed.as_millis(),
        );
    }

    /// When no gate is registered for a label (e.g. drive not in the
    /// registry yet, or already torn down), `wait_for_first_reconcile`
    /// must return `NotRegistered` immediately — never block on a
    /// missing producer. The desktop's read paths interpret this as
    /// "fall through to cache", same as `Timeout`.
    #[tokio::test]
    async fn wait_for_first_reconcile_does_not_block_on_missing_label() {
        use hcfs_client::engine::events::{NoopCallbacks, NoopEventHandler};
        use hcfs_client::engine::runner::{SyncRunner, WaitOutcome};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let sync = Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ));

        let start = Instant::now();
        let outcome = sync.wait_for_first_reconcile("does-not-exist", Duration::from_secs(5)).await;
        let elapsed = start.elapsed();

        assert!(matches!(outcome, WaitOutcome::NotRegistered), "got {outcome:?}");
        assert!(
            elapsed < Duration::from_millis(50),
            "NotRegistered must return immediately, took {}ms",
            elapsed.as_millis(),
        );
    }
}
