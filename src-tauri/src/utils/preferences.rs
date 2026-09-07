//! Onboarding state and user preferences (key-value store).

use crate::app_state::AppState;
use crate::error::AppError;
use tracing::info;

#[tauri::command]
pub async fn is_onboarding_done(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i32,)>("SELECT is_done FROM onboarding WHERE id = 1")
        .fetch_optional(pool)
        .await?;

    Ok(row.is_some_and(|(v,)| v != 0))
}

/// Set the onboarding done flag. Inserts if no row exists.
#[tauri::command]
pub async fn set_onboarding_done(state: tauri::State<'_, AppState>, done: bool) -> Result<(), AppError> {
    info!(done = done, "Onboarding status updated");
    let pool = state.pool()?;
    let val: i32 = i32::from(done);

    sqlx::query("INSERT INTO onboarding (id, is_done) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET is_done = excluded.is_done")
        .bind(val)
        .execute(pool)
        .await?;

    Ok(())
}

// ── User Preferences ────────────────────────────────────────────────────

/// Get a user preference value by key. Returns None if the key doesn't exist.
///
/// Thin IPC wrapper over [`get_user_preference_internal`] so the SQL is
/// defined in exactly one place — the IPC and background-task paths
/// can't drift on the query shape.
#[tauri::command]
pub async fn get_user_preference(state: tauri::State<'_, AppState>, key: String) -> Result<Option<String>, AppError> {
    get_user_preference_internal(state.pool()?, &key).await
}

/// Save a user preference (upsert). Timestamps with current epoch millis.
#[tauri::command]
pub async fn save_user_preference(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<(), AppError> {
    save_user_preference_internal(state.pool()?, &key, &value).await
}

/// Read a user preference using a `&SqlitePool` directly. Useful from
/// non-IPC contexts (background tasks) that don't have a Tauri State.
pub async fn get_user_preference_internal(pool: &sqlx::SqlitePool, key: &str) -> Result<Option<String>, AppError> {
    let row = sqlx::query_as::<_, (String,)>("SELECT preference_value FROM user_preferences WHERE preference_key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(|(v,)| v))
}

/// Write a user preference using a `&SqlitePool` directly. Useful from
/// non-IPC contexts (background tasks) that don't have a Tauri State.
pub async fn save_user_preference_internal(pool: &sqlx::SqlitePool, key: &str, value: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR REPLACE INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, CAST(strftime('%s','now') * 1000 AS INTEGER))",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{get_user_preference_internal, save_user_preference_internal};
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        sqlx::query(
            "CREATE TABLE user_preferences (
                preference_key TEXT PRIMARY KEY,
                preference_value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create user_preferences");
        pool
    }

    #[tokio::test]
    async fn missing_key_returns_none() {
        let pool = pool().await;
        let value = get_user_preference_internal(&pool, "lastBrowseDirectory").await.expect("get");
        assert_eq!(value, None);
    }

    #[tokio::test]
    async fn save_then_get_round_trips() {
        let pool = pool().await;
        save_user_preference_internal(&pool, "lastBrowseDirectory", "/tmp/drive")
            .await
            .expect("save");
        let value = get_user_preference_internal(&pool, "lastBrowseDirectory").await.expect("get");
        assert_eq!(value.as_deref(), Some("/tmp/drive"));
    }

    #[tokio::test]
    async fn save_replaces_the_same_key() {
        let pool = pool().await;
        save_user_preference_internal(&pool, "theme", "light").await.expect("first");
        save_user_preference_internal(&pool, "theme", "dark").await.expect("second");
        let value = get_user_preference_internal(&pool, "theme").await.expect("get");
        assert_eq!(value.as_deref(), Some("dark"));
    }
}
