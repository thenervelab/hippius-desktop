//! The disk→server half of the per-cycle folder-entity sync: reconcile the
//! server's registered folder entities against the on-disk directory tree.
//!
//! Phase 1 Task 1.13 of the first-class-empty-folders plan; reworked in Phase 2
//! Task 2.2 to run as the FIRST step of a single sequential combined sync.
//!
//! # Role in the combined sync
//!
//! This module no longer spawns its own task. It exposes the pure
//! [`compute_dir_delta`] / [`DirDelta`] diff and the [`reconcile_with_on_disk`]
//! core, which the combined runner in [`crate::sync::folder_entries_materialize`]
//! calls FIRST (push local truth up: register newly-created dirs, unregister
//! locally-removed ones, update the cache + server), BEFORE it runs the
//! materialize (pull server truth down). Running reconcile first is what closes
//! the convergence race: a folder the user deleted locally is unregistered here,
//! so the subsequent materialize — which re-fetches the server set AFTER this
//! step lands — never sees it as a "create on disk" candidate. See the combined
//! runner's docs for the full argument.
//!
//! # This is a side-channel — it never touches the file sync plan
//!
//! A removed directory unregisters a folder *entity* only; it never drives a
//! file delete. The module imports no `SyncPlan` / `DriveManager` / file-tree
//! types — it only reads/writes `folder_entries_local` and calls the
//! folder-entity HTTP endpoints. The guarantee is also enforced server-side:
//! the entry-level `unregister_folder_entries` endpoint deletes zero files by
//! construction (folder entities carry no file bytes), distinct from the
//! whole-drive `unregister_folder` teardown that cascades file deletes.

use crate::error::Result;
use crate::sync::folder_entries_backfill::{build_one_shot_client, cache_folder_entries, read_cached_dir_set};
use crate::sync::mnemonic::folder_hash;
use hcfs_shared::network::MAX_REGISTER_RELATIVE_PATHS_BATCH;
use sqlx::sqlite::SqlitePool;
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// The set-difference between the on-disk directory tree and the local
/// folder-entity cache.
///
/// Both vectors are sorted (the pure [`compute_dir_delta`] derives them from
/// `BTreeSet::difference`, which yields ascending order) so the chunked network
/// calls and any logging are deterministic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DirDelta {
    /// Directories present on disk but absent from the cache — newly created,
    /// register them as server folder entities.
    pub to_register: Vec<String>,
    /// Directories present in the cache but absent on disk — removed locally,
    /// unregister their server folder entities.
    pub to_unregister: Vec<String>,
}

impl DirDelta {
    /// `true` when neither side has work — the common steady-state case where
    /// the on-disk tree already matches the cache, so the reconcile short-circuits
    /// before building an HTTP client.
    pub(crate) fn is_empty(&self) -> bool {
        self.to_register.is_empty() && self.to_unregister.is_empty()
    }
}

/// Compute the directory delta between the authoritative on-disk set and the
/// cached (server-registered) set.
///
/// Pure and total: `to_register = on_disk \ cached`, `to_unregister = cached \
/// on_disk`. The two output vectors are disjoint by construction and each is
/// sorted ascending (`BTreeSet::difference` iterates in order). Applying the
/// delta to `cached` — insert every `to_register`, remove every `to_unregister`
/// — yields exactly `on_disk`; re-computing on the converged state yields an
/// empty delta (idempotence). Both properties are proptest-pinned below.
pub(crate) fn compute_dir_delta(on_disk: &BTreeSet<String>, cached: &BTreeSet<String>) -> DirDelta {
    DirDelta {
        to_register: on_disk.difference(cached).cloned().collect(),
        to_unregister: cached.difference(on_disk).cloned().collect(),
    }
}

/// Per-label min-interval throttle.
///
/// `label -> last run Instant`. A `Mutex<HashMap>` (not atomics) because the
/// value is a compound `Instant` keyed by an owned `String`; contention is
/// negligible (one lock per completed sync cycle) and every method is fully
/// synchronous, so the no-lock-across-await axiom (`rust_quality_74`) can never
/// be tripped. Held behind an `Arc` on [`crate::app_state::AppState`] as the
/// single `folder_entity_sync` throttle that gates the combined per-cycle
/// folder-entity sync (both the reconcile and the materialize halves run under
/// it, so the two can never race over the shared cache + server set).
#[derive(Debug, Default)]
pub struct PerLabelThrottle {
    last_run: Mutex<HashMap<String, Instant>>,
}

impl PerLabelThrottle {
    /// Construct an empty throttle.
    pub fn new() -> Self {
        Self::default()
    }

    /// Return `true` and record `now` as this label's last-run time when at
    /// least `min_interval` has elapsed since the previous run (or the label has
    /// never run); return `false` without mutating otherwise.
    ///
    /// The check-and-record is a single critical section so two cycles
    /// completing back-to-back can't both pass. A poisoned lock (a panic while
    /// held — impossible here, the body has no panic site) is recovered with
    /// `into_inner` so a throttle hiccup never propagates as a hard error into
    /// the completion handler.
    pub fn should_run(&self, label: &str, min_interval: Duration) -> bool {
        let now = Instant::now();
        let mut guard = self.last_run.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match guard.get(label) {
            Some(&prev) if now.duration_since(prev) < min_interval => false,
            _ => {
                guard.insert(label.to_owned(), now);
                true
            }
        }
    }

    /// Drop a label's throttle record so its next cycle syncs immediately.
    /// Called from `handle_sync_stopped` (pause / remove / logout teardown) so a
    /// resume or re-add isn't gated by the prior episode's last-run stamp.
    pub fn clear(&self, label: &str) {
        let mut guard = self.last_run.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.remove(label);
    }

    /// Wipe every label's throttle record. Called from `handle_sync_reset`
    /// (account switch / logout / reset) so a previous account's last-run times
    /// can never gate the next account's first sync, mirroring the sibling
    /// per-label state objects' `clear_all`.
    pub fn clear_all(&self) {
        let mut guard = self.last_run.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.clear();
    }
}

/// Outcome of the reconcile half over a pre-walked on-disk set.
///
/// The gate / not-ready / walk-failure conditions are owned by the combined
/// runner now (it resolves the root and walks once for both halves), so this
/// core only reports the work it did: nothing changed, a transient failure that
/// should retry next cycle, or the applied delta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileOutcome {
    /// On-disk tree already matches the cache. The cheap common case.
    NoChanges,
    /// A transient failure (network error, missing client config). The cache
    /// reflects whatever chunks landed; the next eligible cycle re-derives the
    /// residual delta (register/unregister are idempotent).
    RetryLater,
    /// The delta was applied. `registered`/`unregistered` are the directory
    /// counts pushed to the server and mirrored into the cache.
    Reconciled { registered: u64, unregistered: u64 },
}

/// Reconcile the drive's server folder entities with a PRE-WALKED on-disk
/// directory set.
///
/// This is the reconcile core, free of the gate / root-resolve / disk-walk that
/// the combined runner ([`crate::sync::folder_entries_materialize::run_folder_entity_sync_for_drive`])
/// performs once for both halves. It reads the cache, diffs it against `on_disk`,
/// and pushes the difference up: register dirs newly on disk, unregister dirs
/// removed from disk, mirroring each landed chunk into the cache so a mid-way
/// failure still records progress.
///
/// Network / client-config errors become `Ok(RetryLater)`; only DB-layer errors
/// surface as `Err(AppError)`. `account_id` IS the substrate SS58 wire identity.
///
/// NOTE: the register/unregister NETWORK round-trips are exercised by the
/// real-backend harness (no mock). The hermetic tests cover the pure delta and
/// the cache insert+delete application.
pub(crate) async fn reconcile_with_on_disk(pool: &SqlitePool, account_id: &str, owner: &str, label: &str, on_disk: &BTreeSet<String>) -> Result<ReconcileOutcome> {
    // Read the cache and diff. An empty delta is the steady-state common case
    // and short-circuits before any HTTP client is built.
    let cached = read_cached_dir_set(pool, owner, label).await?;
    let delta = compute_dir_delta(on_disk, &cached);
    if delta.is_empty() {
        return Ok(ReconcileOutcome::NoChanges);
    }

    let client = match build_one_shot_client(pool, account_id, label).await {
        Ok(c) => c,
        Err(e) => {
            warn!(label = %label, error = %e, "reconcile: could not build HCFS client; will retry next eligible cycle");
            return Ok(ReconcileOutcome::RetryLater);
        }
    };
    let fhash = folder_hash(label);

    // Register new directories, then unregister removed ones. After EACH chunk's
    // network call succeeds we mirror it into the cache so a mid-way failure
    // still records progress and the next eligible cycle re-derives only the
    // residual delta.
    for chunk in delta.to_register.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH) {
        if let Err(e) = client.register_folder_entries(account_id, &fhash, chunk).await {
            warn!(label = %label, error = %e, "reconcile: register_folder_entries failed; will retry next eligible cycle");
            return Ok(ReconcileOutcome::RetryLater);
        }
        cache_folder_entries(pool, owner, label, chunk).await?;
    }
    for chunk in delta.to_unregister.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH) {
        match client.unregister_folder_entries(account_id, &fhash, chunk).await {
            Ok(result) => {
                // `files_deleted` is 0 by server construction for the entry-level
                // endpoint (folder entities carry no file bytes); a non-zero value
                // would mean the side-channel guarantee was violated upstream.
                if result.files_deleted != 0 {
                    warn!(label = %label, files_deleted = result.files_deleted, "reconcile: unregister reported file deletions — folder-entity endpoint should delete none");
                }
            }
            Err(e) => {
                warn!(label = %label, error = %e, "reconcile: unregister_folder_entries failed; will retry next eligible cycle");
                return Ok(ReconcileOutcome::RetryLater);
            }
        }
        delete_cached_folder_entries(pool, owner, label, chunk).await?;
    }

    let registered = delta.to_register.len() as u64;
    let unregistered = delta.to_unregister.len() as u64;
    info!(label = %label, registered, unregistered, "reconcile: applied directory delta");
    Ok(ReconcileOutcome::Reconciled { registered, unregistered })
}

/// Remove a chunk of directory rel-paths from the per-drive `folder_entries_local`
/// cache, scoped to `owner` + `label`.
///
/// This is the ONLY place rows are deleted from the cache: the backfill is
/// insert-only, the materialize never writes the cache at all, and this reconcile
/// owns removals so a directory the user deletes locally stops being re-surfaced
/// as a server folder entity. Each delete is owner+label+path scoped so one
/// account's cache can never touch another's.
pub(crate) async fn delete_cached_folder_entries(pool: &SqlitePool, owner: &str, label: &str, paths: &[String]) -> Result<()> {
    for rel in paths {
        sqlx::query("DELETE FROM folder_entries_local WHERE owner = ? AND label = ? AND relative_path = ?")
            .bind(owner)
            .bind(label)
            .bind(rel)
            .execute(pool)
            .await?;
    }
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::account_key::account_key;
    use sqlx::sqlite::SqlitePoolOptions;

    const THROTTLE_INTERVAL: Duration = Duration::from_secs(30);

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn delta_registers_new_dirs() {
        let on_disk = set(&["a", "a/b", "c"]);
        let cached = set(&["a"]);
        let delta = compute_dir_delta(&on_disk, &cached);
        assert_eq!(delta.to_register, vec!["a/b".to_string(), "c".to_string()]);
        assert!(delta.to_unregister.is_empty());
    }

    #[test]
    fn delta_unregisters_removed_dirs() {
        let on_disk = set(&["a"]);
        let cached = set(&["a", "a/b", "c"]);
        let delta = compute_dir_delta(&on_disk, &cached);
        assert!(delta.to_register.is_empty());
        assert_eq!(delta.to_unregister, vec!["a/b".to_string(), "c".to_string()]);
    }

    #[test]
    fn delta_is_empty_when_unchanged() {
        let s = set(&["a", "a/b", "c"]);
        let delta = compute_dir_delta(&s, &s);
        assert!(delta.is_empty());
    }

    #[test]
    fn delta_is_empty_when_both_empty() {
        let delta = compute_dir_delta(&BTreeSet::new(), &BTreeSet::new());
        assert!(delta.is_empty());
        assert_eq!(delta, DirDelta::default());
    }

    #[test]
    fn delta_handles_disjoint_sets() {
        let on_disk = set(&["x", "y"]);
        let cached = set(&["a", "b"]);
        let delta = compute_dir_delta(&on_disk, &cached);
        assert_eq!(delta.to_register, vec!["x".to_string(), "y".to_string()]);
        assert_eq!(delta.to_unregister, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn throttle_gates_within_interval_and_clears() {
        let throttle = PerLabelThrottle::new();
        // First call for a label always runs.
        assert!(throttle.should_run("docs", THROTTLE_INTERVAL));
        // Immediate second call is gated.
        assert!(!throttle.should_run("docs", THROTTLE_INTERVAL));
        // A different label is independent.
        assert!(throttle.should_run("photos", THROTTLE_INTERVAL));
        // A zero interval always lets the same label through.
        assert!(throttle.should_run("docs", Duration::from_secs(0)));
        // Clearing a label resets it so the next call runs again.
        throttle.clear("docs");
        assert!(throttle.should_run("docs", THROTTLE_INTERVAL));
    }

    #[test]
    fn throttle_clear_all_resets_every_label() {
        let throttle = PerLabelThrottle::new();
        assert!(throttle.should_run("docs", THROTTLE_INTERVAL));
        assert!(throttle.should_run("photos", THROTTLE_INTERVAL));
        // Both are now gated within the interval.
        assert!(!throttle.should_run("docs", THROTTLE_INTERVAL));
        assert!(!throttle.should_run("photos", THROTTLE_INTERVAL));
        // clear_all wipes every label (account switch / reset) so both run again.
        throttle.clear_all();
        assert!(throttle.should_run("docs", THROTTLE_INTERVAL));
        assert!(throttle.should_run("photos", THROTTLE_INTERVAL));
    }

    /// Static wiring guard: the completion funnel must reference the single
    /// combined folder-entity-sync spawn, so a refactor can't silently drop the
    /// per-cycle hook. `include_str!` resolves at compile time relative to THIS
    /// file.
    #[test]
    fn handle_sync_completed_references_combined_spawn() {
        let bridge_src = include_str!("../projection/tauri_bridge.rs");
        assert!(
            bridge_src.contains("spawn_folder_entity_sync"),
            "handle_sync_completed must spawn the combined per-cycle folder-entity sync; the hook was dropped"
        );
    }

    // ---- Cache application against real in-memory SQLite -------------------

    async fn temp_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory:");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        pool
    }

    async fn cached_paths(pool: &SqlitePool, owner: &str, label: &str) -> Vec<String> {
        sqlx::query_scalar::<_, String>("SELECT relative_path FROM folder_entries_local WHERE owner = ? AND label = ? ORDER BY relative_path")
            .bind(owner)
            .bind(label)
            .fetch_all(pool)
            .await
            .expect("select cached paths")
    }

    /// Applying a computed delta to the cache (insert `to_register`, delete
    /// `to_unregister`) must leave the cache rows exactly equal to the on-disk
    /// set — and must not disturb a different owner's rows. This is the cache
    /// half of the reconcile, exercised WITHOUT the network client (those calls
    /// are deferred to the real-backend harness).
    #[tokio::test]
    async fn applying_delta_converges_cache_to_on_disk_owner_scoped() {
        let pool = temp_pool().await;
        // Seed owner-a's cache with {a, a/b, c}.
        cache_folder_entries(&pool, "owner-a", "docs", &["a".to_string(), "a/b".to_string(), "c".to_string()])
            .await
            .unwrap();
        // A second owner with overlapping label/paths that must stay untouched.
        cache_folder_entries(&pool, "owner-b", "docs", &["a".to_string(), "c".to_string()])
            .await
            .unwrap();

        // On disk: a/b removed, c kept, d added → register {d}, unregister {a/b}.
        let on_disk = set(&["a", "c", "d"]);
        let cached = read_cached_dir_set(&pool, "owner-a", "docs").await.unwrap();
        let delta = compute_dir_delta(&on_disk, &cached);
        assert_eq!(delta.to_register, vec!["d".to_string()]);
        assert_eq!(delta.to_unregister, vec!["a/b".to_string()]);

        // Apply the delta to the cache exactly as the orchestrator does.
        cache_folder_entries(&pool, "owner-a", "docs", &delta.to_register).await.unwrap();
        delete_cached_folder_entries(&pool, "owner-a", "docs", &delta.to_unregister).await.unwrap();

        // owner-a's cache now equals the on-disk set.
        assert_eq!(cached_paths(&pool, "owner-a", "docs").await, vec!["a".to_string(), "c".to_string(), "d".to_string()]);
        // owner-b is untouched.
        assert_eq!(cached_paths(&pool, "owner-b", "docs").await, vec!["a".to_string(), "c".to_string()]);

        // Idempotence: re-reading and re-diffing yields an empty delta.
        let cached2 = read_cached_dir_set(&pool, "owner-a", "docs").await.unwrap();
        assert!(compute_dir_delta(&on_disk, &cached2).is_empty());
    }

    /// `delete_cached_folder_entries` only removes the named rows and only for
    /// the given owner+label — a non-existent path is a silent no-op.
    #[tokio::test]
    async fn delete_is_scoped_and_tolerates_missing_rows() {
        let pool = temp_pool().await;
        cache_folder_entries(&pool, "o", "docs", &["keep".to_string(), "drop".to_string()])
            .await
            .unwrap();
        cache_folder_entries(&pool, "o", "photos", &["drop".to_string()]).await.unwrap();

        // Delete "drop" from docs only; "ghost" doesn't exist (no-op).
        delete_cached_folder_entries(&pool, "o", "docs", &["drop".to_string(), "ghost".to_string()])
            .await
            .unwrap();

        assert_eq!(cached_paths(&pool, "o", "docs").await, vec!["keep".to_string()]);
        // The same path under a different label is untouched.
        assert_eq!(cached_paths(&pool, "o", "photos").await, vec!["drop".to_string()]);
    }

    /// The reconcile core short-circuits to `NoChanges` when the pre-walked
    /// on-disk set already equals the cache — the hermetic proof of the common
    /// steady-state path, reached before any HTTP client is built.
    #[tokio::test]
    async fn reconcile_core_no_changes_when_disk_matches_cache() {
        let pool = temp_pool().await;
        let owner = account_key("ACCT_reconcile_core_nochanges");
        cache_folder_entries(&pool, &owner, "docs", &["a".to_string(), "a/b".to_string()])
            .await
            .unwrap();

        let on_disk = set(&["a", "a/b"]);
        let outcome = reconcile_with_on_disk(&pool, "ACCT_reconcile_core_nochanges", &owner, "docs", &on_disk)
            .await
            .expect("no-changes path must not error");
        assert_eq!(outcome, ReconcileOutcome::NoChanges);
    }

    proptest::proptest! {
        /// Applying the delta to `cached` (add `to_register`, remove
        /// `to_unregister`) yields exactly `on_disk`. The load-bearing reconcile
        /// invariant: after one cycle the cache converges to disk.
        #[test]
        fn applying_delta_yields_on_disk(
            on_disk in proptest::collection::btree_set("[a-d/]{1,4}", 0..8),
            cached in proptest::collection::btree_set("[a-d/]{1,4}", 0..8),
        ) {
            let delta = compute_dir_delta(&on_disk, &cached);
            let mut converged = cached.clone();
            for r in &delta.to_register {
                converged.insert(r.clone());
            }
            for u in &delta.to_unregister {
                converged.remove(u);
            }
            proptest::prop_assert_eq!(converged, on_disk);
        }

        /// Idempotence: re-computing the delta on the converged state is empty.
        #[test]
        fn delta_is_idempotent_on_converged_state(
            on_disk in proptest::collection::btree_set("[a-d/]{1,4}", 0..8),
            cached in proptest::collection::btree_set("[a-d/]{1,4}", 0..8),
        ) {
            let delta = compute_dir_delta(&on_disk, &cached);
            let mut converged = cached.clone();
            for r in &delta.to_register {
                converged.insert(r.clone());
            }
            for u in &delta.to_unregister {
                converged.remove(u);
            }
            let second = compute_dir_delta(&on_disk, &converged);
            proptest::prop_assert!(second.is_empty());
        }
    }
}
