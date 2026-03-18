//! VM infrastructure management commands.
//!
//! Proxies all VM API calls through Rust so the frontend never makes
//! direct fetch() calls. Auth tokens are injected automatically.

use crate::api_client::ApiClient;
use serde::{Deserialize, Serialize};
use tracing::info;

// ---------------------------------------------------------------------------
// Response types — match the API JSON shapes
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct VMFlavor {
    pub id: i64,
    pub name: String,
    pub vcpus: i64,
    pub memory: i64,
    pub disk: i64,
    pub credits_per_hour: String,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct VMImage {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct VMApplication {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct VMInstance {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub flavor: Option<serde_json::Value>,
    pub image: Option<serde_json::Value>,
    pub created_at: Option<String>,
    pub ip_addresses: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
pub struct VMActionResponse {
    #[serde(flatten)]
    pub data: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_vm_flavors(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<Vec<VMFlavor>, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get("/api/infrastructure/vm/flavors/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_vm_images(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<Vec<VMImage>, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get("/api/infrastructure/vm/images/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_vm_applications(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<Vec<VMApplication>, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get("/api/infrastructure/vm/applications/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_vm_instances(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<Vec<VMInstance>, String> {
    let client = ApiClient::new(state.pool()?.clone());
    client
        .get("/api/infrastructure/vm/instances/", &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_vm_instance(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    instance_id: i64,
) -> Result<VMInstance, String> {
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/");
    client
        .get(&path, &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVMParams {
    pub flavor_id: i64,
    pub image_id: i64,
    pub ssh_public_key: String,
    pub name: String,
    pub application_id: Option<i64>,
}

#[derive(Serialize)]
struct CreateVMBody {
    flavor_id: i64,
    image_id: i64,
    ssh_public_key: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    application_id: Option<i64>,
}

#[tauri::command]
pub async fn create_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    params: CreateVMParams,
) -> Result<serde_json::Value, String> {
    info!(
        name = %params.name,
        flavor_id = params.flavor_id,
        image_id = params.image_id,
        "Creating VM instance"
    );
    let client = ApiClient::new(state.pool()?.clone());
    let body = CreateVMBody {
        flavor_id: params.flavor_id,
        image_id: params.image_id,
        ssh_public_key: params.ssh_public_key,
        name: params.name,
        application_id: params.application_id,
    };
    client
        .post("/api/infrastructure/vm/spawn/", &body, &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reboot_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    instance_id: i64,
) -> Result<serde_json::Value, String> {
    info!(instance_id = instance_id, "Rebooting VM");
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/reboot/");
    client
        .post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    instance_id: i64,
) -> Result<serde_json::Value, String> {
    info!(instance_id = instance_id, "Starting VM");
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/start/");
    client
        .post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    instance_id: i64,
) -> Result<serde_json::Value, String> {
    info!(instance_id = instance_id, "Stopping VM");
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/stop/");
    client
        .post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminate_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    instance_id: i64,
) -> Result<serde_json::Value, String> {
    info!(instance_id = instance_id, "Terminating VM");
    let client = ApiClient::new(state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/terminate/");
    client
        .post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id)
        .await
        .map_err(|e| e.to_string())
}
