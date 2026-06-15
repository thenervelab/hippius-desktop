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

/// Pins the contract `build_file_synced_callback` relies on (Task 6
/// wiring): calling `mark_completed` after `record_plan` flips the
/// matching row to completed in the per-drive totals, and a second fire
/// is a no-op so a hcfs-client retry of the per-file callback cannot
/// double-count bytes.
///
/// The closure itself can't be exercised end-to-end here — the spawn
/// inside `build_file_synced_callback` resolves `tauri::State<AppState>`
/// at runtime, which only the real Tauri AppHandle has. What this test
/// guards against is the case where a refactor of `IntentRepo`'s public
/// API silently breaks the closure's call site (it still compiles but
/// stops moving totals).
#[tokio::test]
async fn mark_completed_after_record_plan_updates_totals_idempotently() {
    let pool = fresh_pool().await;
    let repo = IntentRepo::new(pool);

    repo.record_plan("acct", "default", &[("photos/img1.jpg".into(), 4_000_000)])
        .await
        .expect("record_plan failed");
    let before = repo.totals_for_drive("acct", "default").await.expect("totals before");
    assert_eq!(before.completed_files, 0, "no rows completed yet");
    assert_eq!(before.completed_bytes, 0, "no bytes completed yet");

    // First completion: row flips, totals advance.
    repo.mark_completed("acct", "default", "photos/img1.jpg", 1_000_000)
        .await
        .expect("mark_completed first call failed");
    let after_first = repo.totals_for_drive("acct", "default").await.expect("totals after first mark");
    assert_eq!(after_first.completed_files, 1, "one file completed");
    // Completed bytes counts the FULL file size, not the mark timestamp.
    assert_eq!(after_first.completed_bytes, 4_000_000, "completed bytes match plan size");

    // Second completion (e.g. hcfs-client retry after a transient widget
    // event drop). The `AND completed_at_ms IS NULL` guard inside
    // `mark_completed` enforces first-write-wins at the SQL layer, so
    // the totals must not move.
    repo.mark_completed("acct", "default", "photos/img1.jpg", 2_000_000)
        .await
        .expect("mark_completed second call failed");
    let after_second = repo.totals_for_drive("acct", "default").await.expect("totals after second mark");
    assert_eq!(after_second.completed_files, 1, "still exactly one file completed");
    assert_eq!(after_second.completed_bytes, 4_000_000, "completed bytes unchanged on duplicate callback");
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
    let initial: Vec<(String, u64)> = vec![("a.txt".to_string(), 100), ("b.txt".to_string(), 200)];
    repo.record_plan("acct", "drive", &initial).await.expect("seed record_plan failed");

    let seeded: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sync_intent")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(seeded, 2, "seed should have inserted 2 rows");

    // Empty plan — must compact every pending row for (acct, drive).
    repo.record_plan("acct", "drive", &[]).await.expect("empty record_plan failed");

    let after: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sync_intent")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(after, 0, "empty plan should have compacted all pending rows");
}

/// Pins the contract that `tauri_bridge::build_intent_overlay` depends on:
/// a single account-scoped aggregate query that sums totals across every
/// drive the user has. The snapshot overlay shows ONE pair of "X of Y"
/// numbers (global per account), not per-drive, so the bridge needs an
/// aggregate primitive — issuing N `totals_for_drive` calls per emit would
/// be N round-trips against SQLite on a hot path that fires at up to 4 Hz.
///
/// What this test fixes in place:
///   - The cross-drive SUM/COUNT semantics (totals across drives roll up).
///   - The account scoping (one account's rows never see another's).
///   - The completed vs. total split is preserved per the same COALESCE
///     pattern as `totals_for_drive`.
#[tokio::test]
async fn totals_for_account_sums_across_drives() {
    let pool = fresh_pool().await;
    let repo = IntentRepo::new(pool);

    repo.record_plan("acct", "drive_a", &[("a.txt".into(), 100), ("b.txt".into(), 200)])
        .await
        .expect("record_plan drive_a");
    repo.record_plan("acct", "drive_b", &[("c.txt".into(), 300)])
        .await
        .expect("record_plan drive_b");
    // Mark only a.txt complete; drive_a still has b.txt pending and
    // drive_b's c.txt is pending. Totals across the account should be
    // 3 files / 600 bytes total, 1 file / 100 bytes completed.
    repo.mark_completed("acct", "drive_a", "a.txt", 1_000)
        .await
        .expect("mark_completed a.txt");
    // A different account shares the SQLite file. Its rows must NEVER
    // bleed into "acct"'s totals.
    repo.record_plan("other_acct", "drive_a", &[("d.txt".into(), 999)])
        .await
        .expect("record_plan other_acct");

    let totals = repo.totals_for_account("acct").await.expect("totals_for_account acct");
    assert_eq!(totals.total_files, 3, "a + b + c across drive_a + drive_b");
    assert_eq!(totals.total_bytes, 600, "100 + 200 + 300");
    assert_eq!(totals.completed_files, 1, "only a.txt is completed");
    assert_eq!(totals.completed_bytes, 100, "a.txt's size only");

    let other = repo.totals_for_account("other_acct").await.expect("totals_for_account other_acct");
    assert_eq!(other.total_files, 1, "other account is isolated");
    assert_eq!(other.total_bytes, 999);

    let absent = repo.totals_for_account("missing_acct").await.expect("totals_for_account missing_acct");
    assert_eq!(
        absent,
        tauri_project_lib::sync::intent::IntentTotals {
            total_files: 0,
            total_bytes: 0,
            completed_files: 0,
            completed_bytes: 0,
        },
        "unknown account returns zeros (COALESCE handles SQLite SUM-of-empty NULL)"
    );
}

/// Pins the `IntentRepo::clear_drive` contract that `remove_drive` in
/// `src-tauri/src/sync/lifecycle.rs` wires into. Three invariants matter:
///
///   1. Both pending AND completed rows for the target `(account, drive)`
///      pair are removed — a stale completed row would otherwise leak into
///      "X of Y" totals for a future drive of the same label.
///   2. Other drives on the SAME account survive untouched — a user with
///      multiple sync folders must not lose progress on `drive_b` because
///      they removed `drive_a`.
///   3. The same `drive_label` on a DIFFERENT account survives untouched —
///      account scoping is enforced by the WHERE clause, not by the caller.
///
/// We can't drive `remove_drive` end-to-end from a cargo-test integration
/// test: it needs a live Tauri runtime + `AppState`-managed `SqlitePool`.
/// The full flow is exercised by the manual smoke test in task 11. What
/// this test guards against is a silent refactor of `clear_drive`'s scoping
/// (e.g. dropping the `drive_label = ?` predicate) that would still compile
/// at the wiring site but corrupt user data.
#[tokio::test]
async fn clear_drive_via_repo_drops_intent_rows_for_target_drive_only() {
    let pool = fresh_pool().await;
    let repo = IntentRepo::new(pool);

    // Two drives on the same account, one of which (drive_a) has both a
    // pending and a completed row — clear_drive must wipe both halves.
    repo.record_plan("acct", "drive_a", &[("a.txt".into(), 100)])
        .await
        .expect("record_plan acct/drive_a");
    repo.record_plan("acct", "drive_b", &[("b.txt".into(), 200)])
        .await
        .expect("record_plan acct/drive_b");
    repo.mark_completed("acct", "drive_a", "a.txt", 1_000)
        .await
        .expect("mark_completed acct/drive_a/a.txt");
    // Different account, same drive label — must survive (account scoping).
    repo.record_plan("other_acct", "drive_a", &[("c.txt".into(), 999)])
        .await
        .expect("record_plan other_acct/drive_a");

    repo.clear_drive("acct", "drive_a").await.expect("clear_drive acct/drive_a");

    // Invariant 1: drive_a on `acct` wiped (both pending and completed
    // halves gone). `total_files == 0` proves the DELETE didn't skip
    // either kind.
    let ta = repo.totals_for_drive("acct", "drive_a").await.expect("totals acct/drive_a");
    assert_eq!(ta.total_files, 0, "drive_a wiped: no rows remain");
    assert_eq!(ta.completed_files, 0, "drive_a wiped: completed gone");

    // Invariant 2: drive_b on the SAME account is untouched.
    let tb = repo.totals_for_drive("acct", "drive_b").await.expect("totals acct/drive_b");
    assert_eq!(tb.total_files, 1, "drive_b on same account preserved");
    assert_eq!(tb.total_bytes, 200, "drive_b bytes preserved");

    // Invariant 3: same drive_label under a different account is untouched.
    let other = repo.totals_for_drive("other_acct", "drive_a").await.expect("totals other_acct/drive_a");
    assert_eq!(other.total_files, 1, "other_acct's drive_a is isolated");
    assert_eq!(other.total_bytes, 999);
}

/// Pins the `IntentRepo::clear_account` contract that `logout_full` in
/// `src-tauri/src/auth/logout.rs` wires into as its step 4. The widget's
/// "X of Y" overlay is the only consumer of intent rows, so on full
/// logout we must drop every row for the account across ALL drives —
/// otherwise the next user logging in on the same machine inherits the
/// previous account's totals. Three invariants matter:
///
///   1. Every drive for the target account is wiped (both pending AND
///      completed halves) — verified by asserting `total_files == 0` for
///      two different drive labels on the same account.
///   2. Other accounts sharing the SQLite file are untouched — account
///      scoping is enforced by the SQL WHERE clause in `clear_account`,
///      not by the caller.
///   3. Mixed pending/completed state is fully cleared — a stale
///      completed row would otherwise inflate next-session totals.
///
/// The full `logout_full` flow can't be exercised from cargo-test (it
/// needs the Tauri runtime + managed AppState); the end-to-end check
/// is the manual smoke test in task 11. What this test guards against
/// is a refactor of `clear_account` that drops the account scope (e.g.
/// switches to unconditional `DELETE FROM sync_intent`) — the wiring
/// at the logout site still compiles but silently corrupts other
/// accounts' widget state.
#[tokio::test]
async fn clear_account_via_repo_drops_all_intent_for_account_preserving_others() {
    let pool = fresh_pool().await;
    let repo = IntentRepo::new(pool);

    repo.record_plan("victim_acct", "drive_a", &[("a.txt".into(), 100), ("b.txt".into(), 200)])
        .await
        .expect("record_plan victim_acct/drive_a");
    repo.record_plan("victim_acct", "drive_b", &[("c.txt".into(), 300)])
        .await
        .expect("record_plan victim_acct/drive_b");
    // Mix completed + pending state so the assertion also pins that
    // clear_account drops BOTH halves, not just pending rows.
    repo.mark_completed("victim_acct", "drive_a", "a.txt", 1_000)
        .await
        .expect("mark_completed victim_acct/drive_a/a.txt");
    repo.record_plan("other_acct", "drive_a", &[("z.txt".into(), 999)])
        .await
        .expect("record_plan other_acct/drive_a");

    repo.clear_account("victim_acct").await.expect("clear_account victim_acct");

    // Invariant 1: every drive for victim_acct is empty (drive_a had
    // both a completed and a pending row; drive_b had a pending row).
    let ta = repo.totals_for_drive("victim_acct", "drive_a").await.expect("totals victim_acct/drive_a");
    let tb = repo.totals_for_drive("victim_acct", "drive_b").await.expect("totals victim_acct/drive_b");
    assert_eq!(ta.total_files, 0, "drive_a wiped across pending + completed");
    assert_eq!(tb.total_files, 0, "drive_b wiped");

    // Invariant 2: other_acct's rows are untouched — account scoping
    // holds even when the two accounts share a drive label.
    let other = repo.totals_for_drive("other_acct", "drive_a").await.expect("totals other_acct/drive_a");
    assert_eq!(other.total_files, 1, "other_acct survives victim_acct clear");
    assert_eq!(other.total_bytes, 999, "other_acct bytes preserved");
}
