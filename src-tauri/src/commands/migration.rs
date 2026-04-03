//! Server-side migration commands.
//!
//! Handles the one-time migration of files from legacy S3/CAS storage to the
//! new HCFS encrypted drive system. The server downloads files from S3,
//! encrypts them, and uploads to Arion. The desktop polls for progress.
//!
//! The flow is: `check_migration` → `start_server_migration` → poll via
//! `poll_migration_status` → `complete_migration_transition` (atomic dismiss
//! + stop + reinit).

use ed25519_dalek::Signer;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A file discovered in the user's legacy S3 bucket that needs migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationFile {
    pub user_id: String,
    pub bucket_name: String,
    pub key: String,
    pub size_bytes: u64,
    pub is_public: bool,
    pub status: String,
}

/// Result of `check_migration` — tells the frontend whether migration is
/// needed and provides the file inventory for the migration dialog.
#[derive(Debug, Serialize)]
pub struct MigrationCheckResult {
    pub needs_migration: bool,
    pub file_count: u64,
    pub total_size: u64,
    pub files: Vec<MigrationFile>,
    pub sync_path: Option<String>,
    pub is_resuming: bool,
}

/// Server response from GET /migration/{user_id}
///
/// Fields match the server JSON schema. Only `files` is accessed in Rust;
/// the rest exist so serde can deserialize the full response.
#[derive(Debug, Deserialize)]
#[expect(dead_code, reason = "fields exist for serde deserialization, not direct access")]
struct ServerMigrationResponse {
    needs_migration: bool,
    file_count: u64,
    total_size: u64,
    files: Vec<MigrationFile>,
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

pub(crate) async fn get_migration_status_db(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<(String, i64, i64, String, String)>, crate::error::AppError> {
    let row = sqlx::query(
        "SELECT status, total_files, completed_files, sync_path, server_url \
         FROM migration_status WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| crate::error::AppError::Other(format!("DB error reading migration_status: {e}")))?;

    match row {
        Some(r) => Ok(Some((
            r.get("status"),
            r.get("total_files"),
            r.get("completed_files"),
            r.get("sync_path"),
            r.get("server_url"),
        ))),
        None => Ok(None),
    }
}

#[expect(clippy::too_many_arguments)] // bundling into struct deferred to Phase 4
pub(crate) async fn upsert_migration_status(
    pool: &SqlitePool,
    account_id: &str,
    status: &str,
    total_files: i64,
    completed_files: i64,
    failed_files: &str,
    sync_path: &str,
    server_url: &str,
) -> Result<(), crate::error::AppError> {
    sqlx::query(
        r"
        INSERT INTO migration_status
            (account_id, status, total_files, completed_files,
             failed_files, sync_path, server_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(account_id) DO UPDATE SET
            status = excluded.status,
            total_files = excluded.total_files,
            completed_files = excluded.completed_files,
            failed_files = excluded.failed_files,
            sync_path = excluded.sync_path,
            server_url = excluded.server_url,
            updated_at = CURRENT_TIMESTAMP
        ",
    )
    .bind(account_id)
    .bind(status)
    .bind(total_files)
    .bind(completed_files)
    .bind(failed_files)
    .bind(sync_path)
    .bind(server_url)
    .execute(pool)
    .await
    .map_err(|e| crate::error::AppError::Other(format!("DB error upserting migration_status: {e}")))?;
    Ok(())
}

pub(crate) async fn get_server_url(pool: &SqlitePool, account_id: &str) -> Result<String, crate::error::AppError> {
    let owner = crate::utils::account_key::account_key(account_id);
    let row = sqlx::query("SELECT server_url FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("DB error reading hcfs_config: {e}")))?;
    match row {
        Some(r) => {
            let url: String = r.get("server_url");
            if url.is_empty() {
                Ok("https://arion.hippius.com".to_string())
            } else {
                Ok(url)
            }
        }
        None => Ok("https://arion.hippius.com".to_string()),
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MANIFEST_PREFIX: &str = ".hippius_manifest_v1";
fn should_skip_key(key: &str) -> bool {
    key == MANIFEST_PREFIX || key.starts_with(&format!("{MANIFEST_PREFIX}/"))
}

/// Derive the path prefix (bucket name) from the first migration file.
/// Returns empty string if no files are provided.
fn derive_path_prefix(files: &[MigrationFile]) -> String {
    files
        .first()
        .map(|f| f.bucket_name.clone())
        .unwrap_or_default()
}

pub(crate) async fn fetch_migration_files(
    client: &reqwest::Client,
    server_url: &str,
    user_id: &str,
) -> Result<Vec<MigrationFile>, crate::error::AppError> {
    let url = format!("{}/migration/{}", server_url.trim_end_matches('/'), user_id);
    let resp = client.get(&url).send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Other(format!("Migration check failed (status {status}): {text}")));
    }

    let parsed: ServerMigrationResponse = resp.json().await?;

    Ok(parsed.files.into_iter().filter(|f| !should_skip_key(&f.key)).collect())
}

/// Fetch per-user S3 credentials from the Hippius API.
///
/// The server-side migration worker uses these credentials to download the
/// user's files from the legacy S3 storage (s3.hippius.com).
async fn fetch_s3_credentials(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<(String, String), crate::error::AppError> {
    let api_token = crate::utils::auth_tokens::get_api_token(pool, account_id)
        .await
        .map_err(|e| crate::error::AppError::Other(e))?
        .ok_or_else(|| {
            crate::error::AppError::Other(
                "No API token available — log in first".into(),
            )
        })?;

    let api_base = std::env::var("HIPPIUS_API_BASE_URL")
        .unwrap_or_else(|_| "https://api.hippius.com/api".to_string());
    let url = format!(
        "{}/objectstore/master-tokens/",
        api_base.trim_end_matches('/')
    );

    #[derive(Serialize)]
    struct CreateBody<'a> {
        name: &'a str,
    }

    #[derive(Deserialize)]
    struct CredentialsResponse {
        #[serde(rename = "accessKeyId")]
        access_key_id: String,
        secret: String,
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Token {api_token}"))
        .header("Content-Type", "application/json")
        .json(&CreateBody { name: "hippius-desktop" })
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Other(format!(
            "S3 credentials request failed (status {status}): {text}"
        )));
    }

    let parsed: CredentialsResponse = resp.json().await?;
    Ok((parsed.access_key_id, parsed.secret))
}

// ---------------------------------------------------------------------------
// Disk space check
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn check_disk_space(path: &std::path::Path, required_bytes: u64) -> Result<(), crate::error::AppError> {
    let stat = nix::sys::statvfs::statvfs(path).map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    let available = stat.block_size() as u64 * stat.blocks_available() as u64;
    if available < required_bytes {
        return Err(crate::error::AppError::Validation(format!(
            "Not enough disk space. Need {required_bytes} bytes but only {available} available."
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn check_disk_space(_path: &std::path::Path, _required_bytes: u64) -> Result<(), crate::error::AppError> {
    // Disk space check not yet implemented on Windows
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_migration(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<MigrationCheckResult, crate::error::AppError> {
    let pool = state.pool()?;
    // 1. Check local DB for existing migration
    if let Some((status, _total, _completed, sync_path, _server_url)) = get_migration_status_db(pool, &account_id).await? {
        // If the user already dismissed (skipped, cancelled, or completed)
        // the migration, never show the prompt again.
        let terminal_statuses = ["dismissed", "skipped", "cancelled", "complete"];
        if terminal_statuses.iter().any(|s| status.eq_ignore_ascii_case(s)) {
            return Ok(MigrationCheckResult {
                needs_migration: false,
                file_count: 0,
                total_size: 0,
                files: vec![],
                sync_path: None,
                is_resuming: false,
            });
        }

        // Status is "in_progress" — verify with the server
        let server_url = get_server_url(pool, &account_id).await?;
        let files = fetch_migration_files(&state.migration.client, &server_url, &account_id).await?;
        let pending: Vec<MigrationFile> = files.into_iter().filter(|f| f.status.eq_ignore_ascii_case("pending")).collect();

        if pending.is_empty() {
            // Server confirms everything is migrated
            if let Err(e) = upsert_migration_status(pool, &account_id, "complete", 0, 0, "[]", &sync_path, &server_url).await {
                warn!("Failed to update migration status to complete: {e}");
            }
            return Ok(MigrationCheckResult {
                needs_migration: false,
                file_count: 0,
                total_size: 0,
                files: vec![],
                sync_path: None,
                is_resuming: false,
            });
        }

        // Server still has pending files — resume migration
        let total_size: u64 = pending.iter().map(|f| f.size_bytes).sum();
        return Ok(MigrationCheckResult {
            needs_migration: true,
            file_count: pending.len() as u64,
            total_size,
            files: pending,
            sync_path: Some(sync_path),
            is_resuming: true,
        });
    }

    // 2. No local state -- check server
    let server_url = get_server_url(pool, &account_id).await?;
    let files = fetch_migration_files(&state.migration.client, &server_url, &account_id).await?;
    let pending: Vec<MigrationFile> = files.into_iter().filter(|f| f.status.eq_ignore_ascii_case("pending")).collect();
    let total_size: u64 = pending.iter().map(|f| f.size_bytes).sum();

    Ok(MigrationCheckResult {
        needs_migration: !pending.is_empty(),
        file_count: pending.len() as u64,
        total_size,
        files: pending,
        sync_path: None,
        is_resuming: false,
    })
}

/// Dismiss migration permanently so the dialog never shows again.
/// `reason` should be "skipped" (Start Fresh) or "dismissed".
///
/// For completed migrations, use `complete_migration_transition` instead —
/// it handles label promotion, drive stop, and default drive init atomically.
#[tauri::command]
pub async fn dismiss_migration(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    reason: String,
) -> Result<(), crate::error::AppError> {
    let pool = state.pool()?;
    let server_url = get_server_url(pool, &account_id).await.unwrap_or_default();
    let status = if reason.is_empty() { "dismissed" } else { &reason };

    upsert_migration_status(pool, &account_id, status, 0, 0, "[]", "", &server_url).await?;
    info!("Migration dismissed for account {account_id} with reason: {status}");
    Ok(())
}

/// Complete the migration lifecycle: dismiss, stop the migration drive, and
/// start a default drive so the user transitions seamlessly into normal sync.
///
/// This consolidates the stop-drive + initialize-sync orchestration that was
/// previously done on the frontend.
#[tauri::command]
pub async fn complete_migration_transition(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    existing_mnemonic: Option<String>,
) -> Result<crate::commands::syncing::InitSyncResult, crate::error::AppError> {
    let pool = state.pool()?;

    // 1. Dismiss migration and promote sync path label to "default".
    state.migration.in_progress.store(false, Ordering::SeqCst);
    let server_url = get_server_url(pool, &account_id).await.unwrap_or_default();

    let owner = crate::utils::account_key::account_key(&account_id);
    if let Err(e) = sqlx::query(
        r"
        UPDATE sync_paths
        SET label = 'default',
            timestamp = strftime('%s', 'now')
        WHERE owner = ? AND label = 'migration'
        ",
    )
    .bind(&owner)
    .execute(pool)
    .await
    {
        warn!("Failed to promote migration sync path to default: {e}");
    } else {
        info!("Promoted migration sync path to 'default' for {account_id}");
    }

    upsert_migration_status(pool, &account_id, "completed", 0, 0, "[]", "", &server_url).await?;
    info!("Migration dismissed for account {account_id} with reason: completed");

    // 2. Stop the "migration" drive.
    stop_migration_drive(&app).await;

    // 3. Initialize the "default" drive and start the sync loop.
    crate::commands::syncing::initialize_sync(app, account_id, "default".to_string(), existing_mnemonic).await
}

/// Stop the migration drive and clean up its state.
async fn stop_migration_drive(app: &AppHandle) {
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let remaining = {
        let mut guard = sync.drives.lock().await;
        if let Some(slot) = guard.remove("migration") {
            slot.cancel_token.cancel();
        }
        guard.len()
    };

    sync.remove_state("migration");
    sync.discard_pending_activity_for_label("migration");

    if remaining == 0 {
        sync.request_cancel();
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
        sync.clear_all_reviews();
        let _ = app.emit("hcfs_sync_stopped", ());
    } else {
        sync.clear_cancel();
        crate::hcfs_drive::start_sync_loop(app.clone()).await;
    }

    info!("Stopped migration drive, {} drives remaining", remaining);
}

// ---------------------------------------------------------------------------
// Server-side migration commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct StartServerMigrationResult {
    pub status: String,
    pub total_files: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ServerMigrationStatus {
    pub status: String,
    pub total: i32,
    pub completed: i32,
    pub failed: i32,
    pub failed_files: Vec<String>,
    pub current_file: Option<String>,
}

#[tauri::command]
pub async fn start_server_migration(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    path_prefix: Option<String>,
    total_size: u64,
) -> Result<StartServerMigrationResult, crate::error::AppError> {
    state.migration.in_progress.store(true, Ordering::SeqCst);

    let folder_hash = crate::commands::syncing::folder_hash("default");
    let pool = state.pool()?;

    // Resolve path_prefix: use provided value, or derive from migration files
    let path_prefix = if let Some(p) = path_prefix.filter(|p| !p.is_empty()) {
        p
    } else {
        let server_url = get_server_url(pool, &account_id).await?;
        let files = fetch_migration_files(
            &state.migration.client,
            &server_url,
            &account_id,
        )
        .await?;
        derive_path_prefix(&files)
    };

    // Check disk space — files will be downloaded locally after server migration
    let sync_path = crate::commands::syncing::get_sync_path_for_label(
        pool, &account_id, "default",
    )
    .await
    .unwrap_or_else(|_| {
        dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    let sync_dir = std::path::Path::new(&sync_path);
    if sync_dir.exists() {
        check_disk_space(sync_dir, total_size)?;
    }

    // Recover the master mnemonic to derive the encryption key
    let password = crate::commands::syncing::get_drive_password(
        pool, &account_id,
    )
    .await?;
    let mnemonic_path =
        crate::commands::syncing::master_mnemonic_path(&account_id)?;
    let mnemonic = hcfs_client::auth::recover_mnemonic(
        &mnemonic_path, &password,
    )
    .map_err(|e| {
        crate::error::AppError::Other(format!(
            "Failed to recover mnemonic: {e}"
        ))
    })?;

    let seed = mnemonic.to_seed("");
    let encryption_key_hex = hex::encode(&seed[..32]);

    // Derive Ed25519 signing key from seed
    let signing_key = hcfs_client::auth::recover_signing_key(seed)
        .map_err(|e| {
            crate::error::AppError::Other(format!(
                "Failed to derive signing key: {e}"
            ))
        })?;

    // Sign the migration request
    let signing_text = format!(
        "I hereby declare that I am requesting migration of folder \
         {folder_hash} for account {account_id} on HCFS with the \
         understanding that I have read and agree to the Terms of Service"
    );
    let signature = signing_key.sign(signing_text.as_bytes());

    // Fetch per-user S3 credentials from Hippius API
    let (s3_access_key, s3_secret_key) =
        fetch_s3_credentials(pool, &account_id).await?;

    // Call server endpoint
    let server_url = get_server_url(pool, &account_id).await?;
    let url = format!(
        "{}/migration/start",
        server_url.trim_end_matches('/')
    );

    let resp = state.migration.client
        .post(&url)

        .json(&serde_json::json!({
            "ss58_address": account_id,
            "folder_hash": folder_hash,
            "encryption_key_hex": encryption_key_hex,
            "path_prefix": path_prefix,
            "s3_access_key": s3_access_key,
            "s3_secret_key": s3_secret_key,
            "signature": signature.to_bytes().to_vec(),
            "signing_key": signing_key.verifying_key().to_bytes().to_vec(),
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Other(format!(
            "Migration start failed: {text}"
        )));
    }

    let result: StartServerMigrationResult = resp.json().await?;
    Ok(result)
}

#[tauri::command]
pub async fn poll_migration_status(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<ServerMigrationStatus, crate::error::AppError> {
    let pool = state.pool()?;
    let server_url = get_server_url(pool, &account_id).await?;
    let url = format!(
        "{}/migration/{}/status",
        server_url.trim_end_matches('/'),
        account_id
    );

    let resp = state.migration.client
        .get(&url)

        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Other(format!(
            "Status check failed: {text}"
        )));
    }

    let status: ServerMigrationStatus = resp.json().await?;
    Ok(status)
}

#[tauri::command]
pub async fn cancel_server_migration(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<(), crate::error::AppError> {
    state.migration.in_progress.store(false, Ordering::SeqCst);
    let pool = state.pool()?;
    let server_url = get_server_url(pool, &account_id).await?;
    let url = format!(
        "{}/migration/cancel",
        server_url.trim_end_matches('/')
    );

    let resp = state.migration.client
        .post(&url)

        .json(&serde_json::json!({
            "ss58_address": account_id,
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Other(format!(
            "Cancel failed: {text}"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // should_skip_key
    // -----------------------------------------------------------------------

    #[test]
    fn skip_manifest_prefix_exact() {
        assert!(should_skip_key(MANIFEST_PREFIX));
    }

    #[test]
    fn skip_manifest_prefix_subdirectory() {
        assert!(should_skip_key(&format!("{MANIFEST_PREFIX}/some_file")));
    }

    #[test]
    fn do_not_skip_normal_key() {
        assert!(!should_skip_key("photos/vacation.jpg"));
    }

    #[test]
    fn do_not_skip_key_containing_manifest_substring() {
        assert!(!should_skip_key("backup_hippius_manifest_v1_old"));
    }

    #[test]
    fn do_not_skip_empty_key() {
        assert!(!should_skip_key(""));
    }

    #[test]
    fn skip_manifest_with_trailing_slash() {
        assert!(should_skip_key(&format!("{MANIFEST_PREFIX}/")));
    }

    #[test]
    fn do_not_skip_near_miss_suffix() {
        // ".hippius_manifest_v1x" is NOT the manifest prefix
        assert!(!should_skip_key(&format!("{MANIFEST_PREFIX}x")));
    }

    #[test]
    fn do_not_skip_manifest_embedded_in_path() {
        assert!(!should_skip_key(&format!("data/{MANIFEST_PREFIX}/file")));
    }

    // -----------------------------------------------------------------------
    // MigrationFile filtering (simulates fetch_migration_files logic)
    // -----------------------------------------------------------------------

    #[test]
    fn filter_skips_manifest_files() {
        let files = vec![
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: "photo.jpg".into(),
                size_bytes: 1000,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: MANIFEST_PREFIX.into(),
                size_bytes: 500,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: format!("{MANIFEST_PREFIX}/chunk_0"),
                size_bytes: 200,
                is_public: false,
                status: "Pending".into(),
            },
        ];

        let filtered: Vec<MigrationFile> = files.into_iter().filter(|f| !should_skip_key(&f.key)).collect();

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].key, "photo.jpg");
    }

    #[test]
    fn filter_pending_files_only() {
        let files = vec![
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: "a.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: "b.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Migrated".into(),
            },
        ];

        let pending: Vec<MigrationFile> = files.into_iter().filter(|f| f.status == "Pending").collect();

        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].key, "a.txt");
    }

    // -----------------------------------------------------------------------
    // check_disk_space (Unix only)
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn disk_space_check_passes_for_small_requirement() {
        let dir = tempfile::tempdir().expect("create temp dir");
        assert!(check_disk_space(dir.path(), 1).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn disk_space_check_fails_for_huge_requirement() {
        let dir = tempfile::tempdir().expect("create temp dir");
        assert!(check_disk_space(dir.path(), u64::MAX).is_err());
    }

    // -----------------------------------------------------------------------
    // Type serialization round-trips
    // -----------------------------------------------------------------------

    #[test]
    fn migration_check_result_serializes() {
        let result = MigrationCheckResult {
            needs_migration: true,
            file_count: 3,
            total_size: 1024,
            files: vec![MigrationFile {
                user_id: "u1".into(),
                bucket_name: "bucket".into(),
                key: "file.txt".into(),
                size_bytes: 1024,
                is_public: false,
                status: "Pending".into(),
            }],
            sync_path: Some("/tmp/sync".into()),
            is_resuming: false,
        };

        let json = serde_json::to_string(&result).expect("serialization failed");
        assert!(json.contains("\"needs_migration\":true"));
        assert!(json.contains("\"file_count\":3"));
    }

    #[test]
    fn migration_file_deserializes_from_server_format() {
        let json = r#"{
            "user_id": "5GrwvaEF...",
            "bucket_name": "files",
            "key": "docs/readme.txt",
            "size_bytes": 2048,
            "is_public": false,
            "status": "Pending"
        }"#;

        let file: MigrationFile = serde_json::from_str(json).expect("deserialization failed");
        assert_eq!(file.bucket_name, "files");
        assert_eq!(file.key, "docs/readme.txt");
        assert_eq!(file.size_bytes, 2048);
        assert_eq!(file.status, "Pending");
    }

    #[test]
    fn filter_all_migrated_yields_empty() {
        let files = vec![
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: "a.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Migrated".into(),
            },
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: "b.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Migrated".into(),
            },
        ];

        let pending: Vec<MigrationFile> = files.into_iter().filter(|f| f.status == "Pending").collect();

        assert!(pending.is_empty());
    }

    #[test]
    fn filter_empty_input_yields_empty() {
        let files: Vec<MigrationFile> = vec![];
        let pending: Vec<MigrationFile> = files.into_iter().filter(|f| f.status == "Pending").collect();
        assert!(pending.is_empty());
    }

    #[test]
    fn total_size_with_zero_byte_files() {
        let files = [
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: "empty.txt".into(),
                size_bytes: 0,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "b1".into(),
                key: "real.txt".into(),
                size_bytes: 500,
                is_public: false,
                status: "Pending".into(),
            },
        ];

        let total: u64 = files.iter().map(|f| f.size_bytes).sum();
        assert_eq!(total, 500);
    }

    #[test]
    fn migration_file_rejects_missing_fields() {
        let json = r#"{"user_id": "u1", "bucket_name": "b1"}"#;
        let result: Result<MigrationFile, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn server_migration_response_deserializes() {
        let json = r#"{
            "needs_migration": true,
            "file_count": 2,
            "total_size": 3072,
            "files": [
                {
                    "user_id": "user1",
                    "bucket_name": "files",
                    "key": "a.txt",
                    "size_bytes": 1024,
                    "is_public": false,
                    "status": "Pending"
                },
                {
                    "user_id": "user1",
                    "bucket_name": "files",
                    "key": "b.txt",
                    "size_bytes": 2048,
                    "is_public": true,
                    "status": "Migrated"
                }
            ]
        }"#;

        let resp: ServerMigrationResponse = serde_json::from_str(json).expect("deserialization failed");
        assert!(resp.needs_migration);
        assert_eq!(resp.files.len(), 2);
        assert_eq!(resp.files[0].status, "Pending");
        assert_eq!(resp.files[1].status, "Migrated");
    }

    // -----------------------------------------------------------------------
    // in_progress flag
    // -----------------------------------------------------------------------

    #[test]
    fn in_progress_defaults_to_false() {
        let ms = crate::app_state::MigrationState::new();
        assert!(!ms.in_progress.load(Ordering::SeqCst));
    }

    #[test]
    fn in_progress_can_be_toggled() {
        let ms = crate::app_state::MigrationState::new();
        ms.in_progress.store(true, Ordering::SeqCst);
        assert!(ms.in_progress.load(Ordering::SeqCst));
        ms.in_progress.store(false, Ordering::SeqCst);
        assert!(!ms.in_progress.load(Ordering::SeqCst));
    }

    // -----------------------------------------------------------------------
    // derive_path_prefix
    // -----------------------------------------------------------------------

    #[test]
    fn derive_path_prefix_from_first_file() {
        let files = vec![MigrationFile {
            user_id: "u1".into(),
            bucket_name: "my-bucket".into(),
            key: "file.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }];
        assert_eq!(derive_path_prefix(&files), "my-bucket");
    }

    #[test]
    fn derive_path_prefix_empty_files() {
        let files: Vec<MigrationFile> = vec![];
        assert_eq!(derive_path_prefix(&files), "");
    }

    #[test]
    fn derive_path_prefix_uses_first_file_only() {
        let files = vec![
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "first-bucket".into(),
                key: "a.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "u1".into(),
                bucket_name: "second-bucket".into(),
                key: "b.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Pending".into(),
            },
        ];
        assert_eq!(derive_path_prefix(&files), "first-bucket");
    }

    // -----------------------------------------------------------------------
    // folder_hash (shared from syncing.rs)
    // -----------------------------------------------------------------------

    #[test]
    fn folder_hash_is_deterministic() {
        let h1 = crate::commands::syncing::folder_hash("default");
        let h2 = crate::commands::syncing::folder_hash("default");
        assert_eq!(h1, h2);
    }

    #[test]
    fn folder_hash_is_16_chars() {
        let hash = crate::commands::syncing::folder_hash("default");
        assert_eq!(hash.len(), 16);
    }

    #[test]
    fn folder_hash_differs_by_label() {
        let h1 = crate::commands::syncing::folder_hash("default");
        let h2 = crate::commands::syncing::folder_hash("migration");
        assert_ne!(h1, h2);
    }

    #[test]
    fn folder_hash_empty_label() {
        let hash = crate::commands::syncing::folder_hash("");
        assert_eq!(hash.len(), 16);
    }
}
