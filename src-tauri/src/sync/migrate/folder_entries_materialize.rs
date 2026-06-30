//! The server→disk half of the per-cycle folder-entity sync, plus the combined
//! runner that sequences it after the reconcile.
//!
//! Phase 2 Task 2.2 of the first-class-empty-folders plan.
//!
//! # The pair runs SEQUENTIALLY in one task — reconcile, then materialize
//!
//! [`run_folder_entity_sync_for_drive`] is the single per-cycle entry point. It
//! resolves the drive root and walks the on-disk tree ONCE, then runs the two
//! halves in order:
//!
//! 1. **Reconcile** ([`crate::sync::folder_entries_reconcile::reconcile_with_on_disk`])
//!    pushes the *local* truth UP: it registers dirs newly on disk and
//!    unregisters dirs removed from disk, updating both the server and the
//!    `folder_entries_local` cache.
//! 2. **Materialize** (this module) then pulls the *server* truth DOWN over the
//!    NOW-CONSISTENT server set: it creates directories the server still has but
//!    the disk does not (an empty folder another device made), and removes local
//!    directories the server no longer knows about (an empty folder deleted
//!    elsewhere) — empty-only.
//!
//! Sequencing is the whole point — see [`compute_materialize_plan`]'s docs for
//! why concurrent reconcile + materialize would resurrect a locally-deleted
//! folder and why running them in this order over a single shared disk walk and
//! a single throttle fixes it.
//!
//! # This is a side-channel — it never touches the file sync plan
//!
//! Materialize ONLY creates and removes EMPTY directories. It imports no
//! `SyncPlan` / `DriveManager` / file-tree types, never uploads or deletes a
//! file, and refuses to delete any directory that has contents on disk: if the
//! user dropped files into a folder, those files sync through the normal engine
//! and the directory must stay. The removal primitive is [`std::fs::remove_dir`]
//! (NOT `remove_dir_all`), which fails on a non-empty directory — so even if a
//! file lands between the emptiness check and the unlink (a TOCTOU window), the
//! unlink fails and the directory survives.
//!
//! # Gate + cadence
//!
//! Gated on the backfill flag (`is_folder_entries_backfilled`); hooked into
//! [`crate::sync::tauri_bridge::handle_sync_completed`] — the single
//! per-cycle-per-drive completion funnel — as a fire-and-forget spawn, throttled
//! per-label by the single `AppState.folder_entity_sync` throttle that gates the
//! whole combined step (one throttle, not one per half, so the two can never run
//! out of step).

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::error::Result;
use crate::sync::config::get_sync_path_for_label;
use crate::sync::folder_entries_backfill::{build_one_shot_client, is_folder_entries_backfilled, read_cached_dir_set, walk_on_disk_dir_set};
use crate::sync::folder_entries_reconcile::{reconcile_with_on_disk, ReconcileOutcome};
use crate::sync::mnemonic::folder_hash;
use sqlx::sqlite::SqlitePool;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tracing::{debug, info, warn};

/// Minimum wall-clock gap between combined folder-entity-sync runs for a drive.
///
/// Well below a human's "I made a folder on my laptop and it should appear on my
/// desktop" patience, while collapsing a burst of short sync cycles into one
/// reconcile + materialize pass. Best-effort, not a correctness boundary — a
/// skipped cycle's changes are picked up by the next eligible cycle.
const MIN_FOLDER_ENTITY_SYNC_INTERVAL: Duration = Duration::from_secs(30);

/// The set-difference between the server's folder-entity set and the local
/// on-disk directory tree, partitioned into the disk mutations to apply.
///
/// Both vectors are sorted ascending (`BTreeSet::difference` yields ascending
/// order) so the apply order and any logging are deterministic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MaterializePlan {
    /// Directories the server has but the local disk does not — create them
    /// (an empty folder another device made). `server \ disk`.
    pub to_create: Vec<String>,
    /// Directories the local disk has, the cache knows about (so they were
    /// synced here from the server at some point), but the server no longer
    /// lists (deleted on another device) — candidates for empty-only removal.
    /// `(cache ∩ disk) \ server`.
    pub to_remove: Vec<String>,
}

impl MaterializePlan {
    /// `true` when neither side has work — the common steady-state case where
    /// the on-disk tree already matches the server, so the materialize
    /// short-circuits before touching the filesystem.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.to_create.is_empty() && self.to_remove.is_empty()
    }
}

/// Compute the directory plan that converges the local disk toward the server.
///
/// Pure and total:
/// - `to_create = server \ disk` — every server directory absent on disk.
/// - `to_remove = (cache ∩ disk) \ server` — every directory that is on disk,
///   was previously registered from this device (so it lives in the cache), and
///   the server has since dropped.
///
/// The **cache-membership requirement on `to_remove` is load-bearing**: a
/// directory the user just created locally is on disk and absent from the server
/// — but it is NOT yet in the cache (the reconcile only inserts it after it
/// registers it). Excluding non-cache paths is exactly what stops materialize
/// from deleting a brand-new local folder before reconcile has had a chance to
/// push it up.
///
/// # Why this MUST run AFTER the reconcile (the convergence race)
///
/// The dangerous pair is NOT `to_create` (server-only) vs the reconcile's
/// `to_register` (disk-only) — those are trivially disjoint. It is `to_create`
/// vs the reconcile's `to_unregister`. Consider a folder X the user just deleted
/// locally: `disk = no`, `cache = yes`, `server = yes`. Reconcile wants to
/// unregister X (it is in `cache \ disk`); materialize, looking at the server
/// snapshot, wants to CREATE X on disk (it is in `server \ disk`). They encode
/// opposite policies for the same path. Run concurrently with separate server
/// snapshots, the worst interleave is: materialize reads server `{X}` →
/// reconcile unregisters X and clears its cache row → materialize, holding the
/// stale snapshot, re-creates X on disk → the next reconcile re-registers it.
/// The user's deletion is silently, stickily undone.
///
/// **Sequencing resolves it, not disjointness.** The combined runner
/// ([`run_folder_entity_sync_for_drive`]) runs the reconcile to completion
/// FIRST, so X is unregistered from the server before materialize runs. Because
/// materialize then fetches `list_folder_entries` AFTER that unregister has
/// landed, X is already gone from the server set, so `to_create = server \ disk`
/// no longer contains it — no resurrection. Applying the (post-reconcile) plan
/// and re-deriving on the converged tree yields an empty plan (idempotence);
/// disjointness of the create/remove halves and the create-convergence are
/// proptest-pinned below.
#[must_use]
pub fn compute_materialize_plan(server: &BTreeSet<String>, disk: &BTreeSet<String>, cache: &BTreeSet<String>) -> MaterializePlan {
    let to_create: Vec<String> = server.difference(disk).cloned().collect();
    // (cache ∩ disk) \ server — present locally, sourced from the server, now gone server-side.
    let to_remove: Vec<String> = disk
        .iter()
        .filter(|d| cache.contains(*d) && !server.contains(*d))
        .cloned()
        .collect();
    MaterializePlan { to_create, to_remove }
}

/// Join a server-supplied drive-relative path onto `root`, returning the
/// absolute path ONLY when every component is a plain `Normal` segment.
///
/// The rel-paths come from the server, which already validates them on
/// registration — but defense in depth is cheap and this is the single place a
/// server string becomes a filesystem path. The check is component-level (the
/// path_validator exemplar's idiom), NOT a `contains("..")` substring scan that
/// would false-reject a legitimate `foo..bar` segment: an empty string, an
/// absolute path, a Windows prefix/root, a `.`, or any `..` component returns
/// `None` and the caller skips it. A returned path is guaranteed to start with
/// `root` and to stay inside it.
#[must_use]
pub fn safe_join_under_root(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let candidate = Path::new(rel);
    let mut joined = root.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::Normal(seg) => joined.push(seg),
            // Absolute roots, Windows drive prefixes, `..` traversal, and `.`
            // are all rejected — a server folder entity is always a clean
            // forward-slash relative path of Normal segments.
            Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir => return None,
        }
    }
    Some(joined)
}

/// Pure emptiness guard for orphan removal: `true` IFF `path` exists, is a
/// directory, and contains zero entries on disk.
///
/// This is the predicate that makes materialize safe to delete with: a directory
/// the user filled with files reads back a non-empty `read_dir`, so it returns
/// `false` and is left entirely alone. `std::fs::read_dir` never yields `.`/`..`,
/// so a directory whose only "contents" are those special entries reads as empty
/// — correct. Any I/O error (race, permissions) is treated as "not safe to
/// remove" → `false`, the conservative direction.
///
/// Note this is a *check*, not the removal itself: the caller still uses
/// [`std::fs::remove_dir`], which independently fails on a non-empty directory,
/// closing the TOCTOU window where a file could land between this check and the
/// unlink.
#[must_use]
pub fn should_remove_orphan_dir(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_dir() {
        return false;
    }
    match std::fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

/// Apply a materialize plan to the on-disk tree under `root`, returning
/// `(created, removed)` counts. Pure filesystem work — no DB, no network — so it
/// runs hermetically on a `tempfile::tempdir()` in tests and on `spawn_blocking`
/// in production.
///
/// Creation uses `create_dir_all` (idempotent, builds parents); a path that
/// already exists is skipped and not counted. Removal walks `to_remove`
/// **deepest-first** (`.rev()` over the ascending vec) so a removed parent's
/// now-empty children are unlinked before the parent in a single pass, and gates
/// every unlink behind [`should_remove_orphan_dir`] AND the non-empty-failing
/// [`std::fs::remove_dir`]. A directory that is not empty (the user added files)
/// is left untouched.
#[must_use]
pub fn apply_materialize_plan(root: &Path, plan: &MaterializePlan) -> (u64, u64) {
    let mut created = 0u64;
    for rel in &plan.to_create {
        let Some(target) = safe_join_under_root(root, rel) else {
            warn!(rel = %rel, "materialize: server path failed containment check; skipping create");
            continue;
        };
        if target.exists() {
            // A non-directory already occupying the path means a file shares the
            // name a server folder entity wants — leave the user's file, the
            // engine surfaces the name clash through the normal sync.
            if !target.is_dir() {
                debug!(rel = %rel, "materialize: a non-directory already occupies the target path; skipping create");
            }
            continue;
        }
        match std::fs::create_dir_all(&target) {
            Ok(()) => created += 1,
            Err(e) => warn!(rel = %rel, error = %e, "materialize: create_dir_all failed; will retry next cycle"),
        }
    }

    let mut removed = 0u64;
    for rel in plan.to_remove.iter().rev() {
        let Some(target) = safe_join_under_root(root, rel) else {
            warn!(rel = %rel, "materialize: server path failed containment check; skipping remove");
            continue;
        };
        if !should_remove_orphan_dir(&target) {
            debug!(rel = %rel, "materialize: orphan dir is non-empty or absent; leaving it in place");
            continue;
        }
        // `remove_dir` (not `remove_dir_all`) is the TOCTOU-safe primitive: if a
        // file landed since the emptiness check, the unlink errors and the dir
        // survives. We never recursively delete user data.
        match std::fs::remove_dir(&target) {
            Ok(()) => removed += 1,
            Err(e) => debug!(rel = %rel, error = %e, "materialize: remove_dir refused (became non-empty?); leaving it"),
        }
    }

    (created, removed)
}

/// Outcome of the materialize half over a pre-walked on-disk set.
///
/// The standalone wrapper [`materialize_folder_entries_for_drive`] additionally
/// reports the gate / not-ready conditions; the core
/// [`materialize_with_on_disk`] only returns the last three.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializeOutcome {
    /// The backfill hasn't completed for this drive yet — materialize defers to
    /// it (the device's own dirs aren't registered until it finishes). No-op.
    NotBackfilledYet,
    /// The sync root isn't on disk (drive removed / not finished initializing).
    /// Harmless — the next eligible cycle retries.
    NotReady,
    /// The server set already matches the on-disk tree. The cheap common case.
    NoChanges,
    /// A transient failure (network error fetching the server list, missing
    /// client config). The next eligible cycle re-derives the residual plan.
    RetryLater,
    /// The plan was applied. `created`/`removed` are the directory counts.
    Materialized { created: u64, removed: u64 },
}

/// A drive's gate + sync-root resolution result, shared by the standalone
/// materialize wrapper and the combined runner so both gate identically.
enum DriveRoot {
    /// The backfill hasn't completed — defer.
    NotBackfilled,
    /// No `sync_paths` row or the root isn't on disk yet — transient.
    NotReady,
    /// The backfilled drive's sync root, confirmed to be a directory.
    Ready(PathBuf),
}

/// Gate on the backfill flag and resolve the on-disk sync root for `label`.
///
/// Returns `NotBackfilled` until the one-shot backfill has bootstrapped the
/// drive (so neither half runs early and races the bootstrap), `NotReady` when
/// the row is missing or the directory isn't on disk yet, else the confirmed
/// root. Only DB-layer errors surface as `Err`.
async fn resolve_backfilled_sync_root(pool: &SqlitePool, owner: &str, account_id: &str, label: &str) -> Result<DriveRoot> {
    if !is_folder_entries_backfilled(pool, owner, label).await? {
        return Ok(DriveRoot::NotBackfilled);
    }
    let sync_root = match get_sync_path_for_label(pool, account_id, label).await {
        Ok(p) => PathBuf::from(p),
        Err(e) => {
            debug!(label = %label, error = %e, "folder-entity sync: no sync_paths row; not ready");
            return Ok(DriveRoot::NotReady);
        }
    };
    if !sync_root.is_dir() {
        debug!(label = %label, root = %sync_root.display(), "folder-entity sync: sync root not on disk; not ready");
        return Ok(DriveRoot::NotReady);
    }
    Ok(DriveRoot::Ready(sync_root))
}

/// Materialize the server's folder entities onto a PRE-WALKED on-disk set.
///
/// The core, free of the gate / root-resolve / disk-walk the caller performs. It
/// fetches the CURRENT server list (after any reconcile the combined runner ran
/// first), diffs it against `on_disk` + the cache, and applies the plan on a
/// blocking thread. Materialize deliberately does NOT write the cache — the
/// reconcile is the sole cache writer; a created dir is registered + cached by
/// the next cycle's reconcile (idempotent server-side), and a removed dir's stale
/// cache row is dropped by the next reconcile's unregister.
///
/// Network / client-config errors become `Ok(RetryLater)`; only DB-layer errors
/// surface as `Err(AppError)`.
async fn materialize_with_on_disk(pool: &SqlitePool, account_id: &str, owner: &str, label: &str, root: &Path, on_disk: &BTreeSet<String>) -> Result<MaterializeOutcome> {
    let client = match build_one_shot_client(pool, account_id, label).await {
        Ok(c) => c,
        Err(e) => {
            warn!(label = %label, error = %e, "materialize: could not build HCFS client; will retry next eligible cycle");
            return Ok(MaterializeOutcome::RetryLater);
        }
    };
    let fhash = folder_hash(label);
    let server: BTreeSet<String> = match client.list_folder_entries(account_id, &fhash).await {
        Ok(paths) => paths.into_iter().collect(),
        Err(e) => {
            warn!(label = %label, error = %e, "materialize: list_folder_entries failed; will retry next eligible cycle");
            return Ok(MaterializeOutcome::RetryLater);
        }
    };

    let cache = read_cached_dir_set(pool, owner, label).await?;
    let plan = compute_materialize_plan(&server, on_disk, &cache);
    if plan.is_empty() {
        return Ok(MaterializeOutcome::NoChanges);
    }

    let root = root.to_path_buf();
    let (created, removed) = match tokio::task::spawn_blocking(move || apply_materialize_plan(&root, &plan)).await {
        Ok(counts) => counts,
        Err(e) => {
            warn!(label = %label, error = %e, "materialize: apply task panicked; will retry next eligible cycle");
            return Ok(MaterializeOutcome::RetryLater);
        }
    };
    info!(label = %label, created, removed, "materialize: applied directory plan");
    Ok(MaterializeOutcome::Materialized { created, removed })
}

/// Run the materialize half STANDALONE for one drive (gate + root + single walk
/// + [`materialize_with_on_disk`]).
///
/// `pub` so the real-backend harness can drive the materialize mechanics
/// (create + empty-only-remove + guard) in isolation. Production uses the
/// combined [`run_folder_entity_sync_for_drive`] instead, which reconciles first.
pub async fn materialize_folder_entries_for_drive(state: &AppState, account_id: &str, label: &str) -> Result<MaterializeOutcome> {
    let pool = state.pool()?.clone();
    let owner = account_key(account_id);
    match resolve_backfilled_sync_root(&pool, &owner, account_id, label).await? {
        DriveRoot::NotBackfilled => Ok(MaterializeOutcome::NotBackfilledYet),
        DriveRoot::NotReady => Ok(MaterializeOutcome::NotReady),
        DriveRoot::Ready(root) => {
            let Some(on_disk) = walk_on_disk_dir_set(root.clone(), label).await else {
                return Ok(MaterializeOutcome::RetryLater);
            };
            materialize_with_on_disk(&pool, account_id, &owner, label, &root, &on_disk).await
        }
    }
}

/// Outcome of the combined per-cycle folder-entity sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderEntitySyncOutcome {
    /// The backfill hasn't completed for this drive yet — defer.
    NotBackfilledYet,
    /// The drive isn't ready (no row / root not on disk). Retry next cycle.
    NotReady,
    /// The single disk walk failed transiently. Retry next cycle.
    RetryLater,
    /// Both halves ran. Carries each half's outcome for logging / assertions.
    Ran { reconcile: ReconcileOutcome, materialize: MaterializeOutcome },
}

/// Run the combined per-cycle folder-entity sync for one drive: reconcile
/// (disk→server) THEN materialize (server→disk), over a SINGLE disk walk.
///
/// This is the production entry point. Gating + root-resolve + the tree walk
/// happen once here and feed both halves; the reconcile runs to completion
/// before the materialize fetches the server list, which is what prevents the
/// locally-deleted-folder resurrection race (see [`compute_materialize_plan`]).
/// `pub` so the real-backend harness can drive the combined step end to end.
///
/// The two `.await`s run strictly sequentially (Rust futures are not eager), so
/// "reconcile then materialize" is guaranteed ordering, not a hope.
pub async fn run_folder_entity_sync_for_drive(state: &AppState, account_id: &str, label: &str) -> Result<FolderEntitySyncOutcome> {
    let pool = state.pool()?.clone();
    let owner = account_key(account_id);

    let root = match resolve_backfilled_sync_root(&pool, &owner, account_id, label).await? {
        DriveRoot::NotBackfilled => return Ok(FolderEntitySyncOutcome::NotBackfilledYet),
        DriveRoot::NotReady => return Ok(FolderEntitySyncOutcome::NotReady),
        DriveRoot::Ready(r) => r,
    };

    // The single per-cycle walk, shared by both halves.
    let Some(on_disk) = walk_on_disk_dir_set(root.clone(), label).await else {
        return Ok(FolderEntitySyncOutcome::RetryLater);
    };

    // 1. Push local truth up: register new dirs, unregister locally-removed ones,
    //    updating the server + cache. Runs to completion before step 2.
    let reconcile = reconcile_with_on_disk(&pool, account_id, &owner, label, &on_disk).await?;
    // 2. Pull server truth down over the NOW-CONSISTENT server set: a folder the
    //    user deleted locally was just unregistered above, so the fresh
    //    list_folder_entries materialize fetches no longer lists it → it is not
    //    re-created on disk.
    let materialize = materialize_with_on_disk(&pool, account_id, &owner, label, &root, &on_disk).await?;
    Ok(FolderEntitySyncOutcome::Ran { reconcile, materialize })
}

/// Spawn the combined per-cycle folder-entity sync as a detached tokio task,
/// gated by the single per-label throttle.
///
/// Called from [`crate::sync::tauri_bridge::handle_sync_completed`] — the single
/// per-cycle-per-drive completion funnel — so the sync runs at most once per
/// completed cycle per drive, and at most once per
/// [`MIN_FOLDER_ENTITY_SYNC_INTERVAL`]. The throttle is checked synchronously
/// BEFORE spawning so a throttled cycle costs nothing; the walk + network run off
/// the event thread.
pub(crate) fn spawn_folder_entity_sync(app: tauri::AppHandle, account_id: String, label: String) {
    use tauri::Manager;
    {
        let state = app.state::<AppState>();
        if !state.folder_entity_sync.should_run(&label, MIN_FOLDER_ENTITY_SYNC_INTERVAL) {
            debug!(label = %label, "folder-entity sync: throttled; a recent cycle already ran this drive");
            return;
        }
    }
    tokio::spawn(async move {
        let state = app.state::<AppState>();
        match run_folder_entity_sync_for_drive(&state, &account_id, &label).await {
            Ok(FolderEntitySyncOutcome::Ran { reconcile, materialize }) => {
                info!(label = %label, ?reconcile, ?materialize, "folder-entity sync task finished");
            }
            Ok(FolderEntitySyncOutcome::NotBackfilledYet) => debug!(label = %label, "folder-entity sync: backfill not done yet; deferring"),
            Ok(FolderEntitySyncOutcome::NotReady) => debug!(label = %label, "folder-entity sync: drive not ready; will retry next eligible cycle"),
            Ok(FolderEntitySyncOutcome::RetryLater) => debug!(label = %label, "folder-entity sync: transient failure; will retry next eligible cycle"),
            Err(e) => warn!(label = %label, error = ?e, "folder-entity sync: unexpected error"),
        }
    });
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    // ---- Pure plan ---------------------------------------------------------

    #[test]
    fn plan_creates_server_only_dirs() {
        let server = set(&["a", "a/b", "c"]);
        let disk = set(&["a"]);
        let cache = set(&["a"]);
        let plan = compute_materialize_plan(&server, &disk, &cache);
        assert_eq!(plan.to_create, vec!["a/b".to_string(), "c".to_string()]);
        assert!(plan.to_remove.is_empty());
    }

    #[test]
    fn plan_removes_only_cache_known_server_absent_dirs() {
        // `gone` is on disk + cache but not server → remove candidate.
        // `fresh` is on disk but NOT in cache (user just made it) → never removed.
        let server = set(&["keep"]);
        let disk = set(&["keep", "gone", "fresh"]);
        let cache = set(&["keep", "gone"]);
        let plan = compute_materialize_plan(&server, &disk, &cache);
        assert!(plan.to_create.is_empty());
        assert_eq!(plan.to_remove, vec!["gone".to_string()], "only the cache-known, server-absent dir is a removal candidate");
    }

    #[test]
    fn plan_never_removes_a_brand_new_local_dir() {
        // The load-bearing safety property: a dir the user just created locally
        // is on disk and absent from the server, but absent from the cache too —
        // it must not be a removal candidate.
        let server = set(&[]);
        let disk = set(&["new_local"]);
        let cache = set(&[]);
        let plan = compute_materialize_plan(&server, &disk, &cache);
        assert!(plan.to_remove.is_empty(), "a non-cache local dir is never removed");
        assert!(plan.to_create.is_empty());
    }

    /// The C1 race-state, at the plan level: a folder deleted locally
    /// (`disk=no, cache=yes`) while the server STILL lists it. Run on the STALE
    /// pre-reconcile server set, `to_create` contains it — which is exactly why
    /// the plan must be computed over the POST-reconcile server set, where the
    /// reconcile has already unregistered it. This test documents the hazard the
    /// sequencing closes.
    #[test]
    fn plan_over_stale_server_set_would_recreate_locally_deleted_dir() {
        let stale_server = set(&["X"]);
        let disk = set(&[]); // user deleted X locally
        let cache = set(&["X"]);
        let stale_plan = compute_materialize_plan(&stale_server, &disk, &cache);
        assert_eq!(stale_plan.to_create, vec!["X".to_string()], "stale server set WOULD resurrect X — sequencing prevents this snapshot from ever being used");

        // Over the post-reconcile server set (X unregistered), no resurrection.
        let fresh_server = set(&[]);
        let fresh_plan = compute_materialize_plan(&fresh_server, &disk, &cache);
        assert!(fresh_plan.is_empty(), "post-reconcile server set leaves nothing to create or remove");
    }

    #[test]
    fn plan_is_empty_when_converged() {
        let s = set(&["a", "a/b"]);
        let plan = compute_materialize_plan(&s, &s, &s);
        assert!(plan.is_empty());
        assert_eq!(plan, MaterializePlan::default());
    }

    // ---- Pure containment join --------------------------------------------

    #[test]
    fn safe_join_accepts_normal_rel_path() {
        let root = Path::new("/sync/root");
        let joined = safe_join_under_root(root, "a/b/c").expect("normal path joins");
        assert_eq!(joined, Path::new("/sync/root/a/b/c"));
        assert!(joined.starts_with(root));
    }

    #[test]
    fn safe_join_accepts_double_dot_inside_segment() {
        // `foo..bar` is one legitimate Normal component, not traversal.
        let root = Path::new("/sync/root");
        let joined = safe_join_under_root(root, "foo..bar").expect("dotted name is a normal segment");
        assert_eq!(joined, Path::new("/sync/root/foo..bar"));
    }

    #[test]
    fn safe_join_rejects_traversal_absolute_and_empty() {
        let root = Path::new("/sync/root");
        assert!(safe_join_under_root(root, "").is_none(), "empty");
        assert!(safe_join_under_root(root, "../escape").is_none(), "parent component");
        assert!(safe_join_under_root(root, "a/../../escape").is_none(), "embedded parent");
        assert!(safe_join_under_root(root, "/etc/passwd").is_none(), "absolute");
        assert!(safe_join_under_root(root, "./a").is_none(), "cur-dir component");
    }

    // ---- Pure emptiness guard ---------------------------------------------

    #[test]
    fn guard_true_for_empty_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("empty");
        std::fs::create_dir(&dir).unwrap();
        assert!(should_remove_orphan_dir(&dir));
    }

    #[test]
    fn guard_false_for_dir_with_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("hasfile");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("f.txt"), b"x").unwrap();
        assert!(!should_remove_orphan_dir(&dir));
    }

    #[test]
    fn guard_false_for_dir_with_subdir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("hassub");
        std::fs::create_dir_all(dir.join("child")).unwrap();
        assert!(!should_remove_orphan_dir(&dir));
    }

    #[test]
    fn guard_false_for_nonexistent_and_for_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(!should_remove_orphan_dir(&tmp.path().join("nope")), "nonexistent");
        let file = tmp.path().join("a_file");
        std::fs::write(&file, b"x").unwrap();
        assert!(!should_remove_orphan_dir(&file), "regular file is not a removable dir");
    }

    // ---- Apply against a real tempdir (hermetic, no network) ---------------

    #[test]
    fn apply_creates_missing_and_removes_empty_orphans() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        // Existing: an empty orphan `gone`, and a `keep` dir holding a file.
        std::fs::create_dir(root.join("gone")).unwrap();
        std::fs::create_dir(root.join("keep")).unwrap();
        std::fs::write(root.join("keep/f.txt"), b"x").unwrap();

        let plan = MaterializePlan {
            to_create: vec!["a".to_string(), "a/b".to_string()],
            to_remove: vec!["gone".to_string(), "keep".to_string()],
        };
        let (created, removed) = apply_materialize_plan(root, &plan);

        assert!(root.join("a/b").is_dir(), "nested create materialized");
        assert!(!root.join("gone").exists(), "empty orphan removed");
        assert!(root.join("keep").is_dir(), "non-empty dir preserved despite being in to_remove");
        assert!(root.join("keep/f.txt").exists(), "user file untouched");
        assert_eq!(created, 2);
        assert_eq!(removed, 1, "only the empty orphan counts as removed");
    }

    #[test]
    fn apply_removes_nested_empty_orphans_deepest_first() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        // Both `a` and `a/b` are server-absent empty orphans. Deepest-first
        // removal clears `a/b` then finds `a` empty and clears it in one pass.
        let plan = MaterializePlan {
            to_create: vec![],
            to_remove: vec!["a".to_string(), "a/b".to_string()],
        };
        let (_, removed) = apply_materialize_plan(root, &plan);
        assert!(!root.join("a").exists(), "both nested empties removed in one pass");
        assert_eq!(removed, 2);
    }

    #[test]
    fn apply_skips_create_when_a_file_occupies_the_name() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        std::fs::write(root.join("clash"), b"user file").unwrap();
        let plan = MaterializePlan {
            to_create: vec!["clash".to_string()],
            to_remove: vec![],
        };
        let (created, _) = apply_materialize_plan(root, &plan);
        assert_eq!(created, 0, "a file occupying the name blocks the create");
        assert!(root.join("clash").is_file(), "the user's file is left intact");
    }

    #[test]
    fn apply_skips_traversal_paths() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let plan = MaterializePlan {
            to_create: vec!["../escape".to_string()],
            to_remove: vec!["../../wipe".to_string()],
        };
        let (created, removed) = apply_materialize_plan(root, &plan);
        assert_eq!((created, removed), (0, 0), "traversal paths are skipped, nothing escapes root");
        assert!(!root.parent().unwrap().join("escape").exists());
    }

    /// Static wiring guard: the completion funnel must reference the combined
    /// folder-entity-sync spawn, so a refactor can't silently drop the per-cycle
    /// hook.
    #[test]
    fn handle_sync_completed_references_combined_spawn() {
        let bridge_src = include_str!("../projection/tauri_bridge.rs");
        assert!(
            bridge_src.contains("spawn_folder_entity_sync"),
            "handle_sync_completed must spawn the combined per-cycle folder-entity sync; the hook was dropped"
        );
    }

    // ---- Gate + DB-backed orchestration (real SQLite, no network) ----------

    const TEST_ACCOUNT: &str = "TEST_ACCOUNT_folder_entries_materialize_xxxxxxxx";

    async fn temp_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory:");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        pool
    }

    async fn insert_sync_path_for_account(pool: &SqlitePool, account_id: &str, label: &str, path: &str, backfilled: Option<i64>) {
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, folder_entries_backfilled_at)
             VALUES (?, ?, 'private', ?, ?, ?)",
        )
        .bind(account_key(account_id))
        .bind(path)
        .bind(label)
        .bind(0i64)
        .bind(backfilled)
        .execute(pool)
        .await
        .expect("insert sync_paths");
    }

    fn make_state(pool: SqlitePool) -> crate::app_state::AppState {
        let state = crate::app_state::AppState::new();
        state.set_pool(pool);
        state
    }

    /// The gate, via the combined runner: a drive whose
    /// `folder_entries_backfilled_at` is NULL must short-circuit to
    /// `NotBackfilledYet` and touch nothing — returns before any walk or network.
    #[tokio::test]
    async fn combined_sync_is_noop_until_backfilled() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = temp_pool().await;
        insert_sync_path_for_account(&pool, TEST_ACCOUNT, "docs", tmp.path().to_str().unwrap(), None).await;
        let state = make_state(pool.clone());

        let outcome = run_folder_entity_sync_for_drive(&state, TEST_ACCOUNT, "docs")
            .await
            .expect("gate path must not error");
        assert_eq!(outcome, FolderEntitySyncOutcome::NotBackfilledYet);
    }

    /// Once backfilled, a drive with no `sync_paths` row for the label is
    /// `NotReady` (removed mid-cycle), not an error — via both the combined
    /// runner and the standalone materialize wrapper.
    #[tokio::test]
    async fn combined_sync_not_ready_when_sync_root_absent() {
        let pool = temp_pool().await;
        insert_sync_path_for_account(&pool, TEST_ACCOUNT, "docs", "/no/such/hippius/materialize/root", Some(1)).await;
        let state = make_state(pool.clone());

        assert_eq!(
            run_folder_entity_sync_for_drive(&state, TEST_ACCOUNT, "docs").await.expect("combined not-ready must not error"),
            FolderEntitySyncOutcome::NotReady
        );
        assert_eq!(
            materialize_folder_entries_for_drive(&state, TEST_ACCOUNT, "docs").await.expect("standalone not-ready must not error"),
            MaterializeOutcome::NotReady
        );
    }

    /// Standalone wrapper gate parity: NULL flag → `NotBackfilledYet`.
    #[tokio::test]
    async fn materialize_wrapper_is_noop_until_backfilled() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = temp_pool().await;
        insert_sync_path_for_account(&pool, TEST_ACCOUNT, "docs", tmp.path().to_str().unwrap(), None).await;
        let state = make_state(pool.clone());

        let outcome = materialize_folder_entries_for_drive(&state, TEST_ACCOUNT, "docs")
            .await
            .expect("gate path must not error");
        assert_eq!(outcome, MaterializeOutcome::NotBackfilledYet);
    }

    proptest::proptest! {
        /// Applying the plan's create half to `disk` converges disk toward
        /// server, and re-deriving the create half on the converged disk is
        /// empty. NOTE: in production this plan is ALWAYS computed over the
        /// POST-reconcile server set — so "server-absent on disk" genuinely means
        /// "exists on another device," never "just deleted here" (which the
        /// reconcile has already pruned from the server set). The disjointness of
        /// the create/remove halves is also asserted.
        #[test]
        fn plan_create_half_converges_disk_to_server(
            server in proptest::collection::btree_set("[a-d]{1,3}", 0..6),
            disk in proptest::collection::btree_set("[a-d]{1,3}", 0..6),
            cache in proptest::collection::btree_set("[a-d]{1,3}", 0..6),
        ) {
            let plan = compute_materialize_plan(&server, &disk, &cache);
            // Disjointness: a path is never both created and removed.
            for c in &plan.to_create {
                proptest::prop_assert!(!plan.to_remove.contains(c));
            }
            // Apply the create half to a copy of disk; every server dir is now present.
            let mut converged = disk.clone();
            for c in &plan.to_create {
                converged.insert(c.clone());
            }
            for s in &server {
                proptest::prop_assert!(converged.contains(s));
            }
            // Re-deriving the create half on the converged disk is empty.
            let second = compute_materialize_plan(&server, &converged, &cache);
            proptest::prop_assert!(second.to_create.is_empty());
        }

        /// `should_remove_orphan_dir(d)` is `true` IFF `d` exists, is a
        /// directory, and is empty — proved over arbitrary tempdir contents.
        #[test]
        fn guard_true_iff_dir_exists_and_empty(
            make_dir in proptest::bool::ANY,
            child_files in proptest::collection::vec("[a-c]{1,3}", 0..4),
        ) {
            let tmp = tempfile::tempdir().expect("tempdir");
            let target = tmp.path().join("probe");
            let mut expected_empty = false;
            if make_dir {
                std::fs::create_dir(&target).unwrap();
                for name in &child_files {
                    // Same-named files collapse; the dir is empty IFF none were added.
                    let _ = std::fs::write(target.join(name), b"x");
                }
                expected_empty = child_files.is_empty();
            }
            proptest::prop_assert_eq!(should_remove_orphan_dir(&target), expected_empty);
        }

        /// `safe_join_under_root` never escapes the root: any path it accepts
        /// starts with the root.
        #[test]
        fn safe_join_stays_under_root(rel in "[a-z./]{0,12}") {
            let root = Path::new("/sync/root");
            if let Some(joined) = safe_join_under_root(root, &rel) {
                proptest::prop_assert!(joined.starts_with(root));
            }
        }
    }
}
