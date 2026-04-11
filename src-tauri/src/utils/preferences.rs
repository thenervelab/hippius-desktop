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
#[tauri::command]
pub async fn get_user_preference(state: tauri::State<'_, AppState>, key: String) -> Result<Option<String>, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (String,)>("SELECT preference_value FROM user_preferences WHERE preference_key = ?")
        .bind(&key)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(|(v,)| v))
}

/// Save a user preference (upsert). Timestamps with current epoch millis.
#[tauri::command]
pub async fn save_user_preference(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query(
        "INSERT OR REPLACE INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, CAST(strftime('%s','now') * 1000 AS INTEGER))",
    )
    .bind(&key)
    .bind(&value)
    .execute(pool)
    .await?;

    Ok(())
}
