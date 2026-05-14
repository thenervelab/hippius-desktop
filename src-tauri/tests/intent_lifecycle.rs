//! Integration test that exercises the wiring between hcfs-client's
//! plan-ready callback and the desktop's `IntentRepo`.
//!
//! This file pins the contract that `build_plan_ready_callback` in
//! `src-tauri/src/sync/lifecycle.rs` relies on: calling
//! `IntentRepo::record_plan(account, drive, &[(path, size), ...])` with the
//! exact shape produced by mapping over `Vec<SyncPlanFile>` results in rows
//! landing in `sync_intent`. The closure itself can't be unit-tested without
//! a full Tauri `AppHandle` (the spawned task fetches `tauri::State<AppState>`
//! at runtime); the end-to-end wiring is covered by the smoke test in
//! Task 11 of the plan.
//!
//! What this test guards against: a future refactor of `record_plan`'s
//! signature or persistence behavior that the closure's call site would
//! silently keep compiling against (e.g. signature still typechecks but no
//! rows land).

use sqlx::Row;
use sqlx::sqlite::SqlitePoolOptions;

use tauri_project_lib::sync::intent::IntentRepo;
use tauri_project_lib::utils::schema::ensure_table_schema;

/// Build a fresh in-memory SQLite pool with the project schema applied.
///
/// In-memory dbs are scoped to a single connection — `max_connections: 1`
/// ensures every query in the test sees the same database. The schema is
/// installed via the public `ensure_table_schema` entry point (the same one
/// production uses at app startup), so the test exercises the actual table
/// shape rather than a hand-rolled fixture that could drift.
async fn fresh_pool() -> sqlx::sqlite::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("open in-memory db");
    ensure_table_schema(&pool).await.expect("ensure_table_schema");
    pool
}

/// Calling `record_plan` with a planner-shaped payload must persist one
/// `sync_intent` row per upload, with `size_bytes` matching the plan.
///
/// This is the load-bearing contract the spawn inside
/// `build_plan_ready_callback` depends on: it maps `SyncPlanFile { path,
/// size_bytes }` into `(String, u64)` and hands the slice to `record_plan`.
/// If that contract changes, the wiring is silently broken even though it
/// still compiles.
#[tokio::test]
async fn record_plan_with_planner_style_payload_persists_rows() {
    let pool = fresh_pool().await;
    let repo = IntentRepo::new(pool.clone());

    // Three uploads of varying sizes, the same shape the callback produces
    // from `uploads.iter().map(|f| (f.path.clone(), f.size_bytes)).collect()`.
    let planner_uploads: Vec<(String, u64)> = vec![
        ("photos/img1.jpg".to_string(), 4_000_000),
        ("docs/spec.pdf".to_string(), 250_000),
        ("notes.txt".to_string(), 1_024),
    ];

    repo.record_plan("test_account", "default", &planner_uploads)
        .await
        .expect("record_plan failed");

    let row_count: i64 = sqlx::query(
        "SELECT COUNT(*) AS n FROM sync_intent \
         WHERE account_id = 'test_account' AND drive_label = 'default'",
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .get("n");
    assert_eq!(row_count, 3, "expected 3 pending rows, got {row_count}");

    let total_bytes: i64 = sqlx::query(
        "SELECT COALESCE(SUM(size_bytes), 0) AS s FROM sync_intent \
         WHERE account_id = 'test_account' AND drive_label = 'default'",
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .get("s");
    assert_eq!(total_bytes, 4_251_024, "size_bytes sum mismatch");
}

/// Calling `record_plan` with an empty plan must compact every pending row
/// for the (account, drive) pair.
///
/// This pins the "compaction runs even on empty input" semantic that the
/// callback wiring relies on: the spawn happens BEFORE the `total == 0`
/// early-return so the user case "I deleted all the files mid-sync" still
/// flushes the manifest. If `record_plan` ever grew an empty-input
/// short-circuit, the widget would be stuck showing stale totals.
#[tokio::test]
async fn record_plan_with_empty_uploads_compacts_pending_rows() {
    let pool = fresh_pool().await;
    let repo = IntentRepo::new(pool.clone());

    // Seed: two pending uploads.
    let initial: Vec<(String, u64)> = vec![
        ("a.txt".to_string(), 100),
        ("b.txt".to_string(), 200),
    ];
    repo.record_plan("acct", "drive", &initial)
        .await
        .expect("seed record_plan failed");

    let seeded: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sync_intent")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(seeded, 2, "seed should have inserted 2 rows");

    // Empty plan — must compact every pending row for (acct, drive).
    repo.record_plan("acct", "drive", &[])
        .await
        .expect("empty record_plan failed");

    let after: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sync_intent")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(after, 0, "empty plan should have compacted all pending rows");
}
