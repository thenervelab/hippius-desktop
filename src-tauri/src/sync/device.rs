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

/// Set a custom friendly device name for this machine.
#[tauri::command]
pub async fn set_device_name(state: tauri::State<'_, crate::app_state::AppState>, name: String) -> Result<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::Other("Device name cannot be empty".into()));
    }
    let pool = state.pool()?;
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
