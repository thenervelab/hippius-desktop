//! SSH key management commands.
//!
//! Proxies CRUD operations for the user's SSH public keys stored on the
//! Hippius API. Keys are referenced by ID when provisioning new VMs.

use crate::api_client::ApiClient;
use serde::{Deserialize, Serialize};
use tracing::info;

/// A single SSH public key registered with the Hippius API.
#[derive(Serialize, Deserialize)]
pub struct SSHKey {
    pub id: i64,
    pub name: String,
    pub public_key: String,
    pub fingerprint: Option<String>,
    pub created_at: Option<String>,
}

/// Paginated response wrapper for SSH key listings.
#[derive(Serialize, Deserialize)]
pub struct SSHKeysResponse {
    pub count: i64,
    pub next: Option<String>,
    pub previous: Option<String>,
    pub results: Vec<SSHKey>,
}

/// List SSH keys with optional search, ordering, and pagination.
#[tauri::command]
pub async fn list_ssh_keys(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    page: Option<i64>,
    page_size: Option<i64>,
    search: Option<String>,
    ordering: Option<String>,
) -> Result<SSHKeysResponse, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let mut params = Vec::new();
    let page_str = page.unwrap_or(1).to_string();
    let size_str = page_size.unwrap_or(10).to_string();
    params.push(("page", page_str.as_str()));
    params.push(("page_size", size_str.as_str()));
    if let Some(ref s) = search {
        params.push(("search", s.as_str()));
    }
    if let Some(ref o) = ordering {
        params.push(("ordering", o.as_str()));
    }

    client
        .get_with_params("/api/ssh-keys/", &params, &account_id)
        .await
        .map_err(|e| e.to_string())
}

/// Register a new SSH public key with the Hippius API.
#[tauri::command]
pub async fn create_ssh_key(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    name: String,
    public_key: String,
) -> Result<SSHKey, String> {
    info!(name = %name, "Creating SSH key");
    let client = ApiClient::new(state.pool()?.clone());
    let body = serde_json::json!({
        "name": name,
        "public_key": public_key,
    });
    client.post("/api/ssh-keys/", &body, &account_id).await.map_err(|e| e.to_string())
}

/// Remove an SSH key by ID. Active VMs using this key are unaffected.
#[tauri::command]
pub async fn delete_ssh_key(state: tauri::State<'_, crate::app_state::AppState>, account_id: String, key_id: i64) -> Result<(), String> {
    info!(key_id = key_id, "Deleting SSH key");
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/ssh-keys/{key_id}/");
    client.delete(&path, &account_id).await.map_err(|e| e.to_string())
}
