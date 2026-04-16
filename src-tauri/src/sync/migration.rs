//! Server-side migration commands.
//!
//! Handles the one-time migration of files from legacy S3/CAS storage to the
//! new HCFS encrypted drive system. The server downloads files from S3,
//! encrypts them, and uploads to Arion. The desktop polls for progress.
//!
//! The flow is: `check_migration` → `start_server_migration` → poll via
//! `poll_migration_status` → `complete_migration_transition` (ensure sync
//! path exists, initialize default drive, mark completed).

use crate::error::Result;
// Single source of truth for "look up this account's HCFS server URL".
// Migration used to carry its own copy that diverged only in error-wrapping
// wording; routing through `sync::remote` keeps the default URL + empty-string
// fallback + schema in exactly one place.
use crate::sync::remote::get_server_url;
use ed25519_dalek::Signer;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Derive the HCFS drive label for a migration destination path.
///
/// The rule is: take the path's last non-empty component (the directory
/// name the user chose for migrated files), sanitize it for filesystem
/// safety, and fall back to `"default"` when no path is given or the
/// sanitized name is empty. Previously both `launchServerMigration` and
/// `closeMigration` in `useMigration.ts` had their own copy of this
/// snippet — keeping it in Rust closes the "what if the two diverge?"
/// class of bug and lets the frontend stop threading a redundant
/// `label` argument through every migration IPC.
pub(crate) fn derive_migration_label(sync_path: Option<&str>) -> String {
    let candidate = sync_path
        .and_then(|p| {
            std::path::Path::new(p)
                .components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(os) => os.to_str(),
                    _ => None,
                })
                .next_back()
                .map(str::to_string)
        })
        .unwrap_or_default();

    crate::sync::folders::sanitize_label(&candidate).unwrap_or_else(|_| "default".to_string())
}

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
    pub sync_path: Option<String>,
    pub is_resuming: bool,
    /// Server migration finished but `complete_migration_transition` never ran
    /// (e.g. app restarted). Frontend should show the completion dialog.
    pub needs_completion: bool,
    /// When `needs_completion` is true, the server job's final status
    /// ("completed", "failed", "cancelled") so the frontend can determine success.
    pub completion_status: Option<String>,
    /// Server migration is actively running (app was reopened mid-migration).
    /// Frontend should show the progress banner and start polling.
    pub is_in_progress: bool,
    /// Current progress when `is_in_progress` is true.
    pub progress_completed: u64,
    pub progress_total: u64,
    pub progress_failed: u64,
}

/// Server response from GET /migration/{user_id}
///
/// Handles both old format (`files` array) and new format (`pending_count`).
/// Old servers return `files` + no `pending_count`; new servers return
/// `pending_count` + no `files`. Serde defaults make both work.
#[derive(Debug, Deserialize)]
#[expect(dead_code, reason = "fields exist for serde deserialization")]
pub(crate) struct ServerMigrationResponse {
    needs_migration: bool,
    file_count: i64,
    pub(crate) total_size: i64,
    /// New servers: count of pending files (preferred).
    #[serde(default)]
    pub(crate) pending_count: i64,
    /// Logical file count from `file_records` — the real number of user
    /// files, excluding S3 chunks and metadata objects. Preferred over
    /// `pending_count` for display when available.
    #[serde(default)]
    pub(crate) logical_file_count: Option<i64>,
    /// Old servers: full file list. Only used to derive pending_count
    /// when the server hasn't been upgraded yet.
    #[serde(default)]
    files: Vec<MigrationFile>,
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

pub(crate) async fn get_migration_status_db(pool: &SqlitePool, account_id: &str) -> Result<Option<(String, i64, i64, String, String)>> {
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
) -> Result<()> {
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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/// Fetch the migration summary from the server.
///
/// Handles both old servers (returns `files` array, no `pending_count`)
/// and new servers (returns `pending_count`, no `files`). When the old
/// format is detected, `pending_count` and `total_size` are derived
/// from the file list.
pub(crate) async fn fetch_migration_summary(client: &reqwest::Client, server_url: &str, user_id: &str) -> Result<ServerMigrationResponse> {
    let url = format!("{}/migration/{}", server_url.trim_end_matches('/'), user_id);
    let resp = client
        .get(&url)
        // Old servers may take a while enumerating large buckets
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Other(format!("Migration check failed (status {status}): {text}")));
    }

    let mut summary: ServerMigrationResponse = resp.json().await?;

    // Old server format: pending_count is 0 (default) but files[] is populated.
    // Derive the counts from the file list.
    if summary.pending_count == 0 && !summary.files.is_empty() {
        let pending: Vec<&MigrationFile> = summary.files.iter().filter(|f| f.status.eq_ignore_ascii_case("pending")).collect();
        summary.pending_count = pending.len() as i64;
        summary.total_size = pending.iter().map(|f| f.size_bytes as i64).sum();
    }

    Ok(summary)
}

/// Fetch per-user S3 credentials from the Hippius API.
///
/// The server-side migration worker uses these credentials to download the
/// user's files from the legacy S3 storage (s3.hippius.com).
async fn fetch_s3_credentials(client: &reqwest::Client, pool: &SqlitePool, account_id: &str) -> Result<(String, String)> {
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
fn check_disk_space(path: &std::path::Path, required_bytes: u64) -> Result<()> {
    let stat = nix::sys::statvfs::statvfs(path).map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    let available = stat.block_size() as u64 * stat.blocks_available() as u64;
    if available < required_bytes {
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::NotEnoughDiskSpace));
    }
    Ok(())
}

#[cfg(windows)]
fn check_disk_space(_path: &std::path::Path, _required_bytes: u64) -> Result<()> {
    // Disk space check not yet implemented on Windows
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_lines)]
#[tauri::command]
pub async fn check_migration(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<MigrationCheckResult> {
    info!("[Migration] check_migration called for account: {}", &account_id);
    let pool = state.pool()?;

    let local_status = get_migration_status_db(pool, &account_id).await?;
    info!("[Migration] Local DB status: {:?}", local_status.as_ref().map(|(s, ..)| s.as_str()));

    // The server is the sole source of truth for migration status.
    // Even if local DB says dismissed/skipped/completed, always check
    // the server — the user may have new files that need migrating.

    let server_url = get_server_url(pool, &account_id).await?;

    // ── Step 1: Check if a server migration job is already running ──
    // This must come BEFORE the pending-files check because files remain
    // "pending" on the listing endpoint while the job is actively
    // migrating them. Without this check the user would see the "Start
    // Migration" prompt even though migration is already in progress.
    let has_local_in_progress = local_status.as_ref().is_some_and(|(s, ..)| s.eq_ignore_ascii_case("in_progress"));

    if has_local_in_progress && let Ok(job_status) = poll_migration_status_internal(&state, &account_id).await {
        if job_status.status == "in_progress" {
            let logical_total = job_status.logical_file_count
                .filter(|&c| c > 0)
                .map_or(job_status.total as u64, |c| c as u64);
            info!(
                completed = job_status.completed,
                total = job_status.total,
                logical_total,
                "Server migration still in progress — resuming tracking"
            );
            // Set the atomic flag so auto_init_sync (which reads this) won't
            // race against the active server migration after an app restart.
            state.migration.in_progress.store(true, std::sync::atomic::Ordering::SeqCst);
            return Ok(MigrationCheckResult {
                needs_migration: false,
                file_count: 0,
                total_size: 0,

                sync_path: None,
                is_resuming: false,
                needs_completion: false,
                completion_status: None,
                is_in_progress: true,
                progress_completed: logical_total.min(job_status.completed as u64),
                progress_total: logical_total,
                progress_failed: job_status.failed as u64,
            });
        }

        const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
        if TERMINAL_STATUSES.contains(&job_status.status.as_str()) {
            info!(
                status = %job_status.status,
                "Server migration finished but client transition pending — prompting user"
            );
            // Prefer the logical file count (real file_records) over the
            // S3 object count so the completion dialog shows a meaningful number.
            let logical_count = job_status.logical_file_count.map_or(job_status.total as u64, |c| c as u64);
            return Ok(MigrationCheckResult {
                needs_migration: false,
                file_count: logical_count,
                total_size: 0,
                sync_path: None,
                is_resuming: false,
                needs_completion: true,
                completion_status: Some(job_status.status),
                is_in_progress: false,
                progress_completed: logical_count.min(job_status.completed as u64),
                progress_total: logical_count,
                progress_failed: job_status.failed as u64,
            });
        }
    }

    // ── Step 2: No active job — check for pending files that need migration ──
    info!("[Migration] Checking server at: {server_url}/migration/{account_id}");
    let summary = match fetch_migration_summary(&state.migration.client, &server_url, &account_id).await {
        Ok(s) => {
            info!(
                "[Migration] Server returned: pending_count={}, total_size={}",
                s.pending_count, s.total_size
            );
            s
        }
        Err(e) => {
            tracing::error!("[Migration] Server check failed: {e}");
            return Err(e);
        }
    };

    if summary.pending_count > 0 {
        // Prefer the logical file count (real user files) over the raw S3
        // object count which includes multipart chunks, metadata objects, etc.
        let display_count = summary
            .logical_file_count
            .filter(|&c| c > 0)
            .map_or(summary.pending_count as u64, |c| c as u64);
        let total_size = summary.total_size as u64;
        info!(
            pending_s3 = summary.pending_count,
            logical = ?summary.logical_file_count,
            display = display_count,
            "[Migration] Migration needed"
        );
        return Ok(MigrationCheckResult {
            needs_migration: true,
            file_count: display_count,
            total_size,

            sync_path: None,
            is_resuming: false,
            needs_completion: false,
            completion_status: None,
            is_in_progress: false,
            progress_completed: 0,
            progress_total: 0,
            progress_failed: 0,
        });
    }

    Ok(MigrationCheckResult {
        needs_migration: false,
        file_count: 0,
        total_size: 0,
        sync_path: None,
        is_resuming: false,
        needs_completion: false,
        completion_status: None,
        is_in_progress: false,
        progress_completed: 0,
        progress_total: 0,
        progress_failed: 0,
    })
}

/// Dismiss migration permanently so the dialog never shows again.
/// `reason` should be "skipped" (Start Fresh) or "dismissed".
///
/// For completed migrations, use `complete_migration_transition` instead —
/// it handles label promotion, drive stop, and default drive init atomically.
#[tauri::command]
pub async fn dismiss_migration(state: tauri::State<'_, crate::app_state::AppState>, account_id: String, reason: String) -> Result<()> {
    let pool = state.pool()?;
    let server_url = get_server_url(pool, &account_id).await.unwrap_or_default();
    let status = if reason.is_empty() { "dismissed" } else { &reason };

    upsert_migration_status(pool, &account_id, status, 0, 0, "[]", "", &server_url).await?;

    // Abort any background poll task internally so the frontend doesn't
    // need a separate stop_migration_polling round-trip.
    {
        let mut guard = state.migration.poll_task.lock().await;
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }
    state.migration.in_progress.store(false, Ordering::SeqCst);

    info!("Migration dismissed for account {account_id} with reason: {status}");
    Ok(())
}

/// Compute a sensible default directory for the sync folder when the user
/// hasn't explicitly chosen one (e.g., during migration completion).
///
/// Uses `~/Documents/Hippius-Migration-YYYY-MM-DD` (falling back to
/// `~/Hippius-Migration-YYYY-MM-DD`). If that path already exists, a
/// numeric suffix is appended (`-2`, `-3`, ...) to guarantee uniqueness.
pub(crate) fn compute_default_sync_path() -> Result<PathBuf> {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| crate::error::AppError::Other("Could not determine a suitable directory for sync folder".into()))?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let stem = format!("Hippius-Migration-{today}");
    let candidate = base.join(&stem);
    if !candidate.exists() {
        return Ok(candidate);
    }
    for i in 2..=100 {
        let suffixed = base.join(format!("{stem}-{i}"));
        if !suffixed.exists() {
            return Ok(suffixed);
        }
    }
    Err(crate::error::AppError::Other("Too many migration folders exist for today's date".into()))
}

/// Return the auto-generated default migration sync path as a string.
///
/// Called by the frontend to pre-populate the folder picker in the
/// migration prompt dialog.
#[tauri::command]
pub fn get_default_migration_path() -> Result<String> {
    let path = compute_default_sync_path()?;
    Ok(path.to_string_lossy().to_string())
}

/// Complete the migration lifecycle: ensure a sync path exists, initialize
/// the default drive, and mark migration as completed.
///
/// If no sync path for the given label exists (common for new users going
/// through migration), one is created automatically at
/// `~/Documents/Hippius-Migration-YYYY-MM-DD`. The migration status is
/// marked "completed" only after `initialize_sync` succeeds, so a failed
/// init can be retried.
#[tauri::command]
pub async fn complete_migration_transition(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    custom_sync_path: Option<String>,
) -> Result<crate::sync::lifecycle::InitSyncResult> {
    let label = derive_migration_label(custom_sync_path.as_deref());
    let pool = state.pool()?;

    // 1. Clear migration-in-progress flag so initialize_sync isn't blocked.
    state.migration.in_progress.store(false, Ordering::SeqCst);

    // 2. Ensure a sync path exists for the label. New migration users won't
    //    have one yet; existing users who already configured sync will.
    let has_sync_path = crate::sync::config::get_sync_path_for_label(pool, &account_id, &label).await.is_ok();

    if !has_sync_path {
        let sync_path = match custom_sync_path.filter(|p| !p.is_empty()) {
            Some(path) => std::path::PathBuf::from(path),
            None => compute_default_sync_path()?,
        };
        std::fs::create_dir_all(&sync_path)?;
        let path_str = sync_path.to_string_lossy().to_string();
        crate::sync::paths::set_sync_path_internal(pool, &account_id, &path_str, false, Some(&label)).await?;
        info!("Created sync path at '{}' for migration label '{}'", path_str, label);
    } else if custom_sync_path.as_ref().is_some_and(|p| !p.is_empty()) {
        warn!(
            "custom_sync_path provided but sync path already exists for '{}'; ignoring custom path",
            label
        );
    }

    // 3. Initialize the drive for the migration label.
    let mnemonic_z = crate::sync::mnemonic::get_mnemonic_for_account(&state, &account_id).await?;
    let mnemonic = (*mnemonic_z).clone();
    drop(mnemonic_z);
    let result = crate::sync::lifecycle::initialize_sync(app, account_id.clone(), label.clone(), Some(mnemonic)).await?;

    // 4. Mark migration as completed ONLY after sync init succeeds.
    let server_url = get_server_url(pool, &account_id).await.unwrap_or_default();
    upsert_migration_status(pool, &account_id, "completed", 0, 0, "[]", "", &server_url).await?;
    info!("Migration completed for account {account_id}, label '{label}'");

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
    /// Real file count from `file_records`, set when migration completes.
    #[serde(default)]
    pub logical_file_count: Option<i32>,
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
    /// Real file count from `file_records`, set when migration completes.
    /// The `total`/`completed` fields count S3 objects, which may differ
    /// from the number of logical user files.
    pub logical_file_count: Option<i32>,
    /// True when 3+ consecutive poll failures (frontend should show warning toast)
    pub should_warn: bool,
    /// True when 10+ consecutive poll failures (frontend should abort polling)
    pub should_abort: bool,
    /// True when `status` is one of `completed` / `failed` / `cancelled`.
    /// Set in Rust so the frontend doesn't need its own copy of the
    /// terminal status list.
    pub is_terminal: bool,
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
pub async fn start_migration_flow(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<MigrationFlowResult> {
    let pool = state.pool()?;
    let config = crate::sync::config::get_hcfs_config_internal(pool, &account_id).await?;

    if config.has_password {
        Ok(MigrationFlowResult {
            next_step: "progress".to_string(),
        })
    } else {
        Ok(MigrationFlowResult {
            next_step: "setup".to_string(),
        })
    }
}

#[allow(clippy::too_many_lines)]
#[tauri::command]
pub async fn start_server_migration(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    total_size: u64,
    sync_path: Option<String>,
) -> Result<StartServerMigrationResult> {
    let label = derive_migration_label(sync_path.as_deref());
    tracing::info!("[Migration] Starting server migration for account {account_id}, label={label}, total_size={total_size}");
    state.migration.in_progress.store(true, Ordering::SeqCst);
    state.migration.poll_failure_count.store(0, Ordering::SeqCst);

    let folder_hash = hcfs_client::drive::keys::folder_hash(&label);
    let pool = state.pool()?;

    let server_url = get_server_url(pool, &account_id).await.map_err(|e| {
        tracing::error!("[Migration] Failed to get server URL: {e}");
        e
    })?;
    tracing::info!("[Migration] Server URL: {server_url}");

    // The server derives path_prefix from its migration_records table.
    // Previously the desktop extracted this from the file list, but the
    // server no longer returns individual files. Send empty and let the
    // server's worker use the full key path.
    // TODO: have server include path_prefix in the summary response
    let path_prefix = String::new();

    // Check disk space — files will be downloaded locally after server migration
    let sync_path = crate::sync::config::get_sync_path_for_label(pool, &account_id, &label)
        .await
        .unwrap_or_else(|_| dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_default());
    let sync_dir = std::path::Path::new(&sync_path);
    if sync_dir.exists() {
        check_disk_space(sync_dir, total_size)?;
    }

    // Recover the master mnemonic via the unified resolver. It checks the
    // in-memory AuthInfo cache first (populated at login/unlock), then
    // disk, drive, and DB before returning a typed MasterMnemonicUnrecoverable.
    let mnemonic_str = crate::sync::mnemonic::get_mnemonic_for_account(&state, &account_id).await?;

    // Belt-and-suspenders: eagerly persist the master mnemonic to disk if
    // we have a drive password and the file doesn't exist yet. Without
    // this, an OAuth user who crashes after start_server_migration but
    // before complete_migration_transition loses access to migrated files
    // — the master only existed in the AuthInfo cache (in-memory) and is
    // gone after restart. If the drive password isn't set yet (the user
    // is at the migration setup step), this is a no-op and setup_and_init_sync
    // will write the master when the password becomes available.
    if let Ok(drive_password) = crate::sync::config::get_drive_password(pool, &account_id, Some(&mnemonic_str)).await {
        let master_path = crate::sync::mnemonic::master_mnemonic_path(&account_id)?;
        if !master_path.exists() {
            let acct_dir = crate::sync::mnemonic::account_dir(&account_id)?;
            std::fs::create_dir_all(&acct_dir)
                .map_err(|e| crate::error::AppError::Other(format!("Failed to create account directory at {}: {e}", acct_dir.display())))?;
            hcfs_client::auth::save_encrypted_mnemonic(&master_path, &mnemonic_str, &drive_password)
                .map_err(|e| crate::error::AppError::Other(format!("Failed to persist master mnemonic at {}: {e}", master_path.display())))?;
            info!("[Migration] Eagerly persisted master mnemonic for crash recovery");
        }
    }

    let mnemonic = bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &mnemonic_str)
        .map_err(|e| crate::error::AppError::Other(format!("Invalid mnemonic from cache: {e}")))?;

    let seed = mnemonic.to_seed("");

    // Derive the folder-specific encryption key — the Drive decrypts using
    // a key derived from derive_folder_mnemonic(master, label), NOT the
    // raw master seed. The server must encrypt with the same derived key.
    let folder_mnemonic_str = hcfs_client::drive::keys::derive_folder_mnemonic(&mnemonic.to_string(), &label).map_err(|e| {
        tracing::error!("[Migration] Failed to derive folder mnemonic: {e}");
        crate::error::AppError::Other(format!("Failed to derive folder mnemonic: {e}"))
    })?;
    let folder_mnemonic = bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &folder_mnemonic_str)
        .map_err(|e| crate::error::AppError::Other(format!("Invalid folder mnemonic: {e}")))?;
    let folder_seed = folder_mnemonic.to_seed("");
    let encryption_key_hex = hex::encode(&folder_seed[..32]);

    // Derive Ed25519 signing key from the master seed (not the folder key)
    let signing_key = hcfs_client::auth::recover_signing_key(seed).map_err(|e| {
        tracing::error!("[Migration] Failed to derive signing key: {e}");
        crate::error::AppError::Other(format!("Failed to derive signing key: {e}"))
    })?;

    // Sign the migration request
    let signing_text = format!(
        "I hereby declare that I am requesting migration of folder \
         {folder_hash} for account {account_id} on HCFS with the \
         understanding that I have read and agree to the Terms of Service"
    );
    let signature = signing_key.sign(signing_text.as_bytes());

    // Fetch per-user S3 credentials from Hippius API
    let (s3_access_key, s3_secret_key) = fetch_s3_credentials(&state.migration.client, pool, &account_id).await.map_err(|e| {
        tracing::error!("[Migration] Failed to fetch S3 credentials: {e}");
        e
    })?;

    // Retrieve API token for authorization
    let api_token = crate::auth::tokens::get_api_token(pool, &account_id)
        .await
        .map_err(crate::error::AppError::Other)?
        .ok_or_else(|| {
            tracing::error!("[Migration] No API token available");
            crate::error::AppError::Other("No API token available — log in first".into())
        })?;

    // Call server endpoint — use a longer timeout since the server
    // validates credentials and sets up the migration job.
    let url = format!("{}/migration/start", server_url.trim_end_matches('/'));
    tracing::info!("[Migration] Posting to {url}");

    let resp = state
        .migration
        .client
        .post(&url)
        .header("Authorization", format!("Bearer {api_token}"))
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
            "label": label,
        }))
        .send()
        .await
        .map_err(|e| {
            tracing::error!("[Migration] HTTP request failed: {e}");
            e
        })?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();

        // If a previous job is still active, cancel it and retry once.
        if text.contains("job_exists") {
            tracing::warn!("[Migration] Existing job found — cancelling and retrying");
            let cancel_url = format!("{}/migration/cancel", server_url.trim_end_matches('/'));
            let _ = state
                .migration
                .client
                .post(&cancel_url)
                .json(&serde_json::json!({ "ss58_address": account_id }))
                .send()
                .await;

            // Retry the start request
            let retry_resp = state
                .migration
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {api_token}"))
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
                    "label": label,
                }))
                .send()
                .await
                .map_err(|e| {
                    tracing::error!("[Migration] Retry HTTP request failed: {e}");
                    e
                })?;

            if !retry_resp.status().is_success() {
                let retry_text = retry_resp.text().await.unwrap_or_default();
                tracing::error!("[Migration] Retry also failed: {retry_text}");
                return Err(crate::error::AppError::Other(format!("Migration start failed after retry: {retry_text}")));
            }

            let result: StartServerMigrationResult = retry_resp.json().await?;
            let _ = upsert_migration_status(pool, &account_id, "in_progress", 0, 0, "[]", "", &server_url).await;
            tracing::info!("[Migration] Server migration started successfully (after cancel+retry)");
            return Ok(result);
        }

        tracing::error!("[Migration] Server returned error: {text}");
        return Err(crate::error::AppError::Other(format!("Migration start failed: {text}")));
    }

    let result: StartServerMigrationResult = resp.json().await?;

    // Save "in_progress" locally so check_migration can detect a completed
    // server migration that was never transitioned (e.g. app restarted).
    let _ = upsert_migration_status(pool, &account_id, "in_progress", 0, 0, "[]", "", &server_url).await;

    tracing::info!("[Migration] Server migration started successfully");
    Ok(result)
}

/// Internal poll — callable from both the IPC command and the background task.
async fn poll_migration_status_internal(state: &crate::app_state::AppState, account_id: &str) -> Result<ServerMigrationStatus> {
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

    if let Ok(raw) = result {
        state.migration.poll_failure_count.store(0, Ordering::SeqCst);
        let is_terminal = TERMINAL_STATUSES.contains(&raw.status.as_str());
        Ok(ServerMigrationStatus {
            status: raw.status,
            total: raw.total,
            completed: raw.completed,
            failed: raw.failed,
            failed_files: raw.failed_files,
            current_file: raw.current_file,
            logical_file_count: raw.logical_file_count,
            should_warn: false,
            should_abort: false,
            is_terminal,
        })
    } else {
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
            logical_file_count: None,
            should_warn,
            should_abort,
            is_terminal: false,
        })
    }
}

/// Terminal migration statuses — no more polling needed.
const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

/// Start background migration polling. Emits `migration_progress` events every 3s.
///
/// Replaces the `setInterval` polling loop in `useMigration.ts`. The frontend
/// listens for events instead of driving the poll loop.
#[tauri::command]
pub async fn start_migration_polling(app: tauri::AppHandle, account_id: String) -> Result<()> {
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
pub async fn stop_migration_polling(app: tauri::AppHandle) -> Result<()> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();
    let mut guard = state.migration.poll_task.lock().await;
    if let Some(handle) = guard.take() {
        handle.abort();
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

impl Default for MigrationState {
    fn default() -> Self {
        Self::new()
    }
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
            // SAFETY: reqwest::ClientBuilder::build() only fails on native-tls
            // backend initialization, which is configured at compile time. A
            // failure here indicates a broken build artifact, not a runtime
            // condition — panicking at startup is acceptable.
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
    // derive_migration_label
    // -----------------------------------------------------------------------

    #[test]
    fn derive_label_uses_last_path_component() {
        assert_eq!(derive_migration_label(Some("/Users/alice/Documents/Hippius-Migration")), "Hippius-Migration");
    }

    #[test]
    fn derive_label_trailing_slash_is_stripped() {
        assert_eq!(derive_migration_label(Some("/Users/alice/Hippius/")), "Hippius");
    }

    #[test]
    fn derive_label_sanitizes_unsupported_chars() {
        assert_eq!(derive_migration_label(Some("/tmp/weird*folder?name")), "weirdfoldername");
    }

    #[test]
    fn derive_label_none_defaults() {
        assert_eq!(derive_migration_label(None), "default");
    }

    #[test]
    fn derive_label_empty_string_defaults() {
        assert_eq!(derive_migration_label(Some("")), "default");
    }

    #[test]
    fn derive_label_only_slashes_defaults() {
        assert_eq!(derive_migration_label(Some("///")), "default");
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
            sync_path: Some("/tmp/sync".into()),
            is_resuming: false,
            needs_completion: false,
            completion_status: None,
            is_in_progress: false,
            progress_completed: 0,
            progress_total: 0,
            progress_failed: 0,
        };

        let json = serde_json::to_string(&result).expect("serialization failed");
        assert!(json.contains("\"needs_migration\":true"));
        assert!(json.contains("\"file_count\":3"));
        assert!(json.contains("\"needs_completion\":false"));
        assert!(json.contains("\"is_in_progress\":false"));
        assert!(json.contains("\"progress_completed\":0"));
    }

    #[test]
    fn server_migration_response_deserializes() {
        let json = r#"{
            "needs_migration": true,
            "file_count": 2,
            "total_size": 3072,
            "pending_count": 1
        }"#;

        let resp: ServerMigrationResponse = serde_json::from_str(json).expect("deserialization failed");
        assert!(resp.needs_migration);
        assert_eq!(resp.pending_count, 1);
        assert_eq!(resp.total_size, 3072);
        assert_eq!(resp.logical_file_count, None);
    }

    #[test]
    fn server_migration_response_with_logical_count() {
        let json = r#"{
            "needs_migration": true,
            "file_count": 66,
            "total_size": 3072,
            "pending_count": 66,
            "logical_file_count": 15
        }"#;

        let resp: ServerMigrationResponse = serde_json::from_str(json).expect("deserialization failed");
        assert!(resp.needs_migration);
        assert_eq!(resp.pending_count, 66);
        assert_eq!(resp.logical_file_count, Some(15));
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
    fn default_sync_path_ends_with_hippius_migration_date() {
        let path = compute_default_sync_path().expect("should resolve a default path");
        let name = path.file_name().and_then(|n| n.to_str()).expect("should have a folder name");
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(name, format!("Hippius-Migration-{today}"));
    }

    #[test]
    fn default_sync_path_under_documents_or_home() {
        let path = compute_default_sync_path().expect("should resolve a default path");
        let parent = path.parent().expect("path should have a parent");
        let doc_dir = dirs::document_dir();
        let home_dir = dirs::home_dir();
        assert!(
            doc_dir.as_ref() == Some(&parent.to_path_buf()) || home_dir.as_ref() == Some(&parent.to_path_buf()),
            "Expected parent to be Documents or Home, got {parent:?}",
        );
    }

    #[test]
    fn get_default_migration_path_returns_non_empty_string() {
        let path_str = get_default_migration_path().expect("should return a path string");
        assert!(!path_str.is_empty());
        assert!(path_str.contains("Hippius-Migration-"));
    }
}
