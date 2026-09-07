//! SSH key management commands.
//!
//! Proxies CRUD operations for the user's SSH public keys stored on the
//! Hippius API. Keys are referenced by ID when provisioning new VMs.

use crate::api::client::ApiClient;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use tracing::info;

/// A single SSH public key registered with the Hippius API.
#[derive(Serialize, Deserialize)]
pub struct SSHKey {
    pub id: i64,
    pub name: String,
    pub public_key: String,
    pub fingerprint: Option<String>,
    pub created: Option<String>,
    pub last_used: Option<String>,
}

/// Paginated response wrapper for SSH key listings.
#[derive(Serialize, Deserialize)]
pub struct SSHKeysResponse {
    pub count: i64,
    pub next: Option<String>,
    pub previous: Option<String>,
    pub results: Vec<SSHKey>,
}

const DEFAULT_SSH_LIST_PAGE: i64 = 1;
const DEFAULT_SSH_LIST_PAGE_SIZE: i64 = 10;

/// Query pairs for `GET /api/ssh-keys/`. Extracted so the default page/size
/// (and that search/ordering are omitted when unset) can be unit-tested
/// without a live API — this IPC stays reachable while the VM UI is gated.
fn ssh_keys_list_query(page: Option<i64>, page_size: Option<i64>, search: Option<&str>, ordering: Option<&str>) -> Vec<(String, String)> {
    let mut params = vec![
        ("page".into(), page.unwrap_or(DEFAULT_SSH_LIST_PAGE).to_string()),
        ("page_size".into(), page_size.unwrap_or(DEFAULT_SSH_LIST_PAGE_SIZE).to_string()),
    ];
    if let Some(s) = search {
        params.push(("search".into(), s.to_string()));
    }
    if let Some(o) = ordering {
        params.push(("ordering".into(), o.to_string()));
    }
    params
}

/// List SSH keys with optional search, ordering, and pagination.
#[tauri::command]
pub async fn list_ssh_keys(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    page: Option<i64>,
    page_size: Option<i64>,
    search: Option<String>,
    ordering: Option<String>,
) -> Result<SSHKeysResponse, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let query = ssh_keys_list_query(page, page_size, search.as_deref(), ordering.as_deref());
    let params: Vec<(&str, &str)> = query.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    Ok(client.get_with_params("/api/ssh-keys/", &params, &account_id).await?)
}

/// Register a new SSH public key with the Hippius API.
#[tauri::command]
pub async fn create_ssh_key(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    name: String,
    public_key: String,
) -> Result<SSHKey, AppError> {
    info!(name = %name, "Creating SSH key");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let body = serde_json::json!({
        "name": name,
        "public_key": public_key,
    });
    Ok(client.post("/api/ssh-keys/", &body, &account_id).await?)
}

/// Remove an SSH key by ID. Active VMs using this key are unaffected.
#[tauri::command]
pub async fn delete_ssh_key(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    key_id: i64,
) -> Result<(), AppError> {
    info!(key_id = key_id, "Deleting SSH key");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/ssh-keys/{key_id}/");
    Ok(client.delete(&path, &account_id).await?)
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_SSH_LIST_PAGE, DEFAULT_SSH_LIST_PAGE_SIZE, SSHKey, ssh_keys_list_query};

    #[test]
    fn list_query_defaults_to_page_one_size_ten() {
        let query = ssh_keys_list_query(None, None, None, None);
        assert_eq!(
            query,
            vec![
                ("page".into(), DEFAULT_SSH_LIST_PAGE.to_string()),
                ("page_size".into(), DEFAULT_SSH_LIST_PAGE_SIZE.to_string()),
            ]
        );
    }

    #[test]
    fn list_query_omits_unset_search_and_ordering() {
        let query = ssh_keys_list_query(Some(2), Some(25), None, None);
        assert_eq!(query.len(), 2);
        assert_eq!(query[0], ("page".into(), "2".into()));
        assert_eq!(query[1], ("page_size".into(), "25".into()));
    }

    #[test]
    fn list_query_includes_search_and_ordering_when_set() {
        let query = ssh_keys_list_query(None, None, Some("laptop"), Some("-created"));
        assert!(query.iter().any(|(k, v)| k == "search" && v == "laptop"));
        assert!(query.iter().any(|(k, v)| k == "ordering" && v == "-created"));
    }

    #[test]
    fn ssh_key_deserializes_when_optional_fields_are_absent() {
        let key: SSHKey = serde_json::from_value(serde_json::json!({
            "id": 7,
            "name": "studio",
            "public_key": "ssh-ed25519 AAAA",
        }))
        .expect("parse");
        assert_eq!(key.id, 7);
        assert_eq!(key.fingerprint, None);
        assert_eq!(key.created, None);
    }
}
