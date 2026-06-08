//! Support ticket commands.
//!
//! Proxies the Hippius support API so users can create, view, and reply
//! to tickets without leaving the desktop app. All requests are
//! authenticated via the account's stored API token.

use crate::api::client::ApiClient;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use tracing::info;

/// List support tickets with optional search, ordering, and pagination.
#[tauri::command]
pub async fn list_support_tickets(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    page: Option<i64>,
    limit: Option<i64>,
    search: Option<String>,
    ordering: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
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
    Ok(client
        .get_with_params::<serde_json::Value>("/api/support/tickets/", &params, &account_id)
        .await?)
}

/// Fetch the message thread for a specific support ticket.
#[tauri::command]
pub async fn get_support_ticket_messages(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    ticket_id: i64,
    page: Option<i64>,
    limit: Option<i64>,
    search: Option<String>,
    ordering: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
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
    Ok(client.get_with_params::<serde_json::Value>(&path, &params, &account_id).await?)
}

/// Frontend payload for creating a new support ticket.
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

/// Open a new support ticket with a subject, priority, and description.
#[tauri::command]
pub async fn create_support_ticket(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    params: CreateTicketParams,
) -> Result<serde_json::Value, AppError> {
    info!(
        subject = %params.subject,
        category = %params.category,
        "Creating support ticket"
    );
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let mut body = serde_json::json!({
        "subject": params.subject,
        "priority": params.priority,
        "category": params.category,
        "description": params.description,
    });
    // Only include resource_type/resource_id if they are non-empty;
    // the API rejects null values for these fields.
    if let Some(ref rt) = params.resource_type {
        if !rt.is_empty() {
            body["resource_type"] = serde_json::json!(rt);
        }
    }
    if let Some(ref ri) = params.resource_id {
        if !ri.is_empty() {
            body["resource_id"] = serde_json::json!(ri);
        }
    }
    Ok(client.post::<serde_json::Value, _>("/api/support/tickets/", &body, &account_id).await?)
}

/// Append a reply message to an existing support ticket thread.
#[tauri::command]
pub async fn post_ticket_message(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    ticket_id: i64,
    message_type: String,
    body: String,
) -> Result<serde_json::Value, AppError> {
    info!(ticket_id = ticket_id, "Posting ticket message");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/support/tickets/{ticket_id}/messages/");
    let payload = serde_json::json!({
        "message_type": message_type,
        "body": body,
    });
    Ok(client.post::<serde_json::Value, _>(&path, &payload, &account_id).await?)
}

/// Upload an attachment to a ticket message.
///
/// Accepts a file path (on disk) — the frontend writes browser File objects to
/// temp first, then passes the path here. Rust handles the multipart upload
/// with the auth token and API base URL from config.
///
/// Replaces the direct `fetch()` in `useUploadTicketAttachment.ts` that had
/// the API URL hardcoded and the auth token exposed to the frontend.
#[derive(Serialize, Deserialize)]
pub struct TicketAttachment {
    pub id: serde_json::Value,
    pub filename: String,
    pub file: String,
    pub uploaded_at: String,
}

#[tauri::command]
pub async fn upload_ticket_attachment(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    ticket_id: String,
    message_id: String,
    file_path: String,
    filename: Option<String>,
) -> Result<TicketAttachment, AppError> {
    info!(ticket_id = %ticket_id, message_id = %message_id, "Uploading ticket attachment");

    // Read file from disk; the multipart/auth wiring is shared (see
    // `upload_attachment_bytes`) with the log-bundle command.
    let path = std::path::Path::new(&file_path);
    let file_bytes = tokio::fs::read(path)
        .await
        .map_err(|e| AppError::Other(format!("Failed to read attachment file: {e}")))?;

    // `to_string_lossy` (not `to_str().unwrap_or("attachment")`) so a non-UTF-8
    // final path component (legal on macOS/Linux) degrades to a recognizable
    // lossy name keeping the extension, instead of collapsing every such file to
    // the generic "attachment".
    let file_name = filename.unwrap_or_else(|| {
        path.file_name()
            .map_or_else(|| "attachment".to_string(), |n| n.to_string_lossy().into_owned())
    });

    upload_attachment_bytes(&state, &account_id, &ticket_id, &message_id, file_bytes, file_name).await
}

/// Shared core for uploading attachment bytes to a ticket message.
///
/// Handles auth, numeric-ID validation (guards against URL path injection),
/// the multipart POST, and response parsing. Both [`upload_ticket_attachment`]
/// (a file read from disk) and `attach_logs_to_ticket` (an in-memory log zip)
/// call this so the auth + multipart wiring lives in exactly one place.
///
/// `ticket_id`/`message_id` MUST be the decimal IDs the support API returned;
/// anything else is rejected as `Validation` before a request is made.
pub(crate) async fn upload_attachment_bytes(
    state: &tauri::State<'_, crate::app_state::AppState>,
    account_id: &crate::app_state::SessionAccount,
    ticket_id: &str,
    message_id: &str,
    file_bytes: Vec<u8>,
    file_name: String,
) -> Result<TicketAttachment, AppError> {
    let pool = state.pool()?;
    let token = crate::api::client::get_auth_token_for_account(pool, account_id)
        .await
        .map_err(|e| AppError::Other(format!("Auth token error: {e}")))?;

    // Validate IDs are numeric to prevent URL path injection
    if !ticket_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation("Invalid ticket ID".into()));
    }
    if !message_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation("Invalid message ID".into()));
    }

    let base = crate::api::client::api_base_url();
    let url = format!(
        "{}/api/support/tickets/{}/messages/{}/attachments/",
        base.trim_end_matches('/'),
        ticket_id,
        message_id
    );

    // Build multipart form
    let file_part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| AppError::Other(format!("MIME error: {e}")))?;

    let mut form = reqwest::multipart::Form::new().part("file", file_part);
    form = form.text("filename", file_name);

    let resp = state
        .api_client
        .post(&url)
        .header("Authorization", format!("Token {token}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Upload request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("Upload failed (HTTP {status}): {text}")));
    }

    resp.json::<TicketAttachment>()
        .await
        .map_err(|e| AppError::Other(format!("Failed to parse attachment response: {e}")))
}

/// Partially update a support ticket (e.g. change status or priority).
#[tauri::command]
pub async fn update_support_ticket(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    ticket_id: i64,
    updates: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/support/tickets/{ticket_id}/");
    Ok(client.patch::<serde_json::Value, _>(&path, &updates, &account_id).await?)
}
