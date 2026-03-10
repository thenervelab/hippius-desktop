use crate::DB_POOL;
use aws_credential_types::Credentials;
use aws_sdk_s3::Client as S3Client;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

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
        if status == "complete" {
            return Ok(MigrationCheckResult {
                needs_migration: false,
                file_count: 0,
                total_size: 0,
                files: vec![],
                sync_path: None,
                is_resuming: false,
            });
        }
        // In-progress -- check server for remaining files
        let server_url = get_server_url(&account_id).await?;
        let files =
            fetch_migration_files(&server_url, &account_id).await?;
        let pending: Vec<MigrationFile> = files
            .into_iter()
            .filter(|f| f.status == "Pending")
            .collect();
        let total_size: u64 = pending.iter().map(|f| f.size_bytes).sum();
        return Ok(MigrationCheckResult {
            needs_migration: !pending.is_empty(),
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
        .filter(|f| f.status == "Pending")
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
        crate::utils::objectstore_tokens::get_master_token(account_id)
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
    app: AppHandle,
    account_id: String,
    sync_path: String,
) -> Result<(), String> {
    MIGRATION_CANCEL.store(false, Ordering::SeqCst);

    // Ensure S3 credentials exist
    crate::utils::objectstore_tokens::ensure_master_token_or_fetch(
        &account_id,
    )
    .await?;

    // Fetch pending files from server
    let server_url = get_server_url(&account_id).await?;
    let all_files =
        fetch_migration_files(&server_url, &account_id).await?;
    let pending: Vec<MigrationFile> = all_files
        .into_iter()
        .filter(|f| f.status == "Pending")
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
    let app_clone = app.clone();
    let account_clone = account_id.clone();
    let path_clone = sync_path.clone();
    let server_clone = server_url.clone();

    let handle = tokio::spawn(async move {
        if let Err(e) = run_migration_download(
            &app_clone,
            &s3_client,
            &account_clone,
            &path_clone,
            &server_clone,
            &pending,
        )
        .await
        {
            let _ = app_clone.emit(
                "migration_error",
                MigrationError {
                    error: e.clone(),
                },
            );
            println!("[Migration] Background task failed: {e}");
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
) -> Result<(), String> {
    let total = files.len() as u64;
    let mut completed: u64 = 0;
    let mut failed: u64 = 0;
    let mut failed_keys: Vec<String> = Vec::new();

    for file in files {
        if MIGRATION_CANCEL.load(Ordering::SeqCst) {
            println!("[Migration] Cancelled by user");
            break;
        }

        if should_skip_key(&file.key) {
            completed += 1;
            continue;
        }

        let sync_dir = std::path::Path::new(&sync_path);
        let dest = sync_dir
            .join(&file.bucket_name)
            .join(&file.key);

        // Prevent path traversal via malicious S3 keys
        if let Ok(canonical) = dest.canonicalize().or_else(|_| {
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
        }) {
            if !canonical.starts_with(sync_dir) {
                failed += 1;
                failed_keys.push(file.key.clone());
                let _ = app.emit(
                    "migration_file_error",
                    MigrationFileError {
                        file_name: file.key.clone(),
                        bucket: file.bucket_name.clone(),
                        error: "Path traversal detected".to_string(),
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
                    current_file: file.key.clone(),
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
                        file_name: file.key.clone(),
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
    let _ = upsert_migration_status(
        &account_id,
        "in_progress",
        total as i64,
        completed as i64,
        &failed_json,
        &sync_path,
        &server_url,
    )
    .await;

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
    if let Some(pool) = DB_POOL.get() {
        let _ = sqlx::query(
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
        .await;
    }

    // Verify HCFS config exists — migration requires sync to be set up first
    if let Err(_) = crate::commands::syncing::get_drive_password(account_id).await {
        return Err(
            "Please set up sync before migrating. \
             Go to Files and configure your sync folder first."
                .to_string(),
        );
    }

    // Initialize the migration drive
    match crate::commands::syncing::initialize_sync(
        app.clone(),
        account_id.to_string(),
        "migration".to_string(),
        None,
    )
    .await
    {
        Ok(result) => {
            println!(
                "[Migration] Drive initialized, user_id: {}",
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
pub async fn cancel_migration() -> Result<(), String> {
    MIGRATION_CANCEL.store(true, Ordering::SeqCst);
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
        files.iter().filter(|f| f.status == "Pending").collect();

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

    // Check which pending files exist on disk (already synced)
    let mut bucket_keys: std::collections::HashMap<
        String,
        Vec<String>,
    > = std::collections::HashMap::new();

    for file in &pending {
        let file_path = std::path::Path::new(&sync_path)
            .join(&file.bucket_name)
            .join(&file.key);
        if file_path.exists() {
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
                println!(
                    "[Migration] Reported {} files for bucket '{}'",
                    keys.len(),
                    bucket_name
                );
            }
            Ok(r) => {
                let text = r.text().await.unwrap_or_default();
                println!(
                    "[Migration] Report failed for bucket '{}': {}",
                    bucket_name, text
                );
            }
            Err(e) => {
                println!(
                    "[Migration] Report request failed for '{}': {}",
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
        .filter(|f| f.status == "Pending")
        .count() as u64;
    let migrated = files_after
        .iter()
        .filter(|f| f.status == "Migrated")
        .count() as u64;

    if still_pending == 0 {
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
