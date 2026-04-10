//! One-shot migration: collapse the global `sync_user_stopped` preference
//! into the per-drive `sync_paths.is_paused` column.
//!
//! ## Why
//!
//! The legacy global `user_stopped` flag (read by `auto_init_sync` and
//! `get_sync_engine_status`) was a holdover from the single-drive era.
//! In the new per-drive model the only persisted "user wants this off"
//! state lives on `sync_paths.is_paused`. To preserve user intent across
//! the upgrade, any user with `sync_user_stopped = true` at the moment
//! of the upgrade gets every one of their sync paths marked paused —
//! they will see all drives in the Paused state in the new UI and can
//! resume them individually from the per-drive 3-dot menu / tray /
//! settings page.
//!
//! ## Idempotency
//!
//! Runs at every app launch. The migration short-circuits in the common
//! case where the preference key is absent (i.e. the migration has
//! already run, or this is a clean install). The painted-paused write
//! and the preference delete happen in a single SQL transaction so a
//! crash mid-migration cannot leave the system half-migrated.
//!
//! ## Safe to delete
//!
//! Once enough releases have shipped that no live install still has the
//! `sync_user_stopped` row, this entire module (plus the call site in
//! `main.rs`) can be removed without ceremony — it leaves no schema
//! residue behind.

use sqlx::SqlitePool;
use tracing::{info, warn};

/// Preference key written by the legacy global `write_user_stopped`.
/// Hardcoded here (rather than imported from `status_state.rs`) so this
/// module remains self-contained for easy deletion later.
const LEGACY_KEY: &str = "sync_user_stopped";

/// Run the migration. Idempotent: a no-op when the legacy preference
/// key is absent. Returns the number of `sync_paths` rows that were
/// painted to paused (0 in the no-op case).
pub async fn migrate_user_stopped_to_per_drive(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    // Step 1: read the legacy flag. Fast path: missing = nothing to do.
    let legacy: Option<(String,)> = sqlx::query_as("SELECT preference_value FROM user_preferences WHERE preference_key = ?")
        .bind(LEGACY_KEY)
        .fetch_optional(pool)
        .await?;

    let was_stopped = legacy.is_some_and(|(v,)| v == "true");

    // If the row exists with value "false" we still want to clean it up
    // (it's dead weight) but we don't paint anything paused.
    let row_exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_preferences WHERE preference_key = ?")
        .bind(LEGACY_KEY)
        .fetch_one(pool)
        .await?
        > 0;

    if !row_exists {
        return Ok(0);
    }

    // Step 2: do the painting + delete inside a single transaction so
    // we cannot leave the legacy key behind if the UPDATE crashes, and
    // cannot half-paint paused rows if the DELETE crashes. The legacy
    // flag is global (not scoped to an owner), so we paint every row.
    let mut tx = pool.begin().await?;

    let painted = if was_stopped {
        let result = sqlx::query("UPDATE sync_paths SET is_paused = 1 WHERE is_paused = 0")
            .execute(&mut *tx)
            .await?;
        result.rows_affected()
    } else {
        0
    };

    sqlx::query("DELETE FROM user_preferences WHERE preference_key = ?")
        .bind(LEGACY_KEY)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    if was_stopped {
        info!(
            painted_rows = painted,
            "Migrated legacy sync_user_stopped=true to per-drive is_paused on every sync_paths row"
        );
    } else {
        info!("Cleaned up stale sync_user_stopped=false preference key");
    }

    Ok(painted)
}

/// Convenience wrapper for the call site in `main.rs`. Logs and
/// swallows any error so a migration failure cannot prevent app
/// startup — the worst case is that the legacy flag remains and the
/// next launch tries again.
pub async fn run_at_startup(pool: &SqlitePool) {
    match migrate_user_stopped_to_per_drive(pool).await {
        Ok(_) => {}
        Err(e) => warn!("user_stopped migration failed (will retry on next launch): {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spin up an in-memory pool with the minimum schema this module
    /// touches: `user_preferences` and `sync_paths`.
    async fn make_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");

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

    async fn insert_pref(pool: &SqlitePool, value: &str) {
        sqlx::query("INSERT INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, 0)")
            .bind(LEGACY_KEY)
            .bind(value)
            .execute(pool)
            .await
            .unwrap();
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

    async fn pref_exists(pool: &SqlitePool) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_preferences WHERE preference_key = ?")
            .bind(LEGACY_KEY)
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
    async fn no_op_when_legacy_key_missing() {
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", false).await;

        let painted = migrate_user_stopped_to_per_drive(&pool).await.unwrap();

        assert_eq!(painted, 0);
        assert_eq!(paused_count(&pool).await, 0);
    }

    #[tokio::test]
    async fn paints_all_drives_paused_when_legacy_true() {
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", false).await;
        insert_path(&pool, "alice", "photos", false).await;
        insert_path(&pool, "bob", "work", false).await;
        insert_pref(&pool, "true").await;

        let painted = migrate_user_stopped_to_per_drive(&pool).await.unwrap();

        // The legacy flag is global so it paints across owners.
        assert_eq!(painted, 3);
        assert_eq!(paused_count(&pool).await, 3);
        // The legacy key must be gone.
        assert!(!pref_exists(&pool).await);
    }

    #[tokio::test]
    async fn does_not_repaint_already_paused_drives() {
        // Sanity: rows that were already paused stay paused, but the
        // `rows_affected` count only reflects the ones the UPDATE
        // touched (so the log line is honest about what changed).
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", true).await;
        insert_path(&pool, "alice", "photos", false).await;
        insert_pref(&pool, "true").await;

        let painted = migrate_user_stopped_to_per_drive(&pool).await.unwrap();

        assert_eq!(painted, 1);
        assert_eq!(paused_count(&pool).await, 2);
        assert!(!pref_exists(&pool).await);
    }

    #[tokio::test]
    async fn cleans_up_legacy_false_without_painting() {
        // A user who explicitly resumed sync before the upgrade has
        // sync_user_stopped=false. We should still delete the dead key
        // but not paint anything paused.
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", false).await;
        insert_pref(&pool, "false").await;

        let painted = migrate_user_stopped_to_per_drive(&pool).await.unwrap();

        assert_eq!(painted, 0);
        assert_eq!(paused_count(&pool).await, 0);
        assert!(!pref_exists(&pool).await);
    }

    #[tokio::test]
    async fn idempotent_second_run_is_a_noop() {
        let pool = make_pool().await;
        insert_path(&pool, "alice", "default", false).await;
        insert_pref(&pool, "true").await;

        let first = migrate_user_stopped_to_per_drive(&pool).await.unwrap();
        let second = migrate_user_stopped_to_per_drive(&pool).await.unwrap();

        assert_eq!(first, 1);
        assert_eq!(second, 0);
        assert_eq!(paused_count(&pool).await, 1);
        assert!(!pref_exists(&pool).await);
    }
}
