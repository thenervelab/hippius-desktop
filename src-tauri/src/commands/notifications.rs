//! Notification settings commands.

use crate::api_client::ApiClient;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct NotificationSettings {
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[tauri::command]
pub async fn get_notification_settings(
    account_id: String,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new();
    client
        .get::<serde_json::Value>("/api/notifications/settings/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_notification_settings(
    account_id: String,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new();
    client
        .patch::<serde_json::Value, _>("/api/notifications/settings/", &settings, &account_id)
        .await
        .map_err(|e| e.to_string())
}
