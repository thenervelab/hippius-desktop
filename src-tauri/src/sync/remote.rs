//! Tauri IPC commands for browsing remote folder contents and downloading
//! individual files without starting a full sync.
//!
//! Delegates to `hcfs_client::drive::remote` for the core logic.
//! This module handles DB lookups and Tauri event emission.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::drive::keys::folder_hash;
use hcfs_client::drive::remote::RemoteFileInfo;
use sqlx::sqlite::SqlitePool;
use std::path::PathBuf;
use tracing::{error, info};
use zeroize::Zeroize;

// ─── DB Helpers (desktop-specific) ─────────────────────────────────────────

fn master_mnemonic_path(account_id: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or(AppError::Validation("Could not determine home directory".into()))?;
    let key = account_key(account_id);
    Ok(home.join(".hippius").join("drives").join(key).join("master_enc_mnemonic.json"))
}

async fn get_server_url(pool: &SqlitePool, account_id: &str) -> Result<String> {
    let owner = account_key(account_id);
    let result: Option<(String,)> = sqlx::query_as("SELECT server_url FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;
    match result {
        Some((url,)) if !url.is_empty() => Ok(url),
        _ => Ok("https://arion.hippius.com".to_string()),
    }
}

/// Derive the per-folder encryption key from the master mnemonic.
///
/// `mnemonic` is the user's session BIP-39 mnemonic, needed by
/// `get_drive_password` to decrypt the `hcfs_config.drive_password` row
/// when its `encryption_version = 1`. Without this, the raw base64
/// ciphertext from the column would be passed to `recover_mnemonic`
/// as if it were the plaintext password — which fails with
/// "Decryption failed - wrong password?" and was the long-standing bug
/// behind the "Failed to load remote files" error in the browse-folder
/// dialog (and the matching failure in `download_remote_file`).
async fn encryption_key_for_label(pool: &SqlitePool, account_id: &str, label: &str, mnemonic: &str) -> Result<[u8; 32]> {
    let password = crate::sync::config::get_drive_password(pool, account_id, Some(mnemonic)).await?;
    let master_path = master_mnemonic_path(account_id)?;
    let mut master_mnemonic = hcfs_client::auth::recover_mnemonic(&master_path, &password)
        .map_err(|e| AppError::Hcfs(format!("Failed to recover master mnemonic: {e}")))?
        .to_string();
    let key = hcfs_client::drive::remote::derive_encryption_key(&master_mnemonic, label).map_err(|e| AppError::Crypto(e.to_string()));
    master_mnemonic.zeroize();
    key
}

/// Pull the active session mnemonic out of `AppState.auth`. Returns
/// `NoEncryptionKey` if no mnemonic is loaded (e.g. session restored
/// from disk without keychain rehydration — see the cold-start
/// "Mnemonic required" issue).
fn session_mnemonic(state: &AppState) -> Result<String> {
    let auth = state.auth.lock().map_err(|e| AppError::Other(format!("auth lock poisoned: {e}")))?;
    auth.mnemonic
        .as_ref()
        .map(|z| z.as_str().to_string())
        .ok_or(AppError::NotReady(crate::error::NotReadyKind::NoEncryptionKey))
}

async fn build_client(pool: &SqlitePool, account_id: &str, label: &str) -> Result<hcfs_client::client::HcfsClient> {
    let server_url = get_server_url(pool, account_id).await?;
    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or(AppError::Auth("No authentication token found. Please log in again.".into()))?;
    let config = HcfsClientConfig {
        base_url: server_url,
        bearer_token,
        accept_invalid_certs: crate::sync::config::ACCEPT_INVALID_CERTS,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: folder_hash(label),
    };
    hcfs_client::client::HcfsClient::new(config).map_err(|e| AppError::Hcfs(format!("Failed to create HCFS client: {e}")))
}

// ─── Tauri Commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_remote_folder_files(state: tauri::State<'_, AppState>, account_id: String, label: String) -> Result<Vec<RemoteFileInfo>> {
    info!(account_id = %account_id, label = %label, "Listing remote folder files");
    let pool = state.pool()?;
    let mnemonic = session_mnemonic(&state)?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label, &mnemonic).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    hcfs_client::drive::remote::list_remote_files(&client, &account_id, &fhash, &encryption_key)
        .await
        .map_err(|e| {
            error!(label = %label, "Failed to list remote files: {e}");
            AppError::Hcfs(e.to_string())
        })
}

#[tauri::command]
pub async fn download_remote_file(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    file_id: String,
    output_path: String,
) -> Result<()> {
    use tauri::Emitter;
    info!(label = %label, file_id = %file_id, "Downloading remote file");

    let pool = state.pool()?;
    let mnemonic = session_mnemonic(&state)?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label, &mnemonic).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    let progress_file_id = file_id.clone();
    let progress_app = app.clone();

    hcfs_client::drive::remote::download_remote_file(
        &client,
        &account_id,
        &fhash,
        &file_id,
        &PathBuf::from(&output_path),
        &encryption_key,
        Some(move |bytes: u64, total: u64| {
            let _ = progress_app.emit(
                "oneoff_download_progress",
                serde_json::json!({
                    "file_id": progress_file_id,
                    "bytes_downloaded": bytes,
                    "total_bytes": total,
                }),
            );
        }),
    )
    .await
    .map_err(|e| AppError::Hcfs(e.to_string()))?;

    info!(file_id = %file_id, "File downloaded and decrypted successfully");
    Ok(())
}
