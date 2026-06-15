//! Integration tests for `apply_init_commit` — the atomic epoch-checked
//! commit step of the drive-lifecycle single-writer protocol.
//!
//! These exercise the production `apply_init_commit` + `DriveLifecycle`
//! against a real in-memory SQLite pool (no hand-rolled mirrors). What
//! we verify:
//!
//! 1. **Happy path** — an init whose snapshot is still current clears
//!    `sync_paths.is_paused` and reports `Committed`.
//! 2. **Stale snapshot yields** — a pause that bumped the epoch
//!    mid-init wins: the commit reports `Superseded` and the pause's
//!    `is_paused=1` is never overwritten.
//! 3. **Lock serialization** — a commit attempted while another actor
//!    holds the label's commit lock genuinely blocks until release,
//!    and a pause performed under that lock still wins afterwards.

use std::sync::Arc;
use std::time::Duration;

use sqlx::sqlite::SqlitePool;

use tauri_project_lib::sync::lifecycle_guard::{apply_init_commit, CommitOutcome, DriveLifecycle};

/// Build an in-memory pool with the minimum schema these tests touch:
/// just `sync_paths` plus the unique constraint that production uses.
async fn make_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");

    sqlx::query(
        "CREATE TABLE sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL,
            is_paused INTEGER NOT NULL DEFAULT 0,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

/// Mirrors `account_key()` from `auth/account_key.rs`: the owner column
/// is the hex-encoded first 8 bytes of the SHA-256 of the raw account
/// id. Seeding rows with the same key the production UPDATE targets is
/// what proves `apply_init_commit` may be handed the RAW account id
/// (`set_sync_path_paused` hashes internally).
fn account_key(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

async fn insert_path(pool: &SqlitePool, account_id: &str, label: &str, paused: bool) {
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, is_paused) VALUES (?, ?, 'private', ?, ?)")
        .bind(account_key(account_id))
        .bind(format!("/tmp/{label}"))
        .bind(label)
        .bind(i32::from(paused))
        .execute(pool)
        .await
        .unwrap();
}

/// Read back the row's `is_paused` flag — the single bit the whole
/// protocol exists to protect.
async fn is_paused(pool: &SqlitePool, account_id: &str, label: &str) -> bool {
    let val: i64 = sqlx::query_scalar("SELECT is_paused FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(account_key(account_id))
        .bind(label)
        .fetch_one(pool)
        .await
        .expect("row exists");
    val != 0
}

const ACCOUNT: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

#[tokio::test]
async fn commit_clears_flag_when_epoch_unchanged() {
    let pool = make_pool().await;
    insert_path(&pool, ACCOUNT, "photos", true).await;

    let lifecycle = DriveLifecycle::default();
    let snapshot = lifecycle.snapshot("photos");

    let outcome = apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot, || {}).await.unwrap();

    assert_eq!(outcome, CommitOutcome::Committed);
    assert!(!is_paused(&pool, ACCOUNT, "photos").await, "commit must clear is_paused");
}

#[tokio::test]
async fn commit_yields_when_pause_intervened() {
    let pool = make_pool().await;
    insert_path(&pool, ACCOUNT, "photos", false).await;

    let lifecycle = DriveLifecycle::default();
    let snapshot = lifecycle.snapshot("photos");

    // Simulate a pause landing mid-init: bump the epoch, then write the
    // pause's flag (direct UPDATE — the pause-side command isn't wired
    // through the guard yet; Task 2.4 does that).
    lifecycle.bump("photos");
    sqlx::query("UPDATE sync_paths SET is_paused = 1 WHERE owner = ? AND label = ?")
        .bind(account_key(ACCOUNT))
        .bind("photos")
        .execute(&pool)
        .await
        .unwrap();

    let outcome = apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot, || {}).await.unwrap();

    assert_eq!(outcome, CommitOutcome::Superseded);
    assert!(is_paused(&pool, ACCOUNT, "photos").await, "stale init must never overwrite the pause's is_paused=1");
}

/// Deterministic contention: the test plays the pause side by taking the
/// label's commit lock FIRST, then spawns `apply_init_commit` with a
/// soon-to-be-stale snapshot. The commit must genuinely block on the
/// lock (probed with a bounded timeout — the timeout is a "did not
/// finish yet" check, not a synchronization mechanism), and after the
/// pause bumps + writes under the lock and releases it, the commit must
/// observe the bump and yield.
#[tokio::test]
async fn concurrent_pause_and_commit_serialize_on_the_lock() {
    let pool = make_pool().await;
    insert_path(&pool, ACCOUNT, "photos", false).await;

    let lifecycle = Arc::new(DriveLifecycle::default());
    let snapshot = lifecycle.snapshot("photos");

    // Pause side: acquire the commit lock before the init's commit runs.
    let lock = lifecycle.commit_lock("photos");
    let guard = lock.lock().await;

    let mut commit_task = tokio::spawn({
        let lifecycle = Arc::clone(&lifecycle);
        let pool = pool.clone();
        async move { apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot, || {}).await }
    });

    // While the lock is held the commit must be pending. `&mut JoinHandle`
    // keeps the handle alive on timeout so we can await it again below.
    let probe = tokio::time::timeout(Duration::from_millis(100), &mut commit_task).await;
    assert!(probe.is_err(), "apply_init_commit must not complete while the commit lock is held");

    // Still under the lock: the pause supersedes the init and records it.
    lifecycle.bump("photos");
    sqlx::query("UPDATE sync_paths SET is_paused = 1 WHERE owner = ? AND label = ?")
        .bind(account_key(ACCOUNT))
        .bind("photos")
        .execute(&pool)
        .await
        .unwrap();

    drop(guard);

    let outcome = commit_task.await.expect("commit task panicked").expect("commit errored");
    assert_eq!(outcome, CommitOutcome::Superseded);
    assert!(is_paused(&pool, ACCOUNT, "photos").await, "pause must win regardless of interleaving order");
}

/// Err path: when the `is_paused` UPDATE itself fails (here: the
/// `sync_paths` table doesn't exist at all), `apply_init_commit` must
/// surface the DB error — and, critically, must RELEASE the label's
/// commit lock on the way out. A lock leaked on the error path would
/// deadlock every subsequent pause/resume/init for that label forever.
#[tokio::test]
async fn commit_db_error_propagates_and_releases_the_lock() {
    // Deliberately no CREATE TABLE: the commit's UPDATE has nothing to
    // run against and fails inside SQLite, exercising the `?` path.
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");

    let lifecycle = DriveLifecycle::default();
    let snapshot = lifecycle.snapshot("photos");

    let result = apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot, || {}).await;
    assert!(result.is_err(), "missing sync_paths table must surface as Err, got {result:?}");

    // The guard is lexically scoped inside apply_init_commit, so `?`
    // drops it — but pin that contract: the lock must be free again.
    let lock = lifecycle.commit_lock("photos");
    assert!(lock.try_lock().is_ok(), "commit lock must be released after an Err return");
}

/// The post-commit hook is the caller's status-emit slot. It must run
/// (a) ONLY when the commit actually lands — a superseded init must
/// emit nothing, the superseder already emitted its own status — and
/// (b) while the label's commit lock is STILL HELD, so the init's
/// Active emit is totally ordered with the superseding producers'
/// locked Paused/removed emits. Without (b), a pause running entirely
/// between the commit and an unlocked emit would have its Paused emit
/// overwritten by the stale Active one, and the status cache (which
/// wins over the DB on FE bootstrap) would show Active for a paused
/// drive for the rest of the session.
#[tokio::test]
async fn committed_hook_runs_under_the_lock_and_only_on_commit() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let pool = make_pool().await;
    insert_path(&pool, ACCOUNT, "photos", true).await;

    let lifecycle = DriveLifecycle::default();

    // (a) Superseded: the hook must NOT run.
    let snapshot = lifecycle.snapshot("photos");
    lifecycle.bump("photos");
    let hook_ran = AtomicBool::new(false);
    let outcome = apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot, || {
        hook_ran.store(true, Ordering::SeqCst);
    })
    .await
    .unwrap();
    assert_eq!(outcome, CommitOutcome::Superseded);
    assert!(!hook_ran.load(Ordering::SeqCst), "a superseded init must not run its status-emit hook");

    // (b) Committed: the hook runs, and runs under the lock — proven by
    // try_lock on the same label's commit lock FAILING inside the hook
    // (apply_init_commit's own guard is still alive at that point).
    let snapshot = lifecycle.snapshot("photos");
    let hook_ran = AtomicBool::new(false);
    let lifecycle_ref = &lifecycle;
    let outcome = apply_init_commit(lifecycle_ref, &pool, ACCOUNT, "photos", snapshot, || {
        let lock = lifecycle_ref.commit_lock("photos");
        assert!(lock.try_lock().is_err(), "hook must run while the commit lock is held");
        hook_ran.store(true, Ordering::SeqCst);
    })
    .await
    .unwrap();
    assert_eq!(outcome, CommitOutcome::Committed);
    assert!(hook_ran.load(Ordering::SeqCst), "a committed init must run its status-emit hook");
}
