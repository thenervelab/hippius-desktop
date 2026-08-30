//! Device name settings: read and write the friendly device name for
//! this machine, stored in the local SQLite database.

use tracing::info;

use crate::error::Result;
use sqlx::sqlite::SqlitePool;

/// Internal helper to read the device name from DB.
pub(crate) async fn get_device_name_internal(pool: &SqlitePool) -> Result<String> {
    let row = sqlx::query_scalar::<_, String>("SELECT device_name FROM device_settings WHERE id = 1")
        .fetch_optional(pool)
        .await?;
    Ok(row.unwrap_or_else(|| "My Device".to_string()))
}

/// Get the friendly device name for this machine.
#[tauri::command]
pub async fn get_device_name(state: tauri::State<'_, crate::app_state::AppState>) -> Result<String> {
    get_device_name_internal(state.pool()?).await
}

/// Trim and refuse a blank name. Extracted so the validation is unit-testable
/// without a Tauri `State`.
pub(crate) fn validate_device_name(name: &str) -> Result<String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        // Rejected user input → Validation (the FE renders these messages
        // directly), not the catch-all Other.
        return Err(crate::error::AppError::Validation("Device name cannot be empty".into()));
    }
    Ok(name)
}

pub(crate) async fn set_device_name_internal(pool: &SqlitePool, name: &str) -> Result<()> {
    let name = validate_device_name(name)?;
    sqlx::query(
        "INSERT INTO device_settings (id, device_name, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET device_name = excluded.device_name, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(&name)
    .execute(pool)
    .await?;
    info!("Device name updated: {}", name);
    Ok(())
}

/// Set a custom friendly device name for this machine.
#[tauri::command]
pub async fn set_device_name(state: tauri::State<'_, crate::app_state::AppState>, name: String) -> Result<()> {
    set_device_name_internal(state.pool()?, &name).await
}

#[cfg(test)]
mod tests {
    use super::{get_device_name_internal, set_device_name_internal, validate_device_name};
    use crate::error::AppError;
    use sqlx::SqlitePool;

    #[test]
    fn blank_names_are_validation() {
        for name in ["", "   ", "\n"] {
            let err = validate_device_name(name).expect_err("blank");
            match err {
                AppError::Validation(msg) => {
                    assert!(msg.contains("cannot be empty"), "{msg}");
                }
                other => panic!("expected Validation, got {other:?}"),
            }
        }
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(validate_device_name("  Studio  ").expect("ok"), "Studio");
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        sqlx::query(
            "CREATE TABLE device_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                device_name TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pool)
        .await
        .expect("create");
        pool
    }

    #[tokio::test]
    async fn missing_row_defaults_to_my_device() {
        let pool = pool().await;
        assert_eq!(get_device_name_internal(&pool).await.expect("get"), "My Device");
    }

    #[tokio::test]
    async fn set_then_get_round_trips() {
        let pool = pool().await;
        set_device_name_internal(&pool, "  Desk  ").await.expect("set");
        assert_eq!(get_device_name_internal(&pool).await.expect("get"), "Desk");
    }
}
