//! Remote notification settings commands.
//!
//! These manage the server-side notification preferences (email, push)
//! via the Hippius API. For local in-app notification preferences, see
//! [`super::local_db`].

use crate::api_client::ApiClient;

/// Fetch the user's current remote notification settings from the API.
#[tauri::command]
pub async fn get_notification_settings(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get::<serde_json::Value>("/api/notifications/settings/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

/// Patch the user's remote notification settings on the API.
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
