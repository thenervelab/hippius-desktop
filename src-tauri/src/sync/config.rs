//! HCFS configuration CRUD operations.
//!
//! Contains commands and helpers for reading and writing HCFS server
//! configuration (server URL, drive password, bearer token) in the database.

use tracing::debug;

use crate::auth::account_key::account_key;
use crate::error::Result;
use hcfs_client::client::HcfsClientConfig;
use sqlx::sqlite::SqlitePool;

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

    sqlx::query(
        r"
        INSERT INTO hcfs_config (owner, server_url, drive_password, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password,
            updated_at = CURRENT_TIMESTAMP
        ",
    )
    .bind(&owner)
    .bind(&server_url)
    .bind(&drive_password)
    .execute(db)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn update_hcfs_server_url(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    server_url: String,
) -> Result<()> {
    let db = state.pool()?;
    let owner = account_key(&account_id);

    let result = sqlx::query(
        r"
        UPDATE hcfs_config SET server_url = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ?
        ",
    )
    .bind(&server_url)
    .bind(&owner)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(crate::error::AppError::Other("HCFS config not found. Please set up sync first.".into()));
    }

    Ok(())
}
/// Internal helper that accepts a pool reference directly.
/// Used by both the Tauri command and other internal callers.
pub(crate) async fn get_hcfs_config_internal(pool: &SqlitePool, account_id: &str) -> Result<HcfsConfigResult> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String, String)> = sqlx::query_as(
        r"
        SELECT server_url, drive_password FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

    match result {
        Some((server_url, password)) => Ok(HcfsConfigResult {
            server_url,
            has_password: !password.is_empty(),
        }),
        None => Ok(HcfsConfigResult {
            server_url: String::new(),
            has_password: false,
        }),
    }
}

#[tauri::command]
pub async fn get_hcfs_config(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<HcfsConfigResult> {
    get_hcfs_config_internal(state.pool()?, &account_id).await
}

pub(crate) async fn get_drive_password(pool: &SqlitePool, account_id: &str) -> Result<String> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String,)> = sqlx::query_as(
        r"
        SELECT drive_password FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

    result
        .map(|(password,)| password)
        .ok_or_else(|| crate::error::AppError::Other("HCFS config not found".into()))
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
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: folder_hash.to_string(),
    }
}

/// Read the sync path, drive password, and server URL from the DB.
pub(crate) async fn load_sync_config(pool: &SqlitePool, account_id: &str, label: &str) -> Result<SyncConfig> {
    let sync_path = get_sync_path_for_label(pool, account_id, label).await?;
    debug!("Sync path: {}, label: {}", sync_path, label);

    let drive_password = get_drive_password(pool, account_id).await?;
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
pub(crate) async fn save_hcfs_config_internal(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    server_url: &str,
    drive_password: &str,
) -> Result<()> {
    let owner = account_key(account_id);
    sqlx::query(
        r"
        INSERT INTO hcfs_config (owner, server_url, drive_password) VALUES (?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password
        ",
    )
    .bind(&owner)
    .bind(server_url)
    .bind(drive_password)
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
        assert!(cfg.accept_invalid_certs);
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
