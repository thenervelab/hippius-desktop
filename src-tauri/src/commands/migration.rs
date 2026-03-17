use crate::DB_POOL;
use aws_credential_types::Credentials;
use aws_sdk_s3::Client as S3Client;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize)]
struct MigrationError {
    error: String,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationFile {
    pub user_id: String,
    pub bucket_name: String,
    pub key: String,
    pub size_bytes: u64,
    pub is_public: bool,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct MigrationCheckResult {
    pub needs_migration: bool,
    pub file_count: u64,
    pub total_size: u64,
    pub files: Vec<MigrationFile>,
    pub sync_path: Option<String>,
    pub is_resuming: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationProgress {
    pub phase: String,
    pub current_file: String,
    pub completed: u64,
    pub total: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationFileError {
    pub file_name: String,
    pub bucket: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationComplete {
    pub total_migrated: u64,
}

/// Server response from GET /migration/{user_id}
#[derive(Debug, Deserialize)]
struct ServerMigrationResponse {
    #[allow(dead_code)]
    needs_migration: bool,
    #[allow(dead_code)]
    file_count: u64,
    #[allow(dead_code)]
    total_size: u64,
    files: Vec<MigrationFile>,
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

/// Cancellation flag for the current migration download loop.
pub static MIGRATION_CANCEL: AtomicBool = AtomicBool::new(false);

/// Handle to the background migration task so it can be aborted.
pub(crate) static MIGRATION_TASK: Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

/// Tracks file paths that have been confirmed uploaded to HCFS by the
/// upload progress handler. Keyed by relative path within the sync folder
/// (e.g. "bucket_name/key"). Only files in this set are reported as
/// migrated to the server — disk existence alone is not sufficient.
///
/// Uses `std::sync::Mutex` (not tokio) because the upload progress
/// callback is synchronous and the critical section is trivial
/// (HashSet insert/clone). A blocking lock guarantees no uploads are
/// silently dropped due to contention.
pub(crate) static MIGRATION_UPLOADED: Lazy<std::sync::Mutex<HashSet<String>>> =
    Lazy::new(|| std::sync::Mutex::new(HashSet::new()));

/// Record that a file has been successfully uploaded to HCFS.
/// Called from the upload progress handler in syncing.rs when
/// a migration-drive file upload completes (bytes == total).
/// `relative_path` should be the path relative to the sync folder.
pub fn record_migration_upload(relative_path: String) {
    if let Ok(mut set) = MIGRATION_UPLOADED.lock() {
        set.insert(relative_path);
    }
}

/// Clear the uploaded-files tracker (called when migration completes
/// or is cancelled/dismissed).
pub fn clear_migration_uploads() {
    if let Ok(mut set) = MIGRATION_UPLOADED.lock() {
        set.clear();
    }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

pub(crate) async fn get_migration_status_db(
    account_id: &str,
) -> Result<Option<(String, i64, i64, String, String)>, String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database not initialized".to_string())?;
    let row = sqlx::query(
        "SELECT status, total_files, completed_files, sync_path, server_url \
         FROM migration_status WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("DB error reading migration_status: {e}"))?;

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

pub(crate) async fn upsert_migration_status(
    account_id: &str,
    status: &str,
    total_files: i64,
    completed_files: i64,
    failed_files: &str,
    sync_path: &str,
    server_url: &str,
) -> Result<(), String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database not initialized".to_string())?;
    sqlx::query(
        r#"
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
        "#,
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
    .map_err(|e| format!("DB error upserting migration_status: {e}"))?;
    Ok(())
}

pub(crate) async fn get_server_url(
    account_id: &str,
) -> Result<String, String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database not initialized".to_string())?;
    let owner = crate::utils::account_key::account_key(account_id);
    let row =
        sqlx::query("SELECT server_url FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("DB error reading hcfs_config: {e}"))?;
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

pub(crate) async fn fetch_migration_files(
    server_url: &str,
    user_id: &str,
) -> Result<Vec<MigrationFile>, String> {
    let url = format!(
        "{}/migration/{}",
        server_url.trim_end_matches('/'),
        user_id
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let resp = client
        .get(&url)
        .header("X-API-Key", "Arion")
        .send()
        .await
        .map_err(|e| {
            format!("Failed to reach migration endpoint: {e}")
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Migration check failed (status {status}): {text}"
        ));
    }

    let parsed: ServerMigrationResponse = resp
        .json()
        .await
        .map_err(|e| {
            format!("Failed to parse migration response: {e}")
        })?;

    Ok(parsed
        .files
        .into_iter()
        .filter(|f| !should_skip_key(&f.key))
        .collect())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_migration(
    account_id: String,
) -> Result<MigrationCheckResult, String> {
    // 1. Check local DB for existing migration
    if let Some((status, _total, _completed, sync_path, _server_url)) =
        get_migration_status_db(&account_id).await?
    {
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
        let server_url = get_server_url(&account_id).await?;
        let files =
            fetch_migration_files(&server_url, &account_id).await?;
        let pending: Vec<MigrationFile> = files
            .into_iter()
            .filter(|f| f.status.eq_ignore_ascii_case("pending"))
            .collect();

        if pending.is_empty() {
            // Server confirms everything is migrated
            if let Err(e) = upsert_migration_status(
                &account_id,
                "complete",
                0,
                0,
                "[]",
                &sync_path,
                &server_url,
            )
            .await
            {
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
    let server_url = get_server_url(&account_id).await?;
    let files =
        fetch_migration_files(&server_url, &account_id).await?;
    let pending: Vec<MigrationFile> = files
        .into_iter()
        .filter(|f| f.status.eq_ignore_ascii_case("pending"))
        .collect();
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

// ---------------------------------------------------------------------------
// S3 download helpers
// ---------------------------------------------------------------------------

const S3_ENDPOINT: &str = "https://s3.hippius.com";
const S3_REGION: &str = "decentralized";
const MANIFEST_PREFIX: &str = ".hippius_manifest_v1";
const MAX_RETRIES: u32 = 3;

fn should_skip_key(key: &str) -> bool {
    key == MANIFEST_PREFIX
        || key.starts_with(&format!("{MANIFEST_PREFIX}/"))
}

async fn build_s3_client(
    account_id: &str,
) -> Result<S3Client, String> {
    let (access_key, secret) =
        crate::utils::auth_tokens::get_s3_credentials(account_id)
            .await?
            .ok_or_else(|| "No S3 credentials found".to_string())?;

    let credentials = Credentials::new(
        &access_key,
        &secret,
        None,
        None,
        "hippius-migration",
    );

    let config = aws_sdk_s3::config::Builder::new()
        .endpoint_url(S3_ENDPOINT)
        .region(aws_sdk_s3::config::Region::new(S3_REGION))
        .credentials_provider(credentials)
        .force_path_style(true)
        .build();

    Ok(S3Client::from_conf(config))
}

#[cfg(unix)]
fn check_disk_space(
    path: &std::path::Path,
    required_bytes: u64,
) -> Result<(), String> {
    let stat = nix::sys::statvfs::statvfs(path)
        .map_err(|e| format!("Failed to check disk space: {e}"))?;
    let available =
        stat.block_size() as u64 * stat.blocks_available() as u64;
    if available < required_bytes {
        return Err(format!(
            "Not enough disk space. Need {} bytes but only {} available.",
            required_bytes, available
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn check_disk_space(
    _path: &std::path::Path,
    _required_bytes: u64,
) -> Result<(), String> {
    // Disk space check not yet implemented on Windows
    Ok(())
}

async fn download_file_with_retry(
    client: &S3Client,
    bucket: &str,
    key: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 1..=MAX_RETRIES {
        match download_file_once(client, bucket, key, dest).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                if attempt < MAX_RETRIES {
                    let delay =
                        std::time::Duration::from_secs(2u64.pow(attempt));
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(format!("Failed after {MAX_RETRIES} attempts: {last_err}"))
}

async fn download_file_once(
    client: &S3Client,
    bucket: &str,
    key: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("S3 get_object failed: {e}"))?;

    let data = resp
        .body
        .collect()
        .await
        .map_err(|e| format!("Failed to read S3 body: {e}"))?;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Failed to create file: {e}"))?;
    file.write_all(&data.into_bytes())
        .await
        .map_err(|e| format!("Failed to write file: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// start_migration / cancel_migration commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_migration(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: AppHandle,
    account_id: String,
    sync_path: String,
    mnemonic: Option<String>,
) -> Result<(), String> {
    MIGRATION_CANCEL.store(false, Ordering::SeqCst);
    clear_migration_uploads();

    // Verify HCFS config exists — the frontend must prompt for a password first
    if crate::commands::syncing::get_drive_password(&account_id)
        .await
        .is_err()
    {
        return Err("NEEDS_SYNC_SETUP".to_string());
    }

    // Ensure S3 credentials exist
    crate::utils::auth_tokens::ensure_s3_credentials(
        &account_id,
    )
    .await?;

    // Fetch pending files from server
    let server_url = get_server_url(&account_id).await?;
    let all_files =
        fetch_migration_files(&server_url, &account_id).await?;
    let pending: Vec<MigrationFile> = all_files
        .into_iter()
        .filter(|f| f.status.eq_ignore_ascii_case("pending"))
        .collect();

    if pending.is_empty() {
        return Err("No files to migrate".to_string());
    }

    let total = pending.len() as u64;
    let total_size: u64 = pending.iter().map(|f| f.size_bytes).sum();

    // Check disk space
    let sync_dir = std::path::Path::new(&sync_path);
    tokio::fs::create_dir_all(sync_dir)
        .await
        .map_err(|e| format!("Failed to create sync directory: {e}"))?;
    check_disk_space(sync_dir, total_size)?;

    // Save state to DB
    upsert_migration_status(
        &account_id,
        "in_progress",
        total as i64,
        0,
        "[]",
        &sync_path,
        &server_url,
    )
    .await?;

    // Build S3 client
    let s3_client = build_s3_client(&account_id).await?;

    // Spawn background task
    let pool = state.pool()?.clone();
    let app_clone = app.clone();
    let account_clone = account_id.clone();
    let path_clone = sync_path.clone();
    let server_clone = server_url.clone();
    let mnemonic_clone = mnemonic.clone();

    let handle = tokio::spawn(async move {
        if let Err(e) = run_migration_download(
            &app_clone,
            &s3_client,
            &account_clone,
            &path_clone,
            &server_clone,
            &pending,
            mnemonic_clone,
            &pool,
        )
        .await
        {
            let _ = app_clone.emit(
                "migration_error",
                MigrationError {
                    error: e.clone(),
                },
            );
            info!("[Migration] Background task failed: {e}");
        }
    });

    let mut task_guard = MIGRATION_TASK.lock().await;
    if let Some(old) = task_guard.take() {
        old.abort();
    }
    *task_guard = Some(handle);

    Ok(())
}

async fn run_migration_download(
    app: &AppHandle,
    s3_client: &S3Client,
    account_id: &str,
    sync_path: &str,
    server_url: &str,
    files: &[MigrationFile],
    mnemonic: Option<String>,
    pool: &sqlx::SqlitePool,
) -> Result<(), String> {
    let total = files.len() as u64;
    let mut completed: u64 = 0;
    let mut failed: u64 = 0;
    let mut failed_keys: Vec<String> = Vec::new();

    // Canonicalize sync_dir once so the path traversal check works
    // even when sync_path contains symlinks (e.g. /tmp → /private/tmp
    // on macOS).
    let raw_sync_dir = std::path::Path::new(sync_path);
    let sync_dir = raw_sync_dir
        .canonicalize()
        .unwrap_or_else(|_| raw_sync_dir.to_path_buf());

    for file in files {
        if MIGRATION_CANCEL.load(Ordering::SeqCst) {
            info!("[Migration] Cancelled by user");
            break;
        }

        if should_skip_key(&file.key) {
            completed += 1;
            continue;
        }

        let dest = sync_dir
            .join(&file.bucket_name)
            .join(&file.key);

        // Prevent path traversal via malicious S3 keys (fail-closed)
        let canonical = dest.canonicalize().or_else(|_| {
            // File doesn't exist yet — canonicalize parent
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).ok();
                parent.canonicalize().map(|p| {
                    p.join(dest.file_name().unwrap_or_default())
                })
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "no parent",
                ))
            }
        });
        match canonical {
            Ok(canonical) if canonical.starts_with(&sync_dir) => {
                // Path is within sync directory — proceed
            }
            Ok(_) => {
                failed += 1;
                failed_keys.push(file.key.clone());
                let _ = app.emit(
                    "migration_file_error",
                    MigrationFileError {
                        file_name: format!(
                            "{}/{}",
                            file.bucket_name, file.key
                        ),
                        bucket: file.bucket_name.clone(),
                        error: "Path traversal detected".to_string(),
                    },
                );
                continue;
            }
            Err(e) => {
                // Cannot verify path safety — fail closed
                failed += 1;
                failed_keys.push(file.key.clone());
                let _ = app.emit(
                    "migration_file_error",
                    MigrationFileError {
                        file_name: format!(
                            "{}/{}",
                            file.bucket_name, file.key
                        ),
                        bucket: file.bucket_name.clone(),
                        error: format!("Path verification failed: {e}"),
                    },
                );
                continue;
            }
        }

        // Skip files already on disk
        if dest.exists() {
            completed += 1;
            let _ = app.emit(
                "migration_progress",
                MigrationProgress {
                    phase: "downloading".to_string(),
                    current_file: format!(
                        "{}/{}",
                        file.bucket_name, file.key
                    ),
                    completed,
                    total,
                    failed,
                },
            );
            continue;
        }

        let _ = app.emit(
            "migration_progress",
            MigrationProgress {
                phase: "downloading".to_string(),
                current_file: file.key.clone(),
                completed,
                total,
                failed,
            },
        );

        match download_file_with_retry(
            s3_client,
            &file.bucket_name,
            &file.key,
            &dest,
        )
        .await
        {
            Ok(()) => {
                completed += 1;
            }
            Err(e) => {
                failed += 1;
                failed_keys.push(file.key.clone());
                let _ = app.emit(
                    "migration_file_error",
                    MigrationFileError {
                        file_name: format!(
                            "{}/{}",
                            file.bucket_name, file.key
                        ),
                        bucket: file.bucket_name.clone(),
                        error: e,
                    },
                );
            }
        }
    }

    // Update DB with download results
    let failed_json = serde_json::to_string(&failed_keys)
        .unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = upsert_migration_status(
        account_id,
        "in_progress",
        total as i64,
        completed as i64,
        &failed_json,
        sync_path,
        server_url,
    )
    .await
    {
        warn!("Failed to update migration status after downloads: {e}");
    }

    // Phase 2: Create the migration drive
    let _ = app.emit(
        "migration_progress",
        MigrationProgress {
            phase: "syncing".to_string(),
            current_file: String::new(),
            completed,
            total,
            failed,
        },
    );

    // Register the sync path for the "migration" label
    let owner = crate::utils::account_key::account_key(account_id);
    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO sync_paths (owner, path, type, label, timestamp)
        VALUES (?, ?, 'private', 'migration', strftime('%s', 'now'))
        ON CONFLICT(owner, label) DO UPDATE SET
            path = excluded.path,
            timestamp = excluded.timestamp
        "#,
    )
    .bind(&owner)
    .bind(&sync_path)
    .execute(pool)
    .await
    {
        warn!("Failed to register migration sync path: {e}");
    }

    // Ensure the active account is set so the sync loop can report
    // migrated files after a successful sync cycle.
    crate::utils::sync::set_active_account(account_id);

    // Initialize the migration drive
    match crate::commands::syncing::initialize_sync(
        app.clone(),
        account_id.to_string(),
        "migration".to_string(),
        mnemonic,
    )
    .await
    {
        Ok(result) => {
            info!(
                "Migration drive initialized, user_id: {}",
                result.user_id
            );
        }
        Err(e) => {
            return Err(format!(
                "Failed to initialize migration drive: {e}"
            ));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn cancel_migration(account_id: String) -> Result<(), String> {
    MIGRATION_CANCEL.store(true, Ordering::SeqCst);
    clear_migration_uploads();

    // Persist cancelled state so the migration dialog won't reappear
    if !account_id.is_empty() {
        let server_url = get_server_url(&account_id).await.unwrap_or_default();
        if let Err(e) = upsert_migration_status(
            &account_id,
            "cancelled",
            0,
            0,
            "[]",
            "",
            &server_url,
        )
        .await
        {
            warn!("Failed to persist cancelled migration status: {e}");
        }
    }
    Ok(())
}

/// Dismiss migration permanently so the dialog never shows again.
/// `reason` should be "skipped" (Start Fresh) or "completed".
#[tauri::command]
pub async fn dismiss_migration(
    account_id: String,
    reason: String,
) -> Result<(), String> {
    clear_migration_uploads();
    let server_url = get_server_url(&account_id).await.unwrap_or_default();
    let status = if reason.is_empty() { "dismissed" } else { &reason };
    upsert_migration_status(
        &account_id,
        status,
        0,
        0,
        "[]",
        "",
        &server_url,
    )
    .await?;
    info!("Migration dismissed for account {account_id} with reason: {status}");
    Ok(())
}

/// Report successfully synced files to the server.
/// Called after each sync cycle for the "migration" drive.
pub async fn report_migrated_files(
    app: &AppHandle,
    account_id: &str,
) -> Result<(), String> {
    let db_status = get_migration_status_db(account_id).await?;
    let Some((status, _total, _completed, sync_path, server_url)) =
        db_status
    else {
        return Ok(());
    };
    if status == "complete" {
        return Ok(());
    }

    // Fetch current state from server
    let files =
        fetch_migration_files(&server_url, account_id).await?;
    let pending: Vec<&MigrationFile> =
        files.iter().filter(|f| f.status.eq_ignore_ascii_case("pending")).collect();

    if pending.is_empty() {
        // All files migrated
        let migrated = files.len() as u64;
        upsert_migration_status(
            account_id,
            "complete",
            files.len() as i64,
            migrated as i64,
            "[]",
            &sync_path,
            &server_url,
        )
        .await?;
        let _ = app.emit(
            "migration_complete",
            MigrationComplete {
                total_migrated: migrated,
            },
        );
        return Ok(());
    }

    // Only report files confirmed uploaded to HCFS (not just on disk).
    // The upload progress handler records relative paths in
    // MIGRATION_UPLOADED when each file finishes uploading.
    let uploaded_set = MIGRATION_UPLOADED
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();

    let mut bucket_keys: std::collections::HashMap<
        String,
        Vec<String>,
    > = std::collections::HashMap::new();

    for file in &pending {
        let relative = format!("{}/{}", file.bucket_name, file.key);
        if uploaded_set.contains(&relative) {
            bucket_keys
                .entry(file.bucket_name.clone())
                .or_default()
                .push(file.key.clone());
        }
    }

    if bucket_keys.is_empty() {
        return Ok(());
    }

    // Report each bucket to the server
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    for (bucket_name, keys) in &bucket_keys {
        let url = format!(
            "{}/migration",
            server_url.trim_end_matches('/')
        );

        #[derive(serde::Serialize)]
        struct ReportBody {
            user_id: String,
            bucket_name: String,
            keys: Vec<String>,
        }

        let body = ReportBody {
            user_id: account_id.to_string(),
            bucket_name: bucket_name.clone(),
            keys: keys.clone(),
        };

        match client
            .post(&url)
            .header("X-API-Key", "Arion")
            .json(&body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                info!(
                    "Reported {} files for bucket '{}'",
                    keys.len(),
                    bucket_name
                );
            }
            Ok(r) => {
                let text = r.text().await.unwrap_or_default();
                warn!(
                    "Report failed for bucket '{}': {}",
                    bucket_name, text
                );
            }
            Err(e) => {
                warn!(
                    "Report request failed for '{}': {}",
                    bucket_name, e
                );
            }
        }
    }

    // Re-check completion after reporting
    let files_after =
        fetch_migration_files(&server_url, account_id).await?;
    let still_pending = files_after
        .iter()
        .filter(|f| f.status.eq_ignore_ascii_case("pending"))
        .count() as u64;
    let migrated = files_after
        .iter()
        .filter(|f| f.status.eq_ignore_ascii_case("migrated"))
        .count() as u64;

    if still_pending == 0 {
        clear_migration_uploads();
        upsert_migration_status(
            account_id,
            "complete",
            files_after.len() as i64,
            migrated as i64,
            "[]",
            &sync_path,
            &server_url,
        )
        .await?;
        let _ = app.emit(
            "migration_complete",
            MigrationComplete {
                total_migrated: migrated,
            },
        );
    } else {
        upsert_migration_status(
            account_id,
            "in_progress",
            files_after.len() as i64,
            migrated as i64,
            "[]",
            &sync_path,
            &server_url,
        )
        .await?;
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
        assert!(!should_skip_key(&format!(
            "data/{MANIFEST_PREFIX}/file"
        )));
    }

    // -----------------------------------------------------------------------
    // Path traversal detection (logic from run_migration_download)
    // -----------------------------------------------------------------------

    #[test]
    fn path_traversal_detected_for_dotdot_key() {
        // Create two sibling directories to simulate traversal
        let parent_dir =
            tempfile::tempdir().expect("create temp dir");
        let parent = parent_dir.path().canonicalize().unwrap();
        let sync_dir = parent.join("sync_root");
        let escape_target = parent.join("secret");
        std::fs::create_dir_all(sync_dir.join("files")).unwrap();
        std::fs::create_dir_all(&escape_target).unwrap();

        // Key traverses out of sync_root into sibling "secret"
        let malicious_key = "../../secret/stolen";
        let dest = sync_dir.join("files").join(malicious_key);

        // Canonicalize parent, same as run_migration_download
        let dest_parent = dest.parent().unwrap();
        let canonical = dest_parent
            .canonicalize()
            .map(|p| {
                p.join(dest.file_name().unwrap_or_default())
            })
            .unwrap();

        assert!(
            !canonical.starts_with(&sync_dir),
            "path {canonical:?} should escape {sync_dir:?}"
        );
    }

    #[test]
    fn path_traversal_detected_for_absolute_key() {
        let sync_dir = tempfile::tempdir().expect("create temp dir");
        let base = sync_dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(base.join("files")).unwrap();

        // An absolute path as the S3 key should escape the sync dir
        let malicious_key = "/etc/passwd";
        let dest = base.join("files").join(malicious_key);
        // On macOS/Linux, joining an absolute path replaces the base
        assert!(
            !dest.starts_with(&base),
            "joining absolute path should escape base: {dest:?}"
        );
    }

    #[test]
    fn path_traversal_detected_for_dotdot_in_bucket() {
        let parent_dir = tempfile::tempdir().expect("create temp dir");
        let parent = parent_dir.path().canonicalize().unwrap();
        let sync_dir = parent.join("sync_root");
        std::fs::create_dir_all(sync_dir.join("legit_bucket"))
            .unwrap();
        std::fs::create_dir_all(parent.join("escaped")).unwrap();

        // bucket_name itself contains traversal
        let dest = sync_dir.join("../escaped").join("secret.txt");
        let canonical = dest
            .parent()
            .unwrap()
            .canonicalize()
            .map(|p| p.join(dest.file_name().unwrap_or_default()))
            .unwrap();

        assert!(
            !canonical.starts_with(&sync_dir),
            "traversal via bucket should escape: {canonical:?}"
        );
    }

    #[test]
    fn normal_key_stays_within_sync_dir() {
        let sync_dir =
            tempfile::tempdir().expect("create temp dir");
        let base = sync_dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(base.join("files/documents"))
            .unwrap();

        let dest = base.join("files").join("documents/report.pdf");
        let parent = dest.parent().unwrap();
        let canonical = parent
            .canonicalize()
            .map(|p| p.join(dest.file_name().unwrap_or_default()))
            .unwrap();

        assert!(
            canonical.starts_with(&base),
            "path {canonical:?} should stay within {base:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Cancellation flag
    // -----------------------------------------------------------------------

    #[test]
    fn cancel_flag_defaults_to_false() {
        MIGRATION_CANCEL.store(false, Ordering::SeqCst);
        assert!(!MIGRATION_CANCEL.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_flag_can_be_toggled() {
        MIGRATION_CANCEL.store(true, Ordering::SeqCst);
        assert!(MIGRATION_CANCEL.load(Ordering::SeqCst));
        MIGRATION_CANCEL.store(false, Ordering::SeqCst);
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

        let filtered: Vec<MigrationFile> = files
            .into_iter()
            .filter(|f| !should_skip_key(&f.key))
            .collect();

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

        let pending: Vec<MigrationFile> = files
            .into_iter()
            .filter(|f| f.status == "Pending")
            .collect();

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

        let json = serde_json::to_string(&result)
            .expect("serialization failed");
        assert!(json.contains("\"needs_migration\":true"));
        assert!(json.contains("\"file_count\":3"));
    }

    #[test]
    fn migration_progress_serializes() {
        let progress = MigrationProgress {
            phase: "downloading".into(),
            current_file: "test.txt".into(),
            completed: 5,
            total: 10,
            failed: 1,
        };

        let json = serde_json::to_string(&progress)
            .expect("serialization failed");
        assert!(json.contains("\"phase\":\"downloading\""));
        assert!(json.contains("\"completed\":5"));
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

        let file: MigrationFile =
            serde_json::from_str(json).expect("deserialization failed");
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

        let pending: Vec<MigrationFile> = files
            .into_iter()
            .filter(|f| f.status == "Pending")
            .collect();

        assert!(pending.is_empty());
    }

    #[test]
    fn filter_empty_input_yields_empty() {
        let files: Vec<MigrationFile> = vec![];
        let pending: Vec<MigrationFile> = files
            .into_iter()
            .filter(|f| f.status == "Pending")
            .collect();
        assert!(pending.is_empty());
    }

    #[test]
    fn total_size_with_zero_byte_files() {
        let files = vec![
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
        let result: Result<MigrationFile, _> =
            serde_json::from_str(json);
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

        let resp: ServerMigrationResponse =
            serde_json::from_str(json).expect("deserialization failed");
        assert!(resp.needs_migration);
        assert_eq!(resp.files.len(), 2);
        assert_eq!(resp.files[0].status, "Pending");
        assert_eq!(resp.files[1].status, "Migrated");
    }

    // -----------------------------------------------------------------------
    // MIGRATION_UPLOADED tracker
    // -----------------------------------------------------------------------

    #[test]
    fn record_and_clear_migration_uploads() {
        clear_migration_uploads();

        record_migration_upload("bucket/file1.txt".to_string());
        record_migration_upload("bucket/file2.txt".to_string());

        {
            let set = MIGRATION_UPLOADED.lock().unwrap();
            assert_eq!(set.len(), 2);
            assert!(set.contains("bucket/file1.txt"));
            assert!(set.contains("bucket/file2.txt"));
        }

        clear_migration_uploads();

        {
            let set = MIGRATION_UPLOADED.lock().unwrap();
            assert!(set.is_empty());
        }
    }

    #[test]
    fn duplicate_upload_records_are_deduplicated() {
        clear_migration_uploads();

        record_migration_upload("bucket/same.txt".to_string());
        record_migration_upload("bucket/same.txt".to_string());

        let set = MIGRATION_UPLOADED.lock().unwrap();
        assert_eq!(set.len(), 1);
        drop(set);

        clear_migration_uploads();
    }

    // -----------------------------------------------------------------------
    // Path canonicalization (Bug 2 fix verification)
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn symlinked_sync_dir_does_not_cause_false_positive() {
        let parent_dir = tempfile::tempdir().expect("create temp dir");
        let parent = parent_dir.path().canonicalize().unwrap();

        let real_dir = parent.join("real_sync");
        std::fs::create_dir_all(&real_dir).unwrap();

        let link_path = parent.join("link_sync");
        std::os::unix::fs::symlink(&real_dir, &link_path).unwrap();

        // Simulate the fixed code: canonicalize sync_dir first
        let sync_dir = link_path
            .canonicalize()
            .unwrap_or_else(|_| link_path.clone());

        std::fs::create_dir_all(sync_dir.join("bucket")).unwrap();
        let dest = sync_dir.join("bucket").join("file.txt");
        std::fs::write(&dest, "test").unwrap();

        let canonical = dest.canonicalize().unwrap();
        assert!(
            canonical.starts_with(&sync_dir),
            "canonical {canonical:?} should start with {sync_dir:?}"
        );
    }
}
