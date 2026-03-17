//! Support ticket commands.

use crate::api_client::ApiClient;
use serde::Deserialize;

#[tauri::command]
pub async fn list_support_tickets(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    limit: Option<i64>,
    search: Option<String>,
    ordering: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(10).to_string();
    let ordering_str = ordering.unwrap_or_else(|| "status".to_string());
    let mut params = vec![
        ("page", page_str.as_str()),
        ("limit", limit_str.as_str()),
        ("ordering", ordering_str.as_str()),
    ];
    if let Some(ref s) = search {
        params.push(("search", s.as_str()));
    }
    client
        .get_with_params::<serde_json::Value>("/api/support/tickets/", &params, &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_support_ticket_messages(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    ticket_id: i64,
    page: Option<i64>,
    limit: Option<i64>,
    search: Option<String>,
    ordering: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/support/tickets/{ticket_id}/messages/");
    let page_str = page.unwrap_or(1).to_string();
    let limit_str = limit.unwrap_or(50).to_string();
    let mut params = vec![("page", page_str.as_str()), ("limit", limit_str.as_str())];
    if let Some(ref s) = search {
        params.push(("search", s.as_str()));
    }
    if let Some(ref o) = ordering {
        params.push(("ordering", o.as_str()));
    }
    client
        .get_with_params::<serde_json::Value>(&path, &params, &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTicketParams {
    pub subject: String,
    pub priority: String,
    pub category: String,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub description: String,
}

#[tauri::command]
pub async fn create_support_ticket(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    params: CreateTicketParams,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let body = serde_json::json!({
        "subject": params.subject,
        "priority": params.priority,
        "category": params.category,
        "resource_type": params.resource_type,
        "resource_id": params.resource_id,
        "description": params.description,
    });
    client
        .post::<serde_json::Value, _>("/api/support/tickets/", &body, &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn post_ticket_message(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    ticket_id: i64,
    message_type: String,
    body: String,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/support/tickets/{ticket_id}/messages/");
    let payload = serde_json::json!({
        "message_type": message_type,
        "body": body,
    });
    client
        .post::<serde_json::Value, _>(&path, &payload, &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_support_ticket(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    ticket_id: i64,
    updates: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/support/tickets/{ticket_id}/");
    client
        .patch::<serde_json::Value, _>(&path, &updates, &account_id)
        .await
        .map_err(|e| e.to_string())
}
