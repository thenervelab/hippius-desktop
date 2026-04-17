//! One-shot reset of `sync_paths.relative_paths_backfilled_at` to NULL for
//! drives that ran the backfill before the NFC-normalisation fix shipped.
//!
//! ## Why
//!
//! The one-shot relative-path backfill (see
//! [`crate::sync::relative_path_backfill`]) used to mark a drive "done"
//! whenever the HTTP round-trip to `register_relative_paths` succeeded —
//! including when the server had rejected every individual non-NFC path
//! with a per-entry validation error. macOS APFS filenames arrive in NFD,
//! so on any affected install every accented-filename row would stay NULL
//! server-side, the drive flag would flip to non-NULL, and subsequent
//! launches would short-circuit as `AlreadyDone` — permanently hiding
//! those files from `/browse`.
//!
//! The fix in `relative_path_backfill.rs` stops the flag from being set
//! when any per-entry error is reported, so going forward a rejected
//! entry triggers a retry on the next launch. But users who already have
//! the flag flipped need a one-time clear to pick up the retry loop.
//!
//! ## What this does
//!
//! On every app launch, if the sentinel preference key is absent, sets
//! `relative_paths_backfilled_at = NULL` on every row of `sync_paths`
//! where it is currently non-NULL, then records the sentinel so the
//! reset runs exactly once per install.
//!
//! The clear + sentinel insert happen inside a single SQL transaction so
//! a crash mid-migration cannot leave the system half-reset.
//!
//! ## Idempotency
//!
//! Keyed by the `relative_path_backfill_nfc_reset_v1_done` preference.
//! Present = reset has run, subsequent launches are no-ops. Absent = run
//! the reset now. Clearing an already-NULL column is itself a no-op, so
//! even a catastrophic preference-table wipe would be safe.
//!
//! ## Safe to delete
//!
//! Once enough releases have shipped that no live install could still
//! have an un-reset flag (i.e. every user has launched this release at
//! least once), this module plus its call site in `main.rs` can be
//! deleted. The sentinel preference row is harmless residue and
//! removing it isn't required — the column it gates is a no-op when
//! already NULL.

use sqlx::SqlitePool;
use tracing::{info, warn};

/// Sentinel preference key. Presence = reset has already run.
/// Hardcoded here (rather than imported) so this module remains
/// self-contained for easy deletion later.
const RESET_SENTINEL_KEY: &str = "relative_path_backfill_nfc_reset_v1_done";

/// Run the reset. Idempotent: a no-op when the sentinel is already present.
/// Returns the number of `sync_paths` rows whose backfill flag was cleared
/// (0 in the idempotent-skip case).
pub async fn reset_stale_backfill_flags(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    // Fast path: sentinel already present ⇒ reset ran before, nothing to do.
    let already_done = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_preferences WHERE preference_key = ?")
        .bind(RESET_SENTINEL_KEY)
        .fetch_one(pool)
        .await?
        > 0;

    if already_done {
        return Ok(0);
    }

    // Clear-then-insert-sentinel inside a single transaction. If we crashed
    // between the clear and the sentinel write, the next launch would just
    // redo the clear (an UPDATE on already-NULL is a no-op) and then finish
    // writing the sentinel — harmless. Still, bundling them in a TX makes
    // the normal-path semantics cleaner.
    let mut tx = pool.begin().await?;

    let cleared = sqlx::query("UPDATE sync_paths SET relative_paths_backfilled_at = NULL WHERE relative_paths_backfilled_at IS NOT NULL")
        .execute(&mut *tx)
        .await?
        .rows_affected();

    // Value is just a timestamp for forensics; presence of the key is what
    // the fast path above checks.
    let now = chrono::Utc::now().timestamp();
    sqlx::query("INSERT INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, ?)")
        .bind(RESET_SENTINEL_KEY)
        .bind(now.to_string())
        .bind(now)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    info!(
        cleared_rows = cleared,
        "relative_path backfill NFC reset: cleared stale backfilled_at flags; next launch will retry backfill with normalised paths"
    );

    Ok(cleared)
}

/// Convenience wrapper for the call site in `main.rs`. Logs and swallows
/// any error so a migration failure cannot prevent app startup — the
/// worst case is that the sentinel isn't written, the flag clear happens
/// again on the next launch, and the backfill re-runs idempotently.
pub async fn run_at_startup(pool: &SqlitePool) {
    match reset_stale_backfill_flags(pool).await {
        Ok(_) => {}
        Err(e) => warn!(
            "relative_path backfill NFC reset failed (will retry on next launch): {e}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Spin up an in-memory pool with the minimum schema this module
    /// touches: `user_preferences` and `sync_paths` (only the columns
    /// we read or write; extra columns are outside this test's scope).
    async fn make_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");

        sqlx::query(
            "CREATE TABLE user_preferences (
                preference_key TEXT PRIMARY KEY,
                preference_value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE sync_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL,
                path TEXT NOT NULL,
                type TEXT NOT NULL,
                label TEXT NOT NULL,
                relative_paths_backfilled_at INTEGER,
                UNIQUE(owner, label)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        pool
    }

    async fn insert_path(pool: &SqlitePool, owner: &str, label: &str, backfilled_at: Option<i64>) {
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, relative_paths_backfilled_at) VALUES (?, ?, 'private', ?, ?)",
        )
        .bind(owner)
        .bind(format!("/tmp/{label}"))
        .bind(label)
        .bind(backfilled_at)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn sentinel_present(pool: &SqlitePool) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_preferences WHERE preference_key = ?")
            .bind(RESET_SENTINEL_KEY)
            .fetch_one(pool)
            .await
            .unwrap()
            > 0
    }

    async fn backfilled_non_null_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_paths WHERE relative_paths_backfilled_at IS NOT NULL")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn clears_all_non_null_backfill_flags_on_first_run() {
        // Two drives with the flag set (the real-world case: every affected
        // user's drive ran the buggy backfill and flipped the flag).
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", Some(1_700_000_000)).await;
        insert_path(&pool, "alice", "photos", Some(1_700_000_000)).await;
        insert_path(&pool, "bob", "work", None).await;

        let cleared = reset_stale_backfill_flags(&pool).await.unwrap();

        assert_eq!(cleared, 2, "both non-NULL rows should be cleared");
        assert_eq!(backfilled_non_null_count(&pool).await, 0);
        assert!(sentinel_present(&pool).await, "sentinel should be written");
    }

    #[tokio::test]
    async fn second_run_is_a_noop() {
        // Idempotency: even if a drive's flag gets re-flipped between the
        // first reset and the second app launch, we must NOT clear it
        // again — that would create an infinite re-backfill loop for any
        // users whose legitimate post-fix backfill completed successfully
        // before the next launch.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", Some(1_700_000_000)).await;

        let first = reset_stale_backfill_flags(&pool).await.unwrap();
        assert_eq!(first, 1);

        // Simulate the backfill running successfully post-reset and
        // setting the flag again.
        sqlx::query("UPDATE sync_paths SET relative_paths_backfilled_at = ? WHERE label = ?")
            .bind(1_700_100_000i64)
            .bind("default")
            .execute(&pool)
            .await
            .unwrap();

        let second = reset_stale_backfill_flags(&pool).await.unwrap();
        assert_eq!(second, 0, "second run must not touch the DB");
        assert_eq!(
            backfilled_non_null_count(&pool).await,
            1,
            "the post-fix flag must survive"
        );
    }

    #[tokio::test]
    async fn first_run_with_no_non_null_rows_still_writes_sentinel() {
        // Clean install path: no drives have the flag set. We should still
        // write the sentinel so the reset doesn't re-examine every startup
        // for the rest of the install's lifetime.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", None).await;

        let cleared = reset_stale_backfill_flags(&pool).await.unwrap();

        assert_eq!(cleared, 0);
        assert!(
            sentinel_present(&pool).await,
            "sentinel must be written even on a clean-install path"
        );
    }

    #[tokio::test]
    async fn first_run_with_empty_sync_paths_writes_sentinel() {
        // Brand-new install with no drives yet. No rows to clear, but the
        // sentinel still has to land so the reset stays a one-shot.
        let pool = make_pool().await;

        let cleared = reset_stale_backfill_flags(&pool).await.unwrap();

        assert_eq!(cleared, 0);
        assert!(sentinel_present(&pool).await);
    }

    #[tokio::test]
    async fn respects_pre_existing_sentinel() {
        // If an older release (or a future one) has already written the
        // sentinel, we must bail without touching `sync_paths`. Guards
        // against a downgrade/upgrade loop.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", Some(1_700_000_000)).await;

        // Pre-write the sentinel as if a previous launch had done so.
        sqlx::query("INSERT INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, '1', 0)")
            .bind(RESET_SENTINEL_KEY)
            .execute(&pool)
            .await
            .unwrap();

        let cleared = reset_stale_backfill_flags(&pool).await.unwrap();

        assert_eq!(cleared, 0);
        assert_eq!(
            backfilled_non_null_count(&pool).await,
            1,
            "the existing flag must not be cleared when the sentinel is already present"
        );
    }
}
