//! Server-side migration commands.
//!
//! Handles the one-time migration of files from legacy S3/CAS storage to the
//! new HCFS encrypted drive system. The server downloads files from S3,
//! encrypts them, and uploads to Arion. The desktop polls for progress.
//!
//! The flow is: `check_migration` → `start_server_migration` → poll via
//! `poll_migration_status` → `complete_migration_transition` (ensure sync
//! path exists, initialize default drive, mark completed).

use ed25519_dalek::Signer;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tracing::info;

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
    let owner = crate::auth::account_key::account_key(account_id);
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
    files.first().map(|f| f.bucket_name.clone()).unwrap_or_default()
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
async fn fetch_s3_credentials(client: &reqwest::Client, pool: &SqlitePool, account_id: &str) -> Result<(String, String), crate::error::AppError> {
    let api_token = crate::auth::tokens::get_api_token(pool, account_id)
        .await
        .map_err(crate::error::AppError::Other)?
        .ok_or_else(|| crate::error::AppError::Other("No API token available — log in first".into()))?;

    let api_base = std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| "https://api.hippius.com/api".to_string());
    let url = format!("{}/objectstore/master-tokens/", api_base.trim_end_matches('/'));

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

    // Only respect explicit user dismissal (skipped/dismissed).
    // For everything else, the server is the source of truth.
    if let Some((status, ..)) = get_migration_status_db(pool, &account_id).await?
        && (status.eq_ignore_ascii_case("dismissed") || status.eq_ignore_ascii_case("skipped"))
    {
        return Ok(MigrationCheckResult {
            needs_migration: false,
            file_count: 0,
            total_size: 0,
            files: vec![],
            sync_path: None,
            is_resuming: false,
        });
    }

    // Always check the server for pending migration files
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

/// Compute a sensible default directory for the sync folder when the user
/// hasn't explicitly chosen one (e.g., during migration completion).
///
/// Prefers `~/Documents/Hippius`, falling back to `~/Hippius`.
fn compute_default_sync_path() -> Result<PathBuf, crate::error::AppError> {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| crate::error::AppError::Other("Could not determine a suitable directory for sync folder".into()))?;
    Ok(base.join("Hippius"))
}

/// Complete the migration lifecycle: ensure a sync path exists, initialize
/// the default drive, and mark migration as completed.
///
/// If no sync path for "default" exists (common for new users going through
/// migration), one is created automatically at `~/Documents/Hippius`.
/// The migration status is marked "completed" only after `initialize_sync`
/// succeeds, so a failed init can be retried.
#[tauri::command]
pub async fn complete_migration_transition(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    existing_mnemonic: Option<String>,
) -> Result<crate::sync::lifecycle::InitSyncResult, crate::error::AppError> {
    let pool = state.pool()?;

    // 1. Clear migration-in-progress flag so initialize_sync isn't blocked.
    state.migration.in_progress.store(false, Ordering::SeqCst);

    // 2. Ensure a sync path exists for "default". New migration users won't
    //    have one yet; existing users who already configured sync will.
    let has_sync_path = crate::sync::config::get_sync_path_for_label(pool, &account_id, "default").await.is_ok();

    if !has_sync_path {
        let default_path = compute_default_sync_path()?;
        std::fs::create_dir_all(&default_path)?;
        let path_str = default_path.to_string_lossy().to_string();
        crate::sync::paths::set_sync_path_internal(pool, &account_id, &path_str, false, Some("default")).await?;
        info!("Created default sync path at '{}' for migration completion", path_str);
    }

    // 3. Initialize the "default" drive and start the sync loop.
    let result = crate::sync::lifecycle::initialize_sync(app, account_id.clone(), "default".to_string(), existing_mnemonic).await?;

    // 4. Mark migration as completed ONLY after sync init succeeds.
    //    If init fails, the ? above propagates the error and this line
    //    never runs — the user can retry or set up sync manually.
    let server_url = get_server_url(pool, &account_id).await.unwrap_or_default();
    upsert_migration_status(pool, &account_id, "completed", 0, 0, "[]", "", &server_url).await?;
    info!("Migration completed for account {account_id}");

    Ok(result)
}

// ---------------------------------------------------------------------------
// Server-side migration commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct StartServerMigrationResult {
    pub status: String,
    pub total_files: i32,
}

/// Raw response from the server's poll endpoint.
#[derive(Debug, Deserialize)]
struct RawServerMigrationStatus {
    pub status: String,
    pub total: i32,
    pub completed: i32,
    pub failed: i32,
    pub failed_files: Vec<String>,
    pub current_file: Option<String>,
}

/// Poll result returned to the frontend, enriched with retry flags.
///
/// `should_warn` and `should_abort` are computed from consecutive poll
/// failure tracking in Rust, replacing the retry logic that was in
/// `useMigration.ts`.
#[derive(Debug, Serialize)]
pub struct ServerMigrationStatus {
    pub status: String,
    pub total: i32,
    pub completed: i32,
    pub failed: i32,
    pub failed_files: Vec<String>,
    pub current_file: Option<String>,
    /// True when 3+ consecutive poll failures (frontend should show warning toast)
    pub should_warn: bool,
    /// True when 10+ consecutive poll failures (frontend should abort polling)
    pub should_abort: bool,
}

const WARN_AFTER_POLL_FAILURES: i32 = 3;
const ABORT_AFTER_POLL_FAILURES: i32 = 10;

/// Result of `start_migration_flow` — tells the frontend which step to show.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationFlowResult {
    /// "setup" if HCFS config is missing (show setup dialog),
    /// "progress" if config exists (migration is launching).
    pub next_step: String,
}

/// Check if HCFS config exists and decide the next migration step.
///
/// Replaces the config check + step transition in `useMigration.ts:startMigration`.
/// Returns "setup" if the user needs to set up encryption first, or "progress"
/// if migration can start immediately.
#[tauri::command]
pub async fn start_migration_flow(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<MigrationFlowResult, crate::error::AppError> {
    let pool = state.pool()?;
    let config = crate::sync::config::get_hcfs_config_internal(pool, &account_id).await?;

    if !config.has_password {
        Ok(MigrationFlowResult {
            next_step: "setup".to_string(),
        })
    } else {
        Ok(MigrationFlowResult {
            next_step: "progress".to_string(),
        })
    }
}

#[tauri::command]
pub async fn start_server_migration(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    total_size: u64,
) -> Result<StartServerMigrationResult, crate::error::AppError> {
    state.migration.in_progress.store(true, Ordering::SeqCst);
    state.migration.poll_failure_count.store(0, Ordering::SeqCst);

    // Migrated files always land in the "default" folder — the only
    // user-visible drive label after migration completes.
    let folder_hash = hcfs_client::drive::keys::folder_hash("default");
    let pool = state.pool()?;

    // Derive path_prefix from server migration files (bucket name)
    let server_url = get_server_url(pool, &account_id).await?;
    let files = fetch_migration_files(&state.migration.client, &server_url, &account_id).await?;
    let path_prefix = derive_path_prefix(&files);

    // Check disk space — files will be downloaded locally after server migration
    let sync_path = crate::sync::config::get_sync_path_for_label(pool, &account_id, "default")
        .await
        .unwrap_or_else(|_| dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_default());
    let sync_dir = std::path::Path::new(&sync_path);
    if sync_dir.exists() {
        check_disk_space(sync_dir, total_size)?;
    }

    // Recover the master mnemonic to derive the encryption key
    let password = crate::sync::config::get_drive_password(pool, &account_id).await?;
    let mnemonic_path = crate::sync::mnemonic::master_mnemonic_path(&account_id)?;
    let mnemonic = hcfs_client::auth::recover_mnemonic(&mnemonic_path, &password)
        .map_err(|e| crate::error::AppError::Other(format!("Failed to recover mnemonic: {e}")))?;

    let seed = mnemonic.to_seed("");
    let encryption_key_hex = hex::encode(&seed[..32]);

    // Derive Ed25519 signing key from seed
    let signing_key =
        hcfs_client::auth::recover_signing_key(seed).map_err(|e| crate::error::AppError::Other(format!("Failed to derive signing key: {e}")))?;

    // Sign the migration request
    let signing_text = format!(
        "I hereby declare that I am requesting migration of folder \
         {folder_hash} for account {account_id} on HCFS with the \
         understanding that I have read and agree to the Terms of Service"
    );
    let signature = signing_key.sign(signing_text.as_bytes());

    // Fetch per-user S3 credentials from Hippius API
    let (s3_access_key, s3_secret_key) = fetch_s3_credentials(&state.migration.client, pool, &account_id).await?;

    // Call server endpoint — use a longer timeout since the server
    // validates credentials and sets up the migration job.
    let url = format!("{}/migration/start", server_url.trim_end_matches('/'));

    let resp = state
        .migration
        .client
        .post(&url)
        .timeout(std::time::Duration::from_secs(120))
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
        return Err(crate::error::AppError::Other(format!("Migration start failed: {text}")));
    }

    let result: StartServerMigrationResult = resp.json().await?;
    Ok(result)
}

/// Internal poll — callable from both the IPC command and the background task.
async fn poll_migration_status_internal(
    state: &crate::app_state::AppState,
    account_id: &str,
) -> Result<ServerMigrationStatus, crate::error::AppError> {
    let pool = state.pool()?;
    let server_url = get_server_url(pool, account_id).await?;
    let url = format!("{}/migration/{}/status", server_url.trim_end_matches('/'), account_id);

    let result = async {
        let resp = state.migration.client.get(&url).send().await?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(crate::error::AppError::Other(format!("Status check failed: {text}")));
        }
        resp.json::<RawServerMigrationStatus>().await.map_err(Into::into)
    }
    .await;

    match result {
        Ok(raw) => {
            state.migration.poll_failure_count.store(0, Ordering::SeqCst);
            Ok(ServerMigrationStatus {
                status: raw.status,
                total: raw.total,
                completed: raw.completed,
                failed: raw.failed,
                failed_files: raw.failed_files,
                current_file: raw.current_file,
                should_warn: false,
                should_abort: false,
            })
        }
        Err(_) => {
            let failures = state.migration.poll_failure_count.fetch_add(1, Ordering::SeqCst) + 1;
            let should_warn = failures >= WARN_AFTER_POLL_FAILURES;
            let should_abort = failures >= ABORT_AFTER_POLL_FAILURES;
            if should_abort {
                state.migration.poll_failure_count.store(0, Ordering::SeqCst);
            }
            Ok(ServerMigrationStatus {
                status: "poll_error".to_string(),
                total: 0,
                completed: 0,
                failed: 0,
                failed_files: Vec::new(),
                current_file: None,
                should_warn,
                should_abort,
            })
        }
    }
}

#[tauri::command]
pub async fn poll_migration_status(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
) -> Result<ServerMigrationStatus, crate::error::AppError> {
    poll_migration_status_internal(&state, &account_id).await
}

/// Terminal migration statuses — no more polling needed.
const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

/// Start background migration polling. Emits `migration_progress` events every 3s.
///
/// Replaces the `setInterval` polling loop in `useMigration.ts`. The frontend
/// listens for events instead of driving the poll loop.
#[tauri::command]
pub async fn start_migration_polling(app: tauri::AppHandle, account_id: String) -> Result<(), crate::error::AppError> {
    use tauri::{Emitter, Manager};

    // Cancel any existing poll task
    {
        let state = app.state::<crate::app_state::AppState>();
        let mut guard = state.migration.poll_task.lock().await;
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }

    let app_clone = app.clone();
    let account_id_clone = account_id.clone();

    let handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;

            let state = app_clone.state::<crate::app_state::AppState>();
            match poll_migration_status_internal(state.inner(), &account_id_clone).await {
                Ok(status) => {
                    let is_terminal = TERMINAL_STATUSES.contains(&status.status.as_str());
                    let should_abort = status.should_abort;
                    let _ = app_clone.emit("migration_progress", &status);
                    if is_terminal || should_abort {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!("Migration poll error: {e}");
                    break;
                }
            }
        }
    });

    // Store the handle so it can be cancelled
    let state = app.state::<crate::app_state::AppState>();
    let mut guard = state.migration.poll_task.lock().await;
    *guard = Some(handle);

    // Also poll immediately (don't wait 3s for the first result)
    let immediate = poll_migration_status_internal(&app.state::<crate::app_state::AppState>(), &account_id).await?;
    let _ = app.emit("migration_progress", &immediate);

    Ok(())
}

/// Stop background migration polling.
#[tauri::command]
pub async fn stop_migration_polling(app: tauri::AppHandle) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();
    let mut guard = state.migration.poll_task.lock().await;
    if let Some(handle) = guard.take() {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_server_migration(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<(), crate::error::AppError> {
    state.migration.in_progress.store(false, Ordering::SeqCst);
    let pool = state.pool()?;
    let server_url = get_server_url(pool, &account_id).await?;
    let url = format!("{}/migration/cancel", server_url.trim_end_matches('/'));

    let resp = state
        .migration
        .client
        .post(&url)
        .json(&serde_json::json!({
            "ss58_address": account_id,
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Other(format!("Cancel failed: {text}")));
    }

    Ok(())
}

// --- Migration State ---

use std::sync::atomic::{AtomicBool, AtomicI32};

/// State for the server-side migration workflow.
pub struct MigrationState {
    pub in_progress: AtomicBool,
    pub poll_failure_count: AtomicI32,
    pub client: reqwest::Client,
    /// Handle for the background migration polling task (if running).
    pub poll_task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl MigrationState {
    pub fn new() -> Self {
        let client = {
            #[allow(unused_mut)]
            let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));
            #[cfg(debug_assertions)]
            {
                builder = builder.danger_accept_invalid_certs(true);
            }
            builder.build().expect("Failed to build migration HTTP client")
        };
        Self {
            in_progress: AtomicBool::new(false),
            poll_failure_count: AtomicI32::new(0),
            client,
            poll_task: tokio::sync::Mutex::new(None),
        }
    }
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
        let ms = crate::sync::migration::MigrationState::new();
        assert!(!ms.in_progress.load(Ordering::SeqCst));
    }

    #[test]
    fn in_progress_can_be_toggled() {
        let ms = crate::sync::migration::MigrationState::new();
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
        let h1 = hcfs_client::drive::keys::folder_hash("default");
        let h2 = hcfs_client::drive::keys::folder_hash("default");
        assert_eq!(h1, h2);
    }

    #[test]
    fn folder_hash_is_16_chars() {
        let hash = hcfs_client::drive::keys::folder_hash("default");
        assert_eq!(hash.len(), 16);
    }

    #[test]
    fn folder_hash_differs_by_label() {
        let h1 = hcfs_client::drive::keys::folder_hash("default");
        let h2 = hcfs_client::drive::keys::folder_hash("migration");
        assert_ne!(h1, h2);
    }

    #[test]
    fn folder_hash_empty_label() {
        let hash = hcfs_client::drive::keys::folder_hash("");
        assert_eq!(hash.len(), 16);
    }

    // -----------------------------------------------------------------------
    // compute_default_sync_path
    // -----------------------------------------------------------------------

    #[test]
    fn default_sync_path_ends_with_hippius() {
        let path = compute_default_sync_path().expect("should resolve a default path");
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("Hippius"),);
    }

    #[test]
    fn default_sync_path_under_documents_or_home() {
        let path = compute_default_sync_path().expect("should resolve a default path");
        let parent = path.parent().expect("path should have a parent");
        let doc_dir = dirs::document_dir();
        let home_dir = dirs::home_dir();
        assert!(
            doc_dir.as_ref() == Some(&parent.to_path_buf()) || home_dir.as_ref() == Some(&parent.to_path_buf()),
            "Expected parent to be Documents or Home, got {:?}",
            parent,
        );
    }
}
