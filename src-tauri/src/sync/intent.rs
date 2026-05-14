//! Persistent upload-intent manifest for the sync widget.
//!
//! Backs the `sync_intent` table (declared in `utils/schema.rs`). The widget
//! used to lose progress after app restart because the only "what should be
//! synced" record was the in-memory snapshot. `IntentRepo` is the durable
//! shadow: the planner records intended uploads here, and later tasks mark
//! them complete, so post-restart `totals_for_drive` can answer "how much of
//! the plan have we actually finished?" without a fresh re-plan.
//!
//! Methods landed across Tasks 2–4:
//!
//! * `record_plan` — upsert pending rows preserving original `added_at_ms`
//!   (Task 2) and compact pending rows no longer in the plan (Task 3).
//! * `totals_for_drive` — aggregate counts and bytes for one drive (Task 2).
//! * `mark_completed` — flip a single row from pending to completed,
//!   idempotently (Task 4).
//! * `clear_drive` / `clear_account` — drop every row for a drive or for
//!   an entire account (Task 4; wiring in Tasks 8 and 9).
//! * `prune_settled` — delete completed rows older than a threshold,
//!   returning the deleted-row count (Task 4).
//!
//! # Concurrency
//!
//! `IntentRepo` holds an `sqlx::SqlitePool` clone, which is `Send + Sync` and
//! reference-counted internally — instances can be cloned and shared freely
//! across tasks. All methods are `&self`; SQLite serializes writes inside the
//! pool, so callers don't need an external mutex.

use std::collections::HashSet;

use sqlx::sqlite::SqlitePool;

/// Maximum number of `relative_path` values bound into a single
/// `DELETE … WHERE relative_path IN (?, ?, …)` statement.
///
/// SQLite's compile-time `SQLITE_MAX_VARIABLE_NUMBER` defaults to 999 on
/// versions <3.32 and 32_766 thereafter (source:
/// https://www.sqlite.org/limits.html §11). A single oversized `IN` list
/// returns `SQLITE_TOOBIG` at prepare time, not at execute, so the only
/// safe pattern is to chunk. We pick the conservative floor of 999 and
/// reserve headroom for the two fixed binds (`account_id`, `drive_label`)
/// — 500 leaves comfortable slack and keeps the prepared-statement cache
/// from exploding into a unique entry per pending-set size.
const DELETE_CHUNK_SIZE: usize = 500;

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

    /// Record the planner's current view of pending uploads for one drive:
    /// **compact** stale pending rows that are no longer in the plan, then
    /// **upsert** the rows that are.
    ///
    /// # Why compaction lives here
    ///
    /// The widget shows progress as `completed_files / total_files`. If the
    /// planner stops listing `b.txt` because the user renamed it to `c.txt`,
    /// deleted it before it uploaded, or added it to the exclusion rules,
    /// the stale `b.txt` row inflates `total_files` forever and progress can
    /// never hit 100%. The cheapest fix is reconciliation: every time the
    /// planner reports a plan, we drop any pending row whose path is missing
    /// from the new plan. Completed rows (`completed_at_ms IS NOT NULL`) are
    /// preserved on purpose — they represent files the user has already
    /// uploaded earlier in the session and belong to the displayed totals.
    ///
    /// # Semantics on conflict (upsert half)
    ///
    /// When a row already exists for `(account_id, drive_label,
    /// relative_path)`, only `size_bytes` is refreshed (the file may have
    /// grown between plan cycles). The original `added_at_ms` is preserved
    /// so the manifest remains a durable "since-when" record, and
    /// `completed_at_ms` is left untouched so an already-completed row is
    /// NOT reverted to pending. `added_at_ms` for new rows uses
    /// `CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)` —
    /// true millisecond-granularity Unix time (source:
    /// https://www.sqlite.org/lang_datefunc.html). 2440587.5 is the Julian
    /// Day Number of the Unix epoch (1970-01-01 00:00:00 UTC);
    /// multiplying the fractional-day delta by 86_400_000 ms/day yields
    /// exact ms-precision time. The CAST truncates the sub-ms remainder to
    /// an i64.
    ///
    /// # Empty input semantics
    ///
    /// An empty `plan_uploads` slice does NOT short-circuit. It runs the
    /// compaction half, which deletes every pending row for the
    /// `(account_id, drive_label)` pair. That's how "the planner sees
    /// nothing left to upload" gets reflected in the manifest. Completed
    /// rows still survive.
    ///
    /// # Atomicity
    ///
    /// Compaction and upsert run in a single transaction. On any error the
    /// whole call rolls back — the table cannot end up half-compacted /
    /// half-upserted.
    ///
    /// # Defense in depth
    ///
    /// The completed-row guard is enforced in two independent places:
    ///   1. The SELECT that drives the rust-side filter only fetches rows
    ///      with `completed_at_ms IS NULL`.
    ///   2. The DELETE statement repeats `AND completed_at_ms IS NULL` in
    ///      its `WHERE` clause.
    ///
    /// Even if a future refactor accidentally puts a completed `relative_path`
    /// into `to_delete`, the SQL guard still blocks the row from being
    /// dropped. Belt and braces — losing a completed row corrupts the
    /// widget's notion of "what the user already uploaded".
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] if any SQLite operation fails (including
    /// transaction commit).
    pub async fn record_plan(
        &self,
        account_id: &str,
        drive_label: &str,
        plan_uploads: &[(String, u64)],
    ) -> Result<(), IntentError> {
        // Membership check needs O(1) lookup; borrowing into the slice means
        // no per-path String allocation. Lifetime is the function body —
        // dropped before the transaction commits.
        let new_plan_paths: HashSet<&str> =
            plan_uploads.iter().map(|(p, _)| p.as_str()).collect();

        let mut tx = self.pool.begin().await?;

        // --- Compaction half ---
        //
        // Step 1: enumerate pending rows for this drive. The WHERE clause
        // filters out completed rows at the DB layer so we never even
        // materialize them into `currently_pending` — defense layer 1.
        let currently_pending: Vec<(String,)> = sqlx::query_as(
            "SELECT relative_path
               FROM sync_intent
              WHERE account_id = ?
                AND drive_label = ?
                AND completed_at_ms IS NULL",
        )
        .bind(account_id)
        .bind(drive_label)
        .fetch_all(&mut *tx)
        .await?;

        // Step 2: paths to delete = (currently pending) - (new plan set).
        // Collected into a Vec because we need to drive a `?,?,…` IN-list,
        // and the chunked DELETE statement needs to iterate twice (once for
        // SQL construction, once for binding).
        let to_delete: Vec<String> = currently_pending
            .into_iter()
            .filter_map(|(path,)| (!new_plan_paths.contains(path.as_str())).then_some(path))
            .collect();

        // Step 3: chunked DELETE. SQLite's bind-parameter limit
        // (`SQLITE_MAX_VARIABLE_NUMBER`, conservatively 999) means a single
        // statement with a giant `IN(?, ?, …)` returns SQLITE_TOOBIG at
        // prepare time. Chunking at `DELETE_CHUNK_SIZE` keeps every prepared
        // statement well below the floor and is the documented safe pattern.
        // The `completed_at_ms IS NULL` guard is repeated here — defense
        // layer 2.
        for chunk in to_delete.chunks(DELETE_CHUNK_SIZE) {
            // SQL placeholders: build "?, ?, ?" from the chunk length so the
            // statement matches the bind count exactly. `chunk` is never
            // empty inside this loop (chunks() yields only non-empty slices
            // from a non-empty source), so `placeholders` is never "".
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "DELETE FROM sync_intent
                  WHERE account_id = ?
                    AND drive_label = ?
                    AND completed_at_ms IS NULL
                    AND relative_path IN ({placeholders})",
            );
            let mut q = sqlx::query(&sql).bind(account_id).bind(drive_label);
            for path in chunk {
                q = q.bind(path);
            }
            q.execute(&mut *tx).await?;
        }

        // --- Upsert half ---
        //
        // One INSERT per row, same transaction. `excluded` is SQLite's name
        // for the row that would have been inserted; we deliberately
        // reference ONLY `excluded.size_bytes` so `added_at_ms` and
        // `completed_at_ms` keep their existing values on conflict.
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

    /// Mark a single file as completed at `now_ms`. Idempotent: calling
    /// twice leaves the row's `completed_at_ms` set to the FIRST call's
    /// value (a later mark is ignored). Unknown paths are a no-op success.
    ///
    /// # Why the `IS NULL` guard, not "last write wins"
    ///
    /// The first completion timestamp is the truthful one. `record_plan`'s
    /// `DO UPDATE SET size_bytes = excluded.size_bytes` deliberately does
    /// not clear `completed_at_ms`, so a once-completed row stays completed
    /// across plan cycles. A second `mark_completed` ping for the same path
    /// therefore can only be a redundant callback from hcfs-client (its
    /// per-file completion can fire more than once on retry paths) — and
    /// overwriting the original timestamp would silently lose the truthful
    /// "when did this actually finish" record. The `AND completed_at_ms IS
    /// NULL` predicate enforces first-write-wins at the storage layer so
    /// no Rust callsite can break it by reordering.
    ///
    /// # Unknown-path semantics
    ///
    /// SQLite's `UPDATE` returns success (not an error) when no rows match;
    /// `rows_affected()` is 0. Source: https://www.sqlite.org/lang_update.html
    /// — "It is not an error if the UPDATE statement does not match any
    /// rows." We propagate that contract: an unknown `(account_id,
    /// drive_label, relative_path)` triple returns `Ok(())` silently. The
    /// caller is hcfs-client's per-file callback which fires after the
    /// upload succeeds — by the time it runs, the planner has already
    /// recorded the row, so a missing row genuinely means "nothing to do
    /// here" (e.g. the drive was cleared mid-sync).
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] on SQLite I/O failure.
    pub async fn mark_completed(
        &self,
        account_id: &str,
        drive_label: &str,
        relative_path: &str,
        now_ms: i64,
    ) -> Result<(), IntentError> {
        // The `AND completed_at_ms IS NULL` predicate is the idempotence
        // anchor — without it a stale callback would overwrite the truthful
        // first timestamp. It is also the WHY this method is not a plain
        // SET: we want the storage layer to enforce first-write-wins so the
        // Rust callsite cannot accidentally violate it by reordering.
        sqlx::query(
            "UPDATE sync_intent
                SET completed_at_ms = ?
              WHERE account_id = ?
                AND drive_label = ?
                AND relative_path = ?
                AND completed_at_ms IS NULL",
        )
        .bind(now_ms)
        .bind(account_id)
        .bind(drive_label)
        .bind(relative_path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Drop every row for one drive (both pending and completed).
    /// Called by `remove_drive`.
    ///
    /// # Why both kinds
    ///
    /// `remove_drive` deletes the entire `sync_paths` row and wipes the
    /// on-disk baseline — the intent manifest is just the third leg of that
    /// teardown. Keeping completed rows around for a removed drive would
    /// leak them into a future drive of the same label.
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] on SQLite I/O failure.
    pub async fn clear_drive(
        &self,
        account_id: &str,
        drive_label: &str,
    ) -> Result<(), IntentError> {
        sqlx::query(
            "DELETE FROM sync_intent
              WHERE account_id = ? AND drive_label = ?",
        )
        .bind(account_id)
        .bind(drive_label)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Drop every row for one account across all drives. Called by
    /// `stop_sync` on logout.
    ///
    /// # Why account-scoped, not unconditional
    ///
    /// Multiple accounts can share the desktop's SQLite file (sub-accounts,
    /// account switching without uninstall). A `DELETE FROM sync_intent`
    /// with no predicate would wipe the other account's manifest too —
    /// silently corrupting their widget on next login. The `account_id`
    /// scope makes the destruction explicit and bounded.
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] on SQLite I/O failure.
    pub async fn clear_account(&self, account_id: &str) -> Result<(), IntentError> {
        sqlx::query("DELETE FROM sync_intent WHERE account_id = ?")
            .bind(account_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete completed rows older than `older_than_ms`. Returns the row
    /// count deleted (use 0 when nothing matched). Pending rows are
    /// preserved regardless of age — they represent in-flight intent.
    ///
    /// # Why the explicit `IS NOT NULL`
    ///
    /// SQLite's `<` comparison against `NULL` evaluates to `NULL` (SQL
    /// 3VL), which is treated as false by `WHERE`, so a pending row could
    /// never be deleted by `completed_at_ms < ?` alone. But the predicate
    /// is included anyway as explicit intent — it documents the invariant
    /// at the SQL site and prevents a future "ah, let's also prune by some
    /// other clock" refactor from accidentally widening the destruction.
    /// Source: https://www.sqlite.org/lang_expr.html §NULL Handling.
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] on SQLite I/O failure.
    pub async fn prune_settled(
        &self,
        account_id: &str,
        drive_label: &str,
        older_than_ms: i64,
    ) -> Result<u64, IntentError> {
        // `rows_affected()` on the returned `SqliteQueryResult` is `u64`.
        // Source: existing call site `migrate_account_keys` at
        // src-tauri/src/utils/schema.rs:626 uses the same shape.
        let result = sqlx::query(
            "DELETE FROM sync_intent
              WHERE account_id = ?
                AND drive_label = ?
                AND completed_at_ms IS NOT NULL
                AND completed_at_ms < ?",
        )
        .bind(account_id)
        .bind(drive_label)
        .bind(older_than_ms)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Aggregate counts and byte sums across EVERY drive for one account.
    ///
    /// Mirrors [`totals_for_drive`](Self::totals_for_drive) minus the
    /// `AND drive_label = ?` predicate — one indexed SUM/COUNT pass instead
    /// of N per-drive round-trips. The desktop's snapshot-overlay path
    /// fires on every progress emit (~4 Hz during transfers); summing in
    /// the DB layer keeps the hot path to a single sqlx call regardless of
    /// how many drives the user has configured.
    ///
    /// **SQLite `SUM` edge case.** Same as `totals_for_drive`: `SUM` over
    /// zero matching rows returns SQL NULL, so the byte sums are wrapped
    /// in `COALESCE(..., 0)`. An unknown / not-yet-used `account_id`
    /// therefore returns `IntentTotals { 0, 0, 0, 0 }` rather than an
    /// error. Source: https://www.sqlite.org/lang_aggfunc.html#sumunc.
    ///
    /// # Why account-scoped, not unconditional
    ///
    /// Same rationale as [`clear_account`](Self::clear_account): multiple
    /// accounts share the desktop's SQLite file (sub-accounts, account
    /// switching). A predicate-less aggregate would silently mix another
    /// user's totals into the active widget overlay.
    ///
    /// # Errors
    /// Returns [`IntentError::Db`] on SQLite I/O failure.
    pub async fn totals_for_account(
        &self,
        account_id: &str,
    ) -> Result<IntentTotals, IntentError> {
        // One index scan over (account_id, completed_at_ms) — same covering
        // index used by `totals_for_drive`. The `WHERE` filters by
        // account_id only; the drive_label column is left unrestricted so
        // SQLite walks every (account_id, *) entry.
        let row: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT
                COUNT(*)                                                                AS total_files,
                COALESCE(SUM(size_bytes), 0)                                            AS total_bytes,
                COUNT(CASE WHEN completed_at_ms IS NOT NULL THEN 1 END)                 AS completed_files,
                COALESCE(SUM(CASE WHEN completed_at_ms IS NOT NULL THEN size_bytes END), 0) AS completed_bytes
             FROM sync_intent
             WHERE account_id = ?",
        )
        .bind(account_id)
        .fetch_one(&self.pool)
        .await?;

        // Same i64 -> u64 cast safety argument as `totals_for_drive`:
        // COUNT(*) is non-negative; SUM of u64-sourced values is
        // non-negative; COALESCE forces NULL -> 0 before binding.
        Ok(IntentTotals {
            total_files: row.0 as u64,
            total_bytes: row.1 as u64,
            completed_files: row.2 as u64,
            completed_bytes: row.3 as u64,
        })
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

    /// Compaction edge case 1: rename. The planner used to list `b.txt` but
    /// no longer does (hcfs-client's `extract_renames` paired the
    /// `b.txt` delete with the `c.txt` upload). The stale `b.txt` row must
    /// vanish so widget progress isn't permanently inflated by a path that
    /// no longer exists.
    #[tokio::test]
    async fn record_plan_drops_pending_rows_not_in_new_plan() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct", "drive", &[("a.txt".into(), 100), ("b.txt".into(), 200)])
            .await
            .unwrap();

        // Simulate: user renamed b.txt -> c.txt. The planner now reports a and c only.
        repo.record_plan("acct", "drive", &[("a.txt".into(), 100), ("c.txt".into(), 50)])
            .await
            .unwrap();

        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.total_files, 2, "b.txt should be dropped, c.txt added");
        assert_eq!(totals.total_bytes, 150);
    }

    /// Critical invariant: completed rows are NOT dropped by compaction.
    /// They represent files the user uploaded earlier in the session and
    /// belong to the widget's displayed totals. The completed row is staged
    /// through the public `mark_completed` ingestion path — going through
    /// the public API is more resilient to schema changes than a raw UPDATE
    /// would be (rust_quality_111_test_rigor).
    #[tokio::test]
    async fn record_plan_keeps_completed_rows_not_in_new_plan() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);

        repo.record_plan("acct", "drive", &[("a.txt".into(), 100)]).await.unwrap();
        repo.mark_completed("acct", "drive", "a.txt", 1_700_000_000_000).await.unwrap();

        // Next cycle: planner no longer lists a.txt (it's done). The
        // completed row must survive both the rust-side filter (which only
        // selects pending rows) and the DB-side guard (`AND completed_at_ms
        // IS NULL` in the DELETE).
        repo.record_plan("acct", "drive", &[]).await.unwrap();

        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.total_files, 1);
        assert_eq!(totals.completed_files, 1);
        assert_eq!(totals.total_bytes, 100);
        assert_eq!(totals.completed_bytes, 100);
    }

    /// Compaction is scoped to one `(account_id, drive_label)`. An empty
    /// plan for `drive_a` must not touch `drive_b`'s rows — even though the
    /// new short-circuit-free implementation runs a transaction every call.
    /// This is the regression test that pins down the empty-input semantic
    /// change.
    #[tokio::test]
    async fn record_plan_compaction_is_drive_scoped() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);

        repo.record_plan("acct", "drive_a", &[("x.txt".into(), 100)]).await.unwrap();
        repo.record_plan("acct", "drive_b", &[("y.txt".into(), 200)]).await.unwrap();

        // Re-call record_plan on drive_a with an empty list. drive_b's row MUST survive.
        repo.record_plan("acct", "drive_a", &[]).await.unwrap();

        let ta = repo.totals_for_drive("acct", "drive_a").await.unwrap();
        let tb = repo.totals_for_drive("acct", "drive_b").await.unwrap();
        assert_eq!(ta.total_files, 0);
        assert_eq!(tb.total_files, 1);
        assert_eq!(tb.total_bytes, 200);
    }

    // ---------------- mark_completed ----------------

    #[tokio::test]
    async fn mark_completed_sets_completed_at_ms() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct", "drive", &[("a.txt".into(), 100)]).await.unwrap();
        repo.mark_completed("acct", "drive", "a.txt", 1_700_000_000_000).await.unwrap();
        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.completed_files, 1);
        assert_eq!(totals.completed_bytes, 100);
        assert_eq!(totals.total_files, 1);
    }

    #[tokio::test]
    async fn mark_completed_is_idempotent_preserving_first_timestamp() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool.clone());
        repo.record_plan("acct", "drive", &[("a.txt".into(), 100)]).await.unwrap();
        repo.mark_completed("acct", "drive", "a.txt", 1_000).await.unwrap();
        repo.mark_completed("acct", "drive", "a.txt", 2_000).await.unwrap();
        let stored: i64 = sqlx::query_scalar(
            "SELECT completed_at_ms FROM sync_intent WHERE relative_path = 'a.txt'",
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(stored, 1_000, "second mark must not overwrite the first timestamp");
    }

    #[tokio::test]
    async fn mark_completed_unknown_path_is_noop() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        // No record_plan call — the row doesn't exist.
        repo.mark_completed("acct", "drive", "nonexistent.txt", 1_000).await.unwrap();
        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.total_files, 0);
    }

    // ---------------- clear_drive ----------------

    #[tokio::test]
    async fn clear_drive_only_affects_that_drive() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct", "drive_a", &[("a.txt".into(), 100)]).await.unwrap();
        repo.record_plan("acct", "drive_b", &[("b.txt".into(), 200)]).await.unwrap();
        repo.clear_drive("acct", "drive_a").await.unwrap();
        let ta = repo.totals_for_drive("acct", "drive_a").await.unwrap();
        let tb = repo.totals_for_drive("acct", "drive_b").await.unwrap();
        assert_eq!(ta.total_files, 0);
        assert_eq!(tb.total_files, 1);
        assert_eq!(tb.total_bytes, 200);
    }

    #[tokio::test]
    async fn clear_drive_drops_both_pending_and_completed() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct", "drive", &[("p.txt".into(), 100), ("c.txt".into(), 200)]).await.unwrap();
        repo.mark_completed("acct", "drive", "c.txt", 1_000).await.unwrap();
        repo.clear_drive("acct", "drive").await.unwrap();
        let t = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(t.total_files, 0);
    }

    // ---------------- clear_account ----------------

    #[tokio::test]
    async fn clear_account_drops_all_rows_for_account() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct1", "drive_a", &[("a.txt".into(), 100)]).await.unwrap();
        repo.record_plan("acct1", "drive_b", &[("b.txt".into(), 200)]).await.unwrap();
        repo.record_plan("acct2", "drive_a", &[("c.txt".into(), 300)]).await.unwrap();

        repo.clear_account("acct1").await.unwrap();

        let t1a = repo.totals_for_drive("acct1", "drive_a").await.unwrap();
        let t1b = repo.totals_for_drive("acct1", "drive_b").await.unwrap();
        let t2a = repo.totals_for_drive("acct2", "drive_a").await.unwrap();
        assert_eq!(t1a.total_files, 0);
        assert_eq!(t1b.total_files, 0);
        assert_eq!(t2a.total_files, 1, "other account's rows must survive");
        assert_eq!(t2a.total_bytes, 300);
    }

    // ---------------- prune_settled ----------------

    #[tokio::test]
    async fn prune_settled_drops_only_completed_rows_older_than_threshold() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct", "drive", &[
            ("old_completed.txt".into(), 100),
            ("new_completed.txt".into(), 200),
            ("pending.txt".into(), 300),
        ]).await.unwrap();
        repo.mark_completed("acct", "drive", "old_completed.txt", 500).await.unwrap();
        repo.mark_completed("acct", "drive", "new_completed.txt", 5_000).await.unwrap();

        // Prune anything completed before t=1_000.
        let deleted = repo.prune_settled("acct", "drive", 1_000).await.unwrap();
        assert_eq!(deleted, 1, "exactly one row (old_completed) qualifies");

        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.total_files, 2, "new_completed + pending survive");
        assert_eq!(totals.completed_files, 1);
    }

    #[tokio::test]
    async fn prune_settled_returns_zero_when_nothing_to_prune() {
        let pool = fresh_pool().await;
        let repo = IntentRepo::new(pool);
        repo.record_plan("acct", "drive", &[("a.txt".into(), 100)]).await.unwrap();
        // Pending row, never completed.
        let deleted = repo.prune_settled("acct", "drive", 9_999_999).await.unwrap();
        assert_eq!(deleted, 0);

        let totals = repo.totals_for_drive("acct", "drive").await.unwrap();
        assert_eq!(totals.total_files, 1, "pending row preserved");
    }
}
