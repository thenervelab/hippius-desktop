//! HCFS configuration CRUD operations.
//!
//! Contains commands and helpers for reading and writing HCFS server
//! configuration (server URL, drive password, bearer token) in the database.
//! Drive passwords are encrypted at rest using ChaCha20-Poly1305 with an
//! HKDF-derived key from the user's BIP-39 mnemonic.

use tracing::debug;

use crate::auth::account_key::account_key;
use crate::crypto::store;
use crate::error::Result;
use hcfs_client::client::HcfsClientConfig;
use sqlx::sqlite::SqlitePool;

/// Whether HCFS clients should accept invalid TLS certificates.
///
/// `true` only in debug builds so local development against a self-signed
/// HCFS server works without manual trust store setup. Release builds verify
/// certificates the same way every other `reqwest::Client` in the codebase
/// does, protecting bearer tokens and sync metadata from MITM tampering on
/// the path to `arion.hippius.com`.
pub(crate) const ACCEPT_INVALID_CERTS: bool = cfg!(debug_assertions);

/// HCFS server configuration returned by `get_hcfs_config`.
#[derive(serde::Serialize, Clone)]
pub struct HcfsConfigResult {
    pub server_url: String,
    pub has_password: bool,
}

/// Loaded sync configuration from the database for a single label.
pub(crate) struct SyncConfig {
    pub sync_path: String,
    pub drive_password: String,
    pub server_url: String,
}

#[tauri::command]
pub async fn save_hcfs_config(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    server_url: String,
    drive_password: String,
) -> Result<()> {
    let db = state.pool()?;
    let owner = account_key(&account_id);

    let (stored_password, enc_version) = {
        let guard = state.auth.lock()?;
        match guard.mnemonic.as_deref() {
            Some(m) => {
                let key = store::drive_password_key(m, &account_id)?;
                let encrypted = store::encrypt(&key, &drive_password)?;
                (encrypted, 1i32)
            }
            None => (drive_password, 0i32),
        }
    };

    sqlx::query(
        r"
        INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password,
            encryption_version = excluded.encryption_version,
            updated_at = CURRENT_TIMESTAMP
        ",
    )
    .bind(&owner)
    .bind(&server_url)
    .bind(&stored_password)
    .bind(enc_version)
    .execute(db)
    .await?;

    Ok(())
}

/// Internal helper that accepts a pool reference directly.
/// Used by both the Tauri command and other internal callers.
pub(crate) async fn get_hcfs_config_internal(pool: &SqlitePool, account_id: &str) -> Result<HcfsConfigResult> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String, String, i32)> = sqlx::query_as(
        r"
        SELECT server_url, drive_password, COALESCE(encryption_version, 0)
        FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

    match result {
        Some((server_url, password, enc_ver)) => Ok(HcfsConfigResult {
            server_url,
            has_password: enc_ver > 0 || !password.is_empty(),
        }),
        None => Ok(HcfsConfigResult {
            server_url: String::new(),
            has_password: false,
        }),
    }
}

#[tauri::command]
pub async fn get_hcfs_config(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<HcfsConfigResult> {
    get_hcfs_config_internal(state.pool()?, &account_id).await
}

/// Reads the drive password from `hcfs_config`, decrypting if necessary.
///
/// When `mnemonic` is `Some`, encrypted passwords (encryption_version=1) are
/// decrypted. When `None`, only plaintext passwords (encryption_version=0) are
/// returned — encrypted rows produce an error. This allows mnemonic-recovery
/// code paths (which don't yet have the mnemonic) to still read pre-migration
/// plaintext passwords.
pub(crate) async fn get_drive_password(pool: &SqlitePool, account_id: &str, mnemonic: Option<&str>) -> Result<String> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String, i32)> = sqlx::query_as(
        r"
        SELECT drive_password, COALESCE(encryption_version, 0)
        FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

    let (raw_password, enc_ver) = result.ok_or_else(|| crate::error::AppError::Other("HCFS config not found".into()))?;

    match (enc_ver, mnemonic) {
        (0, _) => Ok(raw_password),
        (1, Some(m)) => {
            let key = store::drive_password_key(m, account_id)?;
            let plaintext = store::decrypt(&key, &raw_password)?;
            Ok((*plaintext).clone())
        }
        (1, None) => Err(crate::error::AppError::Crypto(
            "Drive password is encrypted but no mnemonic available for decryption".into(),
        )),
        (v, _) => Err(crate::error::AppError::Crypto(format!("unknown drive password encryption_version: {v}"))),
    }
}

/// Read the sync path for a specific label from the database.
pub(crate) async fn get_sync_path_for_label(pool: &SqlitePool, account_id: &str, label: &str) -> Result<String> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String,)> = sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(label)
        .fetch_optional(db)
        .await?;

    result
        .map(|(path,)| path)
        .ok_or_else(|| crate::error::AppError::NotReady(crate::error::NotReadyKind::SyncSetup))
}

/// Construct an `HcfsClientConfig` from the common connection parameters.
pub(crate) fn build_hcfs_config(server_url: &str, bearer_token: &str, account_id: &str, folder_hash: &str) -> HcfsClientConfig {
    HcfsClientConfig {
        base_url: server_url.to_string(),
        bearer_token: bearer_token.to_string(),
        accept_invalid_certs: ACCEPT_INVALID_CERTS,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: folder_hash.to_string(),
    }
}

/// Read the sync path, drive password, and server URL from the DB.
pub(crate) async fn load_sync_config(pool: &SqlitePool, account_id: &str, label: &str, mnemonic: &str) -> Result<SyncConfig> {
    let sync_path = get_sync_path_for_label(pool, account_id, label).await?;
    debug!("Sync path: {}, label: {}", sync_path, label);

    let drive_password = get_drive_password(pool, account_id, Some(mnemonic)).await?;
    let config = get_hcfs_config_internal(pool, account_id).await?;

    let server_url = if config.server_url.is_empty() {
        "https://arion.hippius.com".to_string()
    } else {
        config.server_url
    };
    debug!("Server URL: {}", server_url);

    Ok(SyncConfig {
        sync_path,
        drive_password,
        server_url,
    })
}

/// Internal version of save_hcfs_config (no tauri::State wrapper).
///
/// When `mnemonic` is provided, the drive password is encrypted before storing.
/// Falls back to plaintext storage (encryption_version=0) when unavailable.
pub(crate) async fn save_hcfs_config_internal(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    server_url: &str,
    drive_password: &str,
    mnemonic: Option<&str>,
) -> Result<()> {
    let owner = account_key(account_id);

    let (stored_password, enc_version) = match mnemonic {
        Some(m) => {
            let key = store::drive_password_key(m, account_id)?;
            let encrypted = store::encrypt(&key, drive_password)?;
            (encrypted, 1i32)
        }
        None => (drive_password.to_string(), 0i32),
    };

    sqlx::query(
        r"
        INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password,
            encryption_version = excluded.encryption_version
        ",
    )
    .bind(&owner)
    .bind(server_url)
    .bind(&stored_password)
    .bind(enc_version)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── build_hcfs_config ───────────────────────────────────────────

    #[test]
    fn build_hcfs_config_sets_all_fields() {
        let cfg = build_hcfs_config("https://example.com", "tok123", "5GrwvaEF", "abcd1234");
        assert_eq!(cfg.base_url, "https://example.com");
        assert_eq!(cfg.bearer_token, "tok123");
        assert_eq!(cfg.ss58_address, "5GrwvaEF");
        assert_eq!(cfg.folder_hash, "abcd1234");
        assert_eq!(cfg.accept_invalid_certs, ACCEPT_INVALID_CERTS);
        assert!(cfg.billing_bypass_token.is_none());
    }

    #[test]
    fn build_hcfs_config_preserves_empty_strings() {
        let cfg = build_hcfs_config("", "", "", "");
        assert_eq!(cfg.base_url, "");
        assert_eq!(cfg.bearer_token, "");
        assert_eq!(cfg.ss58_address, "");
        assert_eq!(cfg.folder_hash, "");
    }
}
