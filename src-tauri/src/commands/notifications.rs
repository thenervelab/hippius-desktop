//! Notification settings commands.

use crate::api_client::ApiClient;
#[tauri::command]
pub async fn get_notification_settings(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get::<serde_json::Value>("/api/notifications/settings/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_notification_settings(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .patch::<serde_json::Value, _>("/api/notifications/settings/", &settings, &account_id)
        .await
        .map_err(|e| e.to_string())
}
