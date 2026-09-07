//! Per-drive synced-tree reads shared by the listing, rename, and user-files
//! paths: `synced_paths_for_label` and `synced_paths_and_excludes_for_label`,
//! plus their drive-arc + first-reconcile-wait plumbing. A dependency-free leaf
//! (only `hcfs_client` + `std`), reached via `super::synced_state::<fn>`.

use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::types::{SyncedFileInfo, build_synced_paths_from_state};
use std::collections::HashMap;
use std::path::Path;

/// Build a map of relative paths → sync info for files whose
/// `path_hash` appears in the drive's persisted `synced` tree.
/// Returns `None` when the drive isn't available (e.g. logged out)
/// so the caller can fall back to "unknown".
///
/// Waits up to [`FIRST_RECONCILE_WAIT_BUDGET`] for first reconcile
/// (DATE UPLOADED on cold start), then returns the warm cache if
/// present. `load_sync_state` is the miss path only — reloading
/// `sync_state.json` when the drive lock is free is slower and can be
/// staler mid-cycle than the incrementally-updated cache. See
/// [`synced_paths_and_excludes_for_label`] for the exclude rationale.
pub(super) async fn synced_paths_for_label(sync: &SyncRunner, label: &str) -> Option<HashMap<String, SyncedFileInfo>> {
    let _ = sync.wait_for_first_reconcile(label, FIRST_RECONCILE_WAIT_BUDGET).await;
    // The cache is the live listing source of truth (register, reconcile,
    // per-file upsert, post_sync_cleanup). Reloading `sync_state.json` when
    // the drive lock is free is slower and can be staler mid-cycle than the
    // incrementally-updated cache. Disk load is the miss path only.
    if let Some(cached) = sync.get_cached_synced_paths(label) {
        return Some(cached);
    }
    let arc = match acquire_drive_arc(sync, label) {
        DriveArcOutcome::Acquired(arc) => arc,
        DriveArcOutcome::CacheFallback => return None,
    };
    // `try_lock` (not `lock().await`) is essential here: the per-drive
    // mutex is held by the sync loop for the duration of a sync cycle,
    // and the file browser must remain responsive during that window.
    match arc.try_lock() {
        Ok(manager) => match manager.load_sync_state().await {
            Ok(state) => {
                let paths = build_synced_paths_from_state(&state);
                sync.update_synced_paths_cache(label, paths.clone());
                Some(paths)
            }
            Err(_) => None,
        },
        Err(_) => None,
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

    if let Some(cached) = sync.get_cached_synced_paths(label) {
        // `list_exclude_patterns` re-reads `.hippius/exclude` (a few short
        // lines) rather than serving a cached copy, so this is a small
        // synchronous read, not the sync-state JSON parse. Still `try_lock`
        // so a mid-sync listing does not wait on the cycle — at the cost of
        // returning NO patterns while a drive is syncing, which briefly
        // un-hides excluded rows.
        let excludes = match acquire_drive_arc(sync, label) {
            DriveArcOutcome::Acquired(arc) => match arc.try_lock() {
                Ok(manager) => manager.list_exclude_patterns(),
                Err(_) => Vec::new(),
            },
            DriveArcOutcome::CacheFallback => Vec::new(),
        };
        return (Some(cached), excludes);
    }

    let arc = match acquire_drive_arc(sync, label) {
        DriveArcOutcome::Acquired(arc) => arc,
        DriveArcOutcome::CacheFallback => return (None, Vec::new()),
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
        Err(_) => (None, Vec::new()),
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

/// Whether a folder's contents are all present on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FolderSettlement {
    /// Every rel-path the drive knows under this folder exists on disk.
    Settled,
    /// At least one known child is missing locally — the same condition that
    /// makes `list_sync_folder_grouped` report `sync_status: "pending"`.
    Pending,
    /// No synced map available: the drive is paused, logged out, or still cold.
    Unknown,
}

/// Classify `folder_rel` under `sync_root` against the drive's synced rel-paths.
///
/// `synced_rel_paths` is the engine's `synced` tree, the same source the file
/// browser's pending badge reads, so a caller's verdict and the badge the user
/// is looking at cannot disagree.
///
/// A future caller deciding whether to hand a folder's bytes to a third party
/// must treat [`FolderSettlement::Unknown`] as a refusal, never as permission —
/// otherwise pausing a drive becomes a way to bypass the check (the zip-era
/// folder share held that line). Folder rename — today's only caller — is the
/// deliberate exception: it is a local operation the sync engine reconciles
/// either way, so it proceeds when the answer is unknown.
pub(crate) fn folder_settlement(sync_root: &Path, folder_rel: &str, synced_rel_paths: Option<&[String]>) -> FolderSettlement {
    let Some(rel_paths) = synced_rel_paths else {
        return FolderSettlement::Unknown;
    };

    // Compare against a trailing-slash prefix so a sibling whose name merely
    // starts with this folder's name ("trips2/x" vs "trips") is not read as a
    // child of it.
    //
    // The drive root is the exception: it addresses every path in the drive, so
    // its prefix is empty rather than "/" — which nothing starts with, and would
    // make the loop match nothing and report Settled without checking anything.
    let trimmed = folder_rel.trim_end_matches('/');
    let prefix = if trimmed.is_empty() { String::new() } else { format!("{trimmed}/") };
    for rel in rel_paths {
        if rel.starts_with(&prefix) && !sync_root.join(rel).exists() {
            return FolderSettlement::Pending;
        }
    }

    FolderSettlement::Settled
}

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

#[cfg(test)]
mod tests {
    use super::{FolderSettlement, folder_settlement};
    use tempfile::TempDir;

    #[test]
    fn settled_when_every_synced_child_is_on_disk() {
        let root = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(root.path().join("trips/2024")).expect("mkdir");
        std::fs::write(root.path().join("trips/2024/a.jpg"), b"x").expect("write");

        let synced = vec!["trips/2024/a.jpg".to_string()];

        assert_eq!(folder_settlement(root.path(), "trips", Some(&synced)), FolderSettlement::Settled);
    }

    /// A path the drive knows about but disk lacks is exactly the condition
    /// `list_sync_folder_grouped` renders as `pending`. Zipping here would hand
    /// the recipient an archive silently missing that file.
    #[test]
    fn unsettled_when_a_synced_child_is_missing_on_disk() {
        let root = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(root.path().join("trips")).expect("mkdir");

        let synced = vec!["trips/2024/a.jpg".to_string()];

        assert_eq!(folder_settlement(root.path(), "trips", Some(&synced)), FolderSettlement::Pending);
    }

    /// A paused or logged-out drive yields no map. Callers that hand bytes to a
    /// third party must refuse on unknown, or pausing a drive would become a way
    /// to bypass the check entirely.
    #[test]
    fn unknown_when_the_drive_has_no_synced_map() {
        let root = TempDir::new().expect("temp dir");

        assert_eq!(folder_settlement(root.path(), "trips", None), FolderSettlement::Unknown);
    }

    #[test]
    fn a_sibling_sharing_a_name_prefix_is_not_treated_as_a_child() {
        let root = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(root.path().join("trips")).expect("mkdir");

        // "trips2/x.jpg" is a sibling, not a child of "trips".
        let synced = vec!["trips2/x.jpg".to_string()];

        assert_eq!(folder_settlement(root.path(), "trips", Some(&synced)), FolderSettlement::Settled);
    }

    /// The drive root addresses every path in the drive, so an empty
    /// `folder_rel` must check ALL of them. A `"{folder}/"` prefix built from an
    /// empty string is `"/"`, which no rel-path starts with — the loop would
    /// match nothing and report `Settled` without having checked anything,
    /// silently skipping the guard for a whole-drive share.
    #[test]
    fn the_drive_root_checks_every_path_rather_than_none() {
        let root = TempDir::new().expect("temp dir");

        let synced = vec!["trips/2024/a.jpg".to_string()];

        assert_eq!(folder_settlement(root.path(), "", Some(&synced)), FolderSettlement::Pending);
    }

    #[test]
    fn a_trailing_slash_on_the_folder_does_not_change_the_answer() {
        let root = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(root.path().join("trips")).expect("mkdir");

        let synced = vec!["trips/a.jpg".to_string()];

        assert_eq!(folder_settlement(root.path(), "trips/", Some(&synced)), FolderSettlement::Pending);
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

    /// A registered drive whose on-disk `sync_state.json` is empty must not
    /// clobber a warm cache. The cache is updated incrementally (file-synced,
    /// reconcile, post_sync_cleanup); the disk file can lag mid-cycle.
    #[tokio::test]
    async fn warm_cache_wins_over_empty_on_disk_state() {
        use hcfs_client::engine::events::{NoopCallbacks, NoopEventHandler};
        use hcfs_client::engine::manager::DriveManager;
        use hcfs_client::engine::runner::{DriveSlot, SyncRunner};
        use hcfs_client::engine::types::SyncedFileInfo;
        use std::collections::HashMap;
        use std::sync::Arc;
        use tokio::sync::Mutex as TokioMutex;
        use tokio_util::sync::CancellationToken;

        let tmp = TempDir::new().expect("tempdir");
        let sync_path = tmp.path().join("sync");
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&sync_path).expect("sync dir");
        std::fs::create_dir_all(&config_dir).expect("config dir");
        std::fs::write(config_dir.join("sync_state.json"), br#"{"local":{},"remote":{},"synced":{}}"#).expect("empty state");

        let sync = Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ));
        let label = "warm-cache-drive";
        {
            let manager = DriveManager::new(sync_path.clone(), config_dir);
            let mut guard = sync.drives.lock().await;
            guard.insert(
                label.to_string(),
                DriveSlot {
                    manager: Arc::new(TokioMutex::new(manager)),
                    cancel_token: CancellationToken::new(),
                    sync_path,
                },
            );
        }

        let mut cache = HashMap::new();
        cache.insert(
            "cache.txt".to_string(),
            SyncedFileInfo {
                path_hash: [0x11; 32],
                arion_cid: Arc::from("cid-cache"),
                uploaded_at: 1,
                updated_at: 2,
            },
        );
        sync.update_synced_paths_cache(label, cache);

        let got = super::synced_paths_for_label(&sync, label).await.expect("cache hit");
        assert!(
            got.contains_key("cache.txt"),
            "warm cache must win over empty disk state, keys={:?}",
            got.keys().collect::<Vec<_>>(),
        );
        assert_eq!(got.len(), 1, "disk load must not replace the cache with an empty map");

        let (got_ex, excludes) = super::synced_paths_and_excludes_for_label(&sync, label).await;
        assert!(got_ex.expect("cache hit").contains_key("cache.txt"));
        assert!(excludes.is_empty(), "empty exclude file is fine");
    }

    #[tokio::test]
    async fn cache_miss_and_no_drive_returns_none() {
        use hcfs_client::engine::events::{NoopCallbacks, NoopEventHandler};
        use hcfs_client::engine::runner::SyncRunner;
        use std::sync::Arc;

        let sync = Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ));
        assert!(super::synced_paths_for_label(&sync, "missing").await.is_none());
        let (paths, excludes) = super::synced_paths_and_excludes_for_label(&sync, "missing").await;
        assert!(paths.is_none());
        assert!(excludes.is_empty());
    }
}
