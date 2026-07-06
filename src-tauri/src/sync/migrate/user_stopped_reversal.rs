//! One-shot reversal of the damage caused by
//! [`crate::sync::user_stopped_migration`].
//!
//! ## Why
//!
//! When the legacy single-drive `sync_user_stopped = true` preference was
//! migrated into the per-drive `sync_paths.is_paused` column, EVERY row
//! was painted paused. That was the intent at migration time — preserve
//! "I want sync off" across the UI rewrite. In practice, most users who
//! had the legacy flag set had it set transiently (they'd paused sync
//! during a long-running other task months ago and forgot); after the
//! migration they logged back in, watched nothing sync, and couldn't
//! figure out why every drive showed the Paused status.
//!
//! The per-drive pause model is sound — the only mistake was the
//! painted-paused default on migration. This reversal clears the
//! `is_paused` column for every drive **exactly once**, so the
//! migration-damaged installs get a clean slate. Future user-initiated
//! pauses still persist normally across login/logout/restart because
//! the reversal only runs once (gated by a preference sentinel).
//!
//! ## What this does
//!
//! On every app launch, if the sentinel preference key is absent, sets
//! `is_paused = 0` on every row of `sync_paths` where it is currently 1,
//! then records the sentinel so the reversal runs exactly once per
//! install. Clear + sentinel insert happen inside a single SQL
//! transaction.
//!
//! ## Why not simply "clear is_paused on every login"?
//!
//! Because that would break the per-drive design: `pause_drive` is
//! documented user intent and MUST survive login/logout (it's how the
//! tray menu, settings page, and FilesContainer 3-dot menu all behave).
//! Clearing on every login would quietly break the normal pause flow
//! for every user going forward to fix a one-shot migration mistake.
//! A gated one-shot is targeted at the damaged population only.
//!
//! ## Idempotency
//!
//! Keyed by the `user_stopped_reversal_v1_done` preference. Present =
//! reversal has run, subsequent launches are no-ops. Absent = run the
//! reversal now. Clearing an already-0 column is itself a no-op, so
//! even a catastrophic preference-table wipe would be safe.
//!
//! ## Safe to delete
//!
//! Once enough releases have shipped that no live install could still
//! carry a migration-painted `is_paused = 1` row (i.e. every user has
//! launched this release at least once), this module plus its call
//! site in `main.rs` can be removed. The sentinel row is harmless
//! residue and removing it isn't required.

use sqlx::SqlitePool;
use tracing::{info, warn};

/// Sentinel preference key. Presence = reversal has already run.
const RESET_SENTINEL_KEY: &str = "user_stopped_reversal_v1_done";

/// Run the reversal. Idempotent: a no-op when the sentinel is already
/// present. Returns the number of `sync_paths` rows whose `is_paused`
/// flag was cleared (0 in the idempotent-skip case).
pub async fn clear_migrated_paused_flags(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    // Fast path: sentinel already present ⇒ reversal ran before, nothing to do.
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
    // redo the clear (an UPDATE on already-0 is a no-op) and then finish
    // writing the sentinel — harmless. Still, bundling them in a TX makes
    // the normal-path semantics cleaner.
    let mut tx = pool.begin().await?;

    let cleared = sqlx::query("UPDATE sync_paths SET is_paused = 0 WHERE is_paused = 1")
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
        "user_stopped reversal: cleared migrated-paused flag on every drive; future user-initiated pauses still persist normally"
    );

    Ok(cleared)
}

/// Convenience wrapper for the call site in `main.rs`. Logs and swallows
/// any error so a migration failure cannot prevent app startup — the
/// worst case is that the sentinel isn't written, the flag clear happens
/// again on the next launch, and the no-op UPDATE runs a second time.
pub async fn run_at_startup(pool: &SqlitePool) {
    match clear_migrated_paused_flags(pool).await {
        Ok(_) => {}
        Err(e) => warn!("user_stopped reversal failed (will retry on next launch): {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Spin up an in-memory pool with the minimum schema this module
    /// touches: `user_preferences` and `sync_paths` (only the columns
    /// we read or write; extras are outside this test's scope).
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
                is_paused INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner, label)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        pool
    }

    async fn insert_path(pool: &SqlitePool, owner: &str, label: &str, paused: bool) {
        sqlx::query("INSERT INTO sync_paths (owner, path, type, label, is_paused) VALUES (?, ?, 'private', ?, ?)")
            .bind(owner)
            .bind(format!("/tmp/{label}"))
            .bind(label)
            .bind(i32::from(paused))
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

    async fn paused_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_paths WHERE is_paused = 1")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn clears_all_paused_rows_on_first_run() {
        // The real-world case: `user_stopped_migration` painted every
        // row paused for an affected user. Reversal must undo that.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", true).await;
        insert_path(&pool, "alice", "photos", true).await;
        insert_path(&pool, "bob", "work", true).await;

        let cleared = clear_migrated_paused_flags(&pool).await.unwrap();

        assert_eq!(cleared, 3);
        assert_eq!(paused_count(&pool).await, 0);
        assert!(sentinel_present(&pool).await);
    }

    #[tokio::test]
    async fn second_run_is_a_noop_and_preserves_user_intent() {
        // Idempotency: a user who re-paused a drive AFTER the reversal
        // ran must see that pause survive the next launch. This is the
        // whole point of gating on the sentinel — restore the normal
        // "pause = persisted intent" contract once the migration damage
        // is undone.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", true).await;

        let first = clear_migrated_paused_flags(&pool).await.unwrap();
        assert_eq!(first, 1);
        assert_eq!(paused_count(&pool).await, 0);

        // Simulate the user pausing the drive again after the reversal ran.
        sqlx::query("UPDATE sync_paths SET is_paused = 1 WHERE label = ?")
            .bind("default")
            .execute(&pool)
            .await
            .unwrap();

        let second = clear_migrated_paused_flags(&pool).await.unwrap();
        assert_eq!(second, 0, "second run must not touch the DB");
        assert_eq!(paused_count(&pool).await, 1, "user-initiated pause must survive the next launch");
    }

    #[tokio::test]
    async fn first_run_with_no_paused_rows_still_writes_sentinel() {
        // Clean-install path: no drives are paused. We still write the
        // sentinel so the reversal doesn't re-examine every startup
        // for the rest of the install's lifetime.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", false).await;

        let cleared = clear_migrated_paused_flags(&pool).await.unwrap();

        assert_eq!(cleared, 0);
        assert!(sentinel_present(&pool).await, "sentinel must be written even on a clean-install path");
    }

    #[tokio::test]
    async fn first_run_with_empty_sync_paths_writes_sentinel() {
        // Brand-new install with no drives yet. No rows to clear, but
        // the sentinel still has to land so the reversal stays a
        // one-shot.
        let pool = make_pool().await;

        let cleared = clear_migrated_paused_flags(&pool).await.unwrap();

        assert_eq!(cleared, 0);
        assert!(sentinel_present(&pool).await);
    }

    #[tokio::test]
    async fn respects_pre_existing_sentinel() {
        // If the sentinel is already present (reversal already ran on
        // a previous launch), we MUST NOT touch `sync_paths`. Guards
        // against a downgrade/upgrade loop that would otherwise keep
        // clearing user-initiated pauses forever.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", true).await;

        sqlx::query("INSERT INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, '1', 0)")
            .bind(RESET_SENTINEL_KEY)
            .execute(&pool)
            .await
            .unwrap();

        let cleared = clear_migrated_paused_flags(&pool).await.unwrap();

        assert_eq!(cleared, 0);
        assert_eq!(
            paused_count(&pool).await,
            1,
            "existing paused row must not be cleared when sentinel is present"
        );
    }
}
