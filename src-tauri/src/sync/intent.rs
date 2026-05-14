//! Persistent upload-intent manifest for the sync widget.
//!
//! Backs the `sync_intent` table (declared in `utils/schema.rs`). The widget
//! used to lose progress after app restart because the only "what should be
//! synced" record was the in-memory snapshot. `IntentRepo` is the durable
//! shadow: the planner records intended uploads here, and later tasks mark
//! them complete, so post-restart `totals_for_drive` can answer "how much of
//! the plan have we actually finished?" without a fresh re-plan.
//!
//! This file lands the **read/append** half of the repo (Task 2):
//! `record_plan` upserts pending rows preserving original `added_at_ms`, and
//! `totals_for_drive` aggregates counts and bytes for one drive. Compaction,
//! completion, and clear/prune operations are added in Tasks 3 and 4.
//!
//! # Concurrency
//!
//! `IntentRepo` holds an `sqlx::SqlitePool` clone, which is `Send + Sync` and
//! reference-counted internally — instances can be cloned and shared freely
//! across tasks. All methods are `&self`; SQLite serializes writes inside the
//! pool, so callers don't need an external mutex.

use sqlx::sqlite::SqlitePool;

/// Repository handle backed by the `sync_intent` SQLite table.
///
/// Clone is cheap: the inner `SqlitePool` is `Arc`-backed by sqlx.
#[derive(Debug, Clone)]
pub struct IntentRepo {
    pool: SqlitePool,
}

/// Aggregate counts and byte sums for one drive's intent manifest.
///
/// `Copy` so call sites can pattern-match without consuming the value; later
/// tasks compare snapshots of totals to detect changes worth emitting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntentTotals {
    /// Total number of rows in the manifest for this drive (pending +
    /// completed).
    pub total_files: u64,
    /// Sum of `size_bytes` across all rows for this drive.
    pub total_bytes: u64,
    /// Rows with `completed_at_ms IS NOT NULL`.
    pub completed_files: u64,
    /// Sum of `size_bytes` across completed rows only.
    pub completed_bytes: u64,
}

/// Errors raised by `IntentRepo`.
///
/// # Stability
///
/// `Db` is a stable contract — callers may match on it. The enum is
/// `#[non_exhaustive]` because later tasks add variants (e.g. clock-skew
/// failure modes for `mark_completed`); new variants may be added in any
/// minor release.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum IntentError {
    /// SQLite I/O failure surfaced via sqlx.
    #[error("intent db error: {0}")]
    Db(#[from] sqlx::Error),
}

impl IntentRepo {
    /// Construct a new repo from a shared pool. Cloning the pool is cheap;
    /// callers typically build one `IntentRepo` per drive event handler.
    #[must_use]
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Upsert pending intent rows for the files the planner reports as
    /// pending uploads.
    ///
    /// **Semantics on conflict.** When a row already exists for
    /// `(account_id, drive_label, relative_path)`, only `size_bytes` is
    /// refreshed (the file may have grown between plan cycles). The original
    /// `added_at_ms` is preserved so the manifest remains a durable
    /// "since-when" record, and `completed_at_ms` is left untouched so an
    /// already-completed row is NOT reverted to pending. The latter matters
    /// because the planner's view of "still needs uploading" can disagree
    /// briefly with the file-synced callback during sync teardown — Task 3
    /// handles the explicit "no longer in plan" compaction.
    ///
    /// **Empty input.** An empty `plan_uploads` slice returns `Ok(())`
    /// without touching the database — the caller's planner can be wired
    /// unconditionally without a guard.
    ///
    /// `added_at_ms` for new rows is computed inside SQLite via
    /// `CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)`, which
    /// yields **true millisecond-granularity** Unix time. The earlier
    /// `strftime('%s','now') * 1000` form rendered as the column's `_ms`
    /// suffix promised but only delivered second precision (always `…000`);
    /// the julianday math fixes that contract mismatch and avoids any
    /// `unixepoch('now','subsec')` version dependency (julianday has been
    /// in SQLite since 3.0; subsec arrived in 3.42). The value is monotonic
    /// with the transaction commit order on the DB connection and immune
    /// to client clock skew between the caller and SQLite.
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] if any SQLite operation fails (including
    /// transaction commit). On failure the transaction is rolled back —
    /// either no rows or all rows for this call are visible.
    pub async fn record_plan(
        &self,
        account_id: &str,
        drive_label: &str,
        plan_uploads: &[(String, u64)],
    ) -> Result<(), IntentError> {
        // Short-circuit so the caller can invoke this unconditionally without
        // paying for a transaction round-trip when the plan is empty.
        if plan_uploads.is_empty() {
            return Ok(());
        }

        let mut tx = self.pool.begin().await?;

        // One INSERT per row, all inside the same transaction so partial
        // failures don't leave the manifest half-written. `excluded` in
        // SQLite refers to the row that would have been inserted; we
        // deliberately reference ONLY `excluded.size_bytes` so `added_at_ms`
        // (and `completed_at_ms`) keep their existing values on conflict.
        //
        // `added_at_ms` uses `julianday('now')` rather than `strftime('%s')`
        // because the latter is second-granular and would render the `_ms`
        // suffix a lie — every value would end in `000`. 2440587.5 is the
        // Julian Day Number of the Unix epoch (1970-01-01 00:00:00 UTC);
        // multiplying the fractional-day difference by 86_400_000 ms/day
        // yields exact Unix time in milliseconds. The CAST truncates the
        // sub-millisecond remainder to a SQLite INTEGER (i64). Source:
        // https://www.sqlite.org/lang_datefunc.html — julianday returns a
        // REAL (IEEE-754 f64), valid range 4714-11-24 BCE … 9999-12-31.
        for (rel_path, size_bytes) in plan_uploads {
            sqlx::query(
                "INSERT INTO sync_intent
                    (account_id, drive_label, relative_path, size_bytes, added_at_ms, completed_at_ms)
                 VALUES (?, ?, ?, ?, CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER), NULL)
                 ON CONFLICT(account_id, drive_label, relative_path)
                 DO UPDATE SET size_bytes = excluded.size_bytes",
            )
            .bind(account_id)
            .bind(drive_label)
            .bind(rel_path)
            // SQLite INTEGER is i64; file sizes ≪ 2^63 in practice.
            .bind(*size_bytes as i64)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    /// Aggregate counts and byte sums for one `(account_id, drive_label)`
    /// pair. Returns zeros for a drive with no rows.
    ///
    /// **SQLite `SUM` edge case.** `SUM` over zero matching rows returns
    /// SQL NULL, not 0. The query wraps both byte sums in `COALESCE(..., 0)`
    /// so the binding to `i64` can never fail with "unexpected NULL".
    /// Source: https://www.sqlite.org/lang_aggfunc.html#sumunc — "If there
    /// are no non-NULL input rows then sum() returns NULL".
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] on SQLite I/O failure.
    pub async fn totals_for_drive(
        &self,
        account_id: &str,
        drive_label: &str,
    ) -> Result<IntentTotals, IntentError> {
        // Each aggregate runs in a single index scan over
        // (account_id, drive_label, completed_at_ms) — the covering index
        // declared alongside the table.
        let row: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT
                COUNT(*)                                                                AS total_files,
                COALESCE(SUM(size_bytes), 0)                                            AS total_bytes,
                COUNT(CASE WHEN completed_at_ms IS NOT NULL THEN 1 END)                 AS completed_files,
                COALESCE(SUM(CASE WHEN completed_at_ms IS NOT NULL THEN size_bytes END), 0) AS completed_bytes
             FROM sync_intent
             WHERE account_id = ? AND drive_label = ?",
        )
        .bind(account_id)
        .bind(drive_label)
        .fetch_one(&self.pool)
        .await?;

        // SQLite INTEGER columns return as i64; the queries above can never
        // produce a negative result (COUNT is non-negative, SUM of u64-sourced
        // values is non-negative, COALESCE protects NULL → 0), so the
        // i64 → u64 cast is always lossless here.
        Ok(IntentTotals {
            total_files: row.0 as u64,
            total_bytes: row.1 as u64,
            completed_files: row.2 as u64,
            completed_bytes: row.3 as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Build a fresh in-memory pool with `ensure_table_schema` applied.
    ///
    /// `max_connections(1)` is critical: SQLite `:memory:` databases are
    /// per-connection (each new connection sees a different empty DB), so a
    /// multi-connection pool would route different queries to different DBs.
    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        crate::utils::schema::ensure_table_schema(&pool)
            .await
            .expect("ensure_table_schema");
        pool
    }

    #[tokio::test]
    async fn record_plan_inserts_pending_rows_with_correct_totals() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);

        repo.record_plan(
            "acct",
            "drive",
            &[("a.txt".to_string(), 100), ("b.txt".to_string(), 200)],
        )
        .await
        .unwrap();

        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.total_files, 2);
        assert_eq!(totals.total_bytes, 300);
        assert_eq!(totals.completed_files, 0);
        assert_eq!(totals.completed_bytes, 0);
    }

    #[tokio::test]
    async fn record_plan_preserves_added_at_on_conflict() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool.clone());

        repo.record_plan("acct", "drive", &[("a.txt".to_string(), 100)])
            .await
            .unwrap();
        let row1: (i64, i64) = sqlx::query_as(
            "SELECT added_at_ms, size_bytes FROM sync_intent WHERE relative_path = 'a.txt'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        // Cross a millisecond boundary so a re-derived "now" would differ
        // if the column ever lost added_at_ms-preservation. With the
        // julianday-based ms-precision timestamp, 10ms is plenty — the
        // previous 1.1s wait was a tax forced by the old second-granular
        // strftime('%s') value.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Same path, different size (file grew). added_at_ms must NOT
        // change; only size_bytes is in the DO UPDATE clause.
        repo.record_plan("acct", "drive", &[("a.txt".to_string(), 150)])
            .await
            .unwrap();
        let row2: (i64, i64) = sqlx::query_as(
            "SELECT added_at_ms, size_bytes FROM sync_intent WHERE relative_path = 'a.txt'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(row1.0, row2.0, "added_at_ms must be preserved on conflict");
        assert_eq!(row2.1, 150, "size_bytes must be refreshed");
    }

    #[tokio::test]
    async fn record_plan_writes_millisecond_precision_timestamp() {
        // Regression: the SQL must use julianday-based ms math, not
        // strftime('%s') * 1000. If someone reverts to seconds, every
        // added_at_ms ends in `000` and this test will fail with
        // overwhelming probability — the modulo-1000 result is uniform
        // over 0..=999 for julianday('now'), so a single sample lands
        // on a `…000` boundary only ~0.1% of the time. We collect a
        // handful of samples spaced by short sleeps and require at
        // least one non-zero remainder, eliminating the residual flake.
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool.clone());

        let mut saw_subsecond = false;
        for i in 0..8u32 {
            // Distinct paths per iteration so each INSERT takes the
            // VALUES branch (not the conflict path) and writes a fresh
            // added_at_ms. Sleeping ~3ms between samples spreads the
            // captures across multiple millisecond ticks.
            let path = format!("f{i}.txt");
            repo.record_plan("acct", "drive", &[(path.clone(), 1)])
                .await
                .unwrap();
            let row: (i64,) = sqlx::query_as(
                "SELECT added_at_ms FROM sync_intent WHERE relative_path = ?",
            )
            .bind(&path)
            .fetch_one(&pool)
            .await
            .unwrap();
            if row.0 % 1000 != 0 {
                saw_subsecond = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(3)).await;
        }
        assert!(
            saw_subsecond,
            "added_at_ms is still second-granular (all 8 samples ended in …000); \
             the SQL likely reverted to strftime('%s') * 1000"
        );
    }

    #[tokio::test]
    async fn record_plan_empty_input_is_noop() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct", "drive", &[]).await.unwrap();
        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.total_files, 0);
        assert_eq!(totals.total_bytes, 0);
    }

    #[tokio::test]
    async fn totals_for_drive_empty_returns_zeros() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(
            totals,
            IntentTotals {
                total_files: 0,
                total_bytes: 0,
                completed_files: 0,
                completed_bytes: 0,
            }
        );
    }

    #[tokio::test]
    async fn record_plan_scopes_by_account_and_drive() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct1", "drive_a", &[("a.txt".into(), 100)]).await.unwrap();
        repo.record_plan("acct1", "drive_b", &[("b.txt".into(), 200)]).await.unwrap();
        repo.record_plan("acct2", "drive_a", &[("c.txt".into(), 300)]).await.unwrap();

        let t1a = repo.totals_for_drive("acct1", "drive_a").await.unwrap();
        let t1b = repo.totals_for_drive("acct1", "drive_b").await.unwrap();
        let t2a = repo.totals_for_drive("acct2", "drive_a").await.unwrap();

        assert_eq!(t1a.total_bytes, 100);
        assert_eq!(t1b.total_bytes, 200);
        assert_eq!(t2a.total_bytes, 300);
    }
}
