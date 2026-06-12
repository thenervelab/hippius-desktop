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

    let outcome = apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot).await.unwrap();

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

    let outcome = apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot).await.unwrap();

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
        async move { apply_init_commit(&lifecycle, &pool, ACCOUNT, "photos", snapshot).await }
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
