//! Tauri IPC commands for browsing remote folder contents and downloading
//! individual files without starting a full sync.
//!
//! These commands enable two key user flows:
//! 1. **Browse before sync** — view a remote folder's file tree to decide
//!    which files to include/exclude before syncing.
//! 2. **One-off download** — download a single file from a remote folder
//!    without configuring sync at all.
//!
//! Decryption of file paths and content uses the same key derivation chain
//! as the sync engine (`master_mnemonic → derive_folder_mnemonic → seed[..32]`)
//! but does NOT require an initialized Drive instance.

use crate::app_state::AppState;
use crate::error::AppError;
use crate::utils::account_key::account_key;
use crate::utils::auth_tokens::get_api_token;
use hcfs_client::client::HcfsClientConfig;
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqlitePool;
use std::path::PathBuf;
use tracing::{debug, error, info, warn};
use zeroize::Zeroize;

// ─── Types ──────────────────────────────────────────────────────────────────

/// A single file entry returned by `list_remote_folder_files`.
/// The frontend builds the tree structure from the flat `path` field.
#[derive(serde::Serialize, Clone, Debug)]
pub struct RemoteFileInfo {
    /// Hex-encoded path_hash — used as `file_id` for download.
    pub file_id: String,
    /// Decrypted relative path, e.g. `"photos/vacation/beach.jpg"`.
    /// Falls back to `name` if decryption fails.
    pub path: String,
    /// Basename, e.g. `"beach.jpg"`.
    pub name: String,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Arion content hash (hex), if available.
    pub arion_hash: Option<String>,
    /// Unix timestamp when first uploaded.
    pub created_at: i64,
    /// Unix timestamp when last updated.
    pub updated_at: i64,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Derive the encryption key for a folder from the master mnemonic.
///
/// Chain: `master → to_seed("") → SHA256(seed[..32] || label) → folder_mnemonic
///        → to_seed("")[..32] → encryption_key`
///
/// This replicates the key derivation in `Drive::unlock()` without requiring
/// a Drive instance.
fn derive_encryption_key(master_mnemonic: &str, label: &str) -> Result<[u8; 32], crate::error::AppError> {
    use bip39::Mnemonic;
    use std::str::FromStr;

    // Step 1: derive folder mnemonic (same as syncing.rs::derive_folder_mnemonic)
    let master = Mnemonic::from_str(master_mnemonic).map_err(|e| crate::error::AppError::Crypto(format!("Invalid master mnemonic: {e}")))?;
    let mut master_seed = master.to_seed("");

    let mut hasher = Sha256::new();
    hasher.update(&master_seed[..32]);
    hasher.update(label.as_bytes());
    master_seed.zeroize();
    let mut folder_entropy: [u8; 32] = hasher.finalize().into();

    let folder_mnemonic = Mnemonic::from_entropy(&folder_entropy).map_err(|e| {
        folder_entropy.zeroize();
        crate::error::AppError::Crypto(format!("Failed to derive folder mnemonic: {e}"))
    })?;
    folder_entropy.zeroize();

    // Step 2: derive encryption key from folder mnemonic seed
    let mut folder_seed = folder_mnemonic.to_seed("");
    let mut key = [0u8; 32];
    key.copy_from_slice(&folder_seed[..32]);
    folder_seed.zeroize();

    Ok(key)
}

use super::syncing::folder_hash;

/// Path to `~/.hippius/drives/<account_key>/master_enc_mnemonic.json`.
fn master_mnemonic_path(account_id: &str) -> Result<PathBuf, crate::error::AppError> {
    let home = dirs::home_dir().ok_or(crate::error::AppError::Validation("Could not determine home directory".into()))?;
    let key = account_key(account_id);
    Ok(home.join(".hippius").join("drives").join(key).join("master_enc_mnemonic.json"))
}

/// Read the HCFS server URL from DB, falling back to the default.
async fn get_server_url(pool: &SqlitePool, account_id: &str) -> Result<String, crate::error::AppError> {
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

/// Read the drive password from DB.
async fn get_password(pool: &SqlitePool, account_id: &str) -> Result<String, crate::error::AppError> {
    let owner = account_key(account_id);
    let result: Option<(String,)> = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;
    result
        .map(|(p,)| p)
        .ok_or(crate::error::AppError::NotReady(crate::error::NotReadyKind::ConfigMissing))
}

/// Recover the master mnemonic and derive the encryption key for `label`.
async fn encryption_key_for_label(pool: &SqlitePool, account_id: &str, label: &str) -> Result<[u8; 32], crate::error::AppError> {
    let password = get_password(pool, account_id).await?;
    let master_path = master_mnemonic_path(account_id)?;

    let mut master_mnemonic = hcfs_client::auth::recover_mnemonic(&master_path, &password)
        .map_err(|e| crate::error::AppError::Hcfs(format!("Failed to recover master mnemonic: {e}")))?
        .to_string();

    let key = derive_encryption_key(&master_mnemonic, label);
    master_mnemonic.zeroize();
    key
}

/// Build an `HcfsClient` for the given account + folder label.
async fn build_client(pool: &SqlitePool, account_id: &str, label: &str) -> Result<hcfs_client::client::HcfsClient, crate::error::AppError> {
    let server_url = get_server_url(pool, account_id).await?;
    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or(AppError::Auth("No authentication token found. Please log in again.".into()))?;

    let fhash = folder_hash(label);
    let config = HcfsClientConfig {
        base_url: server_url,
        api_key: "Arion".to_string(),
        bearer_token,
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: fhash,
    };

    hcfs_client::client::HcfsClient::new(config).map_err(|e| AppError::Hcfs(format!("Failed to create HCFS client: {e}")))
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all files in a remote folder, decrypting their paths.
///
/// Returns a flat list of `RemoteFileInfo`; the frontend builds the tree
/// by splitting on `/`.
#[tauri::command]
pub async fn list_remote_folder_files(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
) -> Result<Vec<RemoteFileInfo>, crate::error::AppError> {
    info!(
        account_id = %account_id,
        label = %label,
        "Listing remote folder files"
    );

    let pool = state.pool()?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    let remote_files = client.get_all_files(&account_id, &fhash, None::<fn(u64, u64)>).await.map_err(|e| {
        error!(label = %label, "Failed to fetch remote files: {e}");
        AppError::Hcfs(format!("Failed to fetch remote files: {e}"))
    })?;

    info!(
        label = %label,
        count = remote_files.len(),
        "Fetched remote files, decrypting paths"
    );

    let mut files = Vec::with_capacity(remote_files.len());
    for entry in remote_files {
        let file_id = hex::encode(entry.path_hash);

        // Try to decrypt the encrypted path
        let decrypted_path = if entry.encrypted_path.is_empty() {
            None
        } else {
            match hcfs_client::crypto::decrypt_small(&entry.encrypted_path, &encryption_key) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(path) => {
                        // Strip leading slash if present
                        let path = path.strip_prefix('/').unwrap_or(&path).to_string();
                        Some(path)
                    }
                    Err(e) => {
                        warn!(file_id = %file_id, "Decrypted path is not valid UTF-8: {e}");
                        None
                    }
                },
                Err(e) => {
                    debug!(file_id = %file_id, "Failed to decrypt path: {e}");
                    None
                }
            }
        };

        // Use decrypted path, fall back to plaintext file_name, fall back to file_id
        let (path, name) = if let Some(ref p) = decrypted_path {
            let basename = p.rsplit('/').next().unwrap_or(p).to_string();
            (p.clone(), basename)
        } else {
            let fallback_name = entry.file_name.unwrap_or_else(|| format!("file_{}", &file_id[..16]));
            (fallback_name.clone(), fallback_name)
        };

        files.push(RemoteFileInfo {
            file_id,
            path,
            name,
            size_bytes: entry.size_bytes,
            arion_hash: entry.arion_hash,
            created_at: entry.created_at,
            updated_at: entry.updated_at,
        });
    }

    info!(
        label = %label,
        total = files.len(),
        "Remote folder file listing complete"
    );
    Ok(files)
}

/// Progress payload emitted during one-off file downloads.
#[derive(serde::Serialize, Clone)]
struct DownloadProgressPayload {
    file_id: String,
    bytes_downloaded: u64,
    total_bytes: u64,
}

/// Download a single file from a remote folder, decrypt it, and write to
/// `output_path`. Does NOT require an active sync/drive for this folder.
/// Emits `oneoff_download_progress` events so the frontend can show progress.
#[tauri::command]
pub async fn download_remote_file(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    file_id: String,
    output_path: String,
) -> Result<(), crate::error::AppError> {
    use tauri::Emitter;

    info!(
        label = %label,
        file_id = %file_id,
        output_path = %output_path,
        "Downloading remote file"
    );

    let pool = state.pool()?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    // Download encrypted blob to a temp file
    let output = PathBuf::from(&output_path);
    let temp_path = output.with_extension("hippius_download_tmp");

    let progress_file_id = file_id.clone();
    let progress_app = app.clone();
    let download_result = client
        .download(
            &account_id,
            &fhash,
            &file_id,
            &temp_path,
            Some(move |bytes: u64, total: u64| {
                let _ = progress_app.emit(
                    "oneoff_download_progress",
                    DownloadProgressPayload {
                        file_id: progress_file_id.clone(),
                        bytes_downloaded: bytes,
                        total_bytes: total,
                    },
                );
            }),
            0, // resume_offset: start from beginning
        )
        .await;

    match download_result {
        Ok(_) => {
            debug!(file_id = %file_id, "Encrypted file downloaded, decrypting");
        }
        Err(e) => {
            // Clean up temp file on download failure
            let _ = std::fs::remove_file(&temp_path);
            return Err(AppError::Hcfs(format!("Failed to download file: {e}")));
        }
    }

    // Decrypt the downloaded file
    let decrypt_result = {
        let mut input = std::fs::File::open(&temp_path)?;
        let mut output_file = std::fs::File::create(&output)?;

        hcfs_client::crypto::decrypt_stream(&mut input, &mut output_file, &encryption_key, None, None::<fn(u64, u64)>)
    };

    // Always clean up the temp file
    let _ = std::fs::remove_file(&temp_path);

    match decrypt_result {
        Ok(bytes) => {
            info!(
                file_id = %file_id,
                decrypted_bytes = bytes,
                "File downloaded and decrypted successfully"
            );
            Ok(())
        }
        Err(e) => {
            // Clean up partial output on decrypt failure
            let _ = std::fs::remove_file(&output_path);
            Err(AppError::Hcfs(format!("Failed to decrypt file: {e}")))
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_hash_is_deterministic() {
        let h1 = folder_hash("Documents");
        let h2 = folder_hash("Documents");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 16);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn folder_hash_differs_by_label() {
        assert_ne!(folder_hash("Documents"), folder_hash("Photos"));
    }

    #[test]
    fn derive_encryption_key_is_deterministic() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
        let key1 = derive_encryption_key(mnemonic, "Documents").unwrap();
        let key2 = derive_encryption_key(mnemonic, "Documents").unwrap();
        assert_eq!(key1, key2);
    }

    #[test]
    fn derive_encryption_key_differs_by_label() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
        let key1 = derive_encryption_key(mnemonic, "Documents").unwrap();
        let key2 = derive_encryption_key(mnemonic, "Photos").unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn derive_encryption_key_invalid_mnemonic() {
        let result = derive_encryption_key("not a valid mnemonic", "Documents");
        assert!(result.is_err());
    }

    #[test]
    fn remote_file_info_serializes() {
        let info = RemoteFileInfo {
            file_id: "abcd1234".to_string(),
            path: "photos/beach.jpg".to_string(),
            name: "beach.jpg".to_string(),
            size_bytes: 4200,
            arion_hash: Some("deadbeef".to_string()),
            created_at: 1_700_000_000,
            updated_at: 1_700_000_100,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("photos/beach.jpg"));
        assert!(json.contains("4200"));
    }
}
