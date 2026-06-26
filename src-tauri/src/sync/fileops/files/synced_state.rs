//! Per-drive synced-tree reads shared by the listing, rename, and user-files
//! paths: `synced_paths_for_label` and `synced_paths_and_excludes_for_label`,
//! plus their drive-arc + first-reconcile-wait plumbing. A dependency-free leaf
//! (only `hcfs_client` + `std`), reached via `super::synced_state::<fn>`.

use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::types::{SyncedFileInfo, build_synced_paths_from_state};
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

#[cfg(test)]
mod tests {

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
