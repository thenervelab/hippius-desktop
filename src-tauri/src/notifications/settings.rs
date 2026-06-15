//! Remote notification settings commands.
//!
//! These manage the server-side notification preferences (email, push)
//! via the Hippius API. For local in-app notification preferences, see
//! [`super::local_db`].

use crate::api::client::ApiClient;
use crate::error::AppError;

/// Fetch the user's current remote notification settings from the API.
#[tauri::command]
pub async fn get_notification_settings(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    Ok(client.get::<serde_json::Value>("/api/notifications/settings/", &account_id).await?)
}

/// Patch the user's remote notification settings on the API.
#[tauri::command]
pub async fn update_notification_settings(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    settings: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    Ok(client
        .patch::<serde_json::Value, _>("/api/notifications/settings/", &settings, &account_id)
        .await?)
}
