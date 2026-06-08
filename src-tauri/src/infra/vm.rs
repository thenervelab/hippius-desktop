//! VM infrastructure management commands.
//!
//! Proxies all VM API calls through Rust so the frontend never makes
//! direct fetch() calls. Auth tokens are injected automatically.

use crate::api::client::ApiClient;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use tracing::info;

/// Hardware configuration template for VM provisioning (vCPUs, RAM, disk).
///
/// `name` is the short flavor identifier (e.g. "spark", "vault") used by the
/// frontend to match flavors and assign UI categories. `credits_per_hour`
/// is forwarded as JSON to preserve whichever shape the upstream API uses
/// (number or string) — both the Templates tab and instance-row lookup
/// just stringify it for display.
#[derive(Serialize, Deserialize)]
pub struct VMFlavor {
    pub id: i64,
    pub name: String,
    pub display_name: String,
    pub cpu_cores: i64,
    pub memory_mb: i64,
    pub data_disk_gb: i64,
    pub credits_per_hour: serde_json::Value,
    pub description: Option<String>,
}

/// Base OS image available for VM creation.
#[derive(Serialize, Deserialize)]
pub struct VMImage {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
}

/// Pre-configured application stack that can be layered onto a VM image.
///
/// `logo_url` carries the absolute https URL the upstream API returns for the
/// app's brand icon — without this field, serde silently drops it on the way
/// through Rust and the dropdown trigger/options render the generic fallback
/// glyph instead of the real per-app logo.
#[derive(Serialize, Deserialize)]
pub struct VMApplication {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub logo_url: Option<String>,
}

/// A running or stopped VM instance with its current status and metadata.
///
/// Uses `serde(flatten)` for `extra` so that new API fields are forwarded
/// to the frontend without requiring a backend release.
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

/// List available VM hardware flavors for the account's billing tier.
#[tauri::command]
pub async fn list_vm_flavors(state: tauri::State<'_, crate::app_state::AppState>, account_id: crate::app_state::SessionAccount) -> Result<Vec<VMFlavor>, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    Ok(client.get("/api/infrastructure/vm/flavors/", &account_id).await?)
}

/// List available base OS images for VM creation.
#[tauri::command]
pub async fn list_vm_images(state: tauri::State<'_, crate::app_state::AppState>, account_id: crate::app_state::SessionAccount) -> Result<Vec<VMImage>, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    Ok(client.get("/api/infrastructure/vm/images/", &account_id).await?)
}

/// List pre-configured application stacks that can be installed on a VM.
#[tauri::command]
pub async fn list_vm_applications(state: tauri::State<'_, crate::app_state::AppState>, account_id: crate::app_state::SessionAccount) -> Result<Vec<VMApplication>, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    Ok(client.get("/api/infrastructure/vm/applications/", &account_id).await?)
}

/// List all VM instances owned by the account.
#[tauri::command]
pub async fn list_vm_instances(state: tauri::State<'_, crate::app_state::AppState>, account_id: crate::app_state::SessionAccount) -> Result<Vec<VMInstance>, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    Ok(client.get("/api/infrastructure/vm/instances/", &account_id).await?)
}

/// Fetch a single VM instance by ID, including its current IP addresses.
#[tauri::command]
pub async fn get_vm_instance(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    instance_id: i64,
) -> Result<VMInstance, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/");
    Ok(client.get(&path, &account_id).await?)
}

/// Frontend payload for spawning a new VM instance.
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

/// Provision a new VM with the specified flavor, image, and SSH key.
#[tauri::command]
pub async fn create_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    params: CreateVMParams,
) -> Result<serde_json::Value, AppError> {
    // Enforce credit eligibility at the IPC boundary. Refuses to call the spawn
    // endpoint when the user has fewer than 10 credits (the authoritative gate).
    // It ALSO refuses on a confirmed zero chain balance, but that pre-flight is
    // best-effort: if the substrate node is unreachable the chain check is
    // skipped (logged, not enforced) and the spawn endpoint is the backstop —
    // see `crate::billing::eligibility::thresholds` and `chain_free_balance`.
    // VM creation has no upload payload; pass `bytes = 0` so the bytes-priced
    // layer is a no-op and the gate falls back to the static `VM_CREATION` (10).
    crate::billing::eligibility::require_eligible(&state, &account_id, crate::billing::eligibility::InsufficientCreditsAction::VmCreation, 0).await?;

    info!(
        name = %params.name,
        flavor_id = params.flavor_id,
        image_id = params.image_id,
        "Creating VM instance"
    );
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let body = CreateVMBody {
        flavor_id: params.flavor_id,
        image_id: params.image_id,
        ssh_public_key: params.ssh_public_key,
        name: params.name,
        application_id: params.application_id,
    };
    Ok(client.post("/api/infrastructure/vm/spawn/", &body, &account_id).await?)
}

/// Hard-reboot a running VM instance.
#[tauri::command]
pub async fn reboot_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    instance_id: i64,
) -> Result<serde_json::Value, AppError> {
    info!(instance_id = instance_id, "Rebooting VM");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/reboot/");
    Ok(client.post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id).await?)
}

/// Power on a stopped VM instance.
#[tauri::command]
pub async fn start_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    instance_id: i64,
) -> Result<serde_json::Value, AppError> {
    info!(instance_id = instance_id, "Starting VM");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/start/");
    Ok(client.post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id).await?)
}

/// Gracefully shut down a running VM instance (preserves disk).
#[tauri::command]
pub async fn stop_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    instance_id: i64,
) -> Result<serde_json::Value, AppError> {
    info!(instance_id = instance_id, "Stopping VM");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/stop/");
    Ok(client.post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id).await?)
}

/// Permanently destroy a VM instance and release its resources.
#[tauri::command]
pub async fn terminate_vm(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    instance_id: i64,
) -> Result<serde_json::Value, AppError> {
    info!(instance_id = instance_id, "Terminating VM");
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());
    let path = format!("/api/infrastructure/vm/instances/{instance_id}/terminate/");
    Ok(client.post::<serde_json::Value, _>(&path, &serde_json::json!({}), &account_id).await?)
}
