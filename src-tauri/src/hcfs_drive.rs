//! HCFS Drive wrapper and background sync loop.
//!
//! This module wraps `hcfs_client::Drive` in `HcfsDriveManager` and runs a
//! background sync loop with file watching and heartbeat timing in a sequential
//! round-robin fashion. All mutable state (drive registry, loop handle, atomic
//! flags) lives on `crate::sync_engine::SyncEngine` and is accessed via
//! `AppState.sync` (an `Arc<SyncEngine>` stored in Tauri managed state).
//!
//! ## Lifecycle
//! 1. `initialize_sync` (in syncing.rs) creates a `HcfsDriveManager` and stores it in `sync.drives`
//! 2. `start_sync_loop` spawns a tokio task that watches for file changes and syncs periodically
//! 3. `stop_sync` cancels the loop, aborts the task, and drops all drives

use crate::sync_shared::{ConnectivityStatus, SyncActivityItem, SyncEngineHealth};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::drive::Drive;
use hcfs_client::sync::{
    SyncConflict, SyncConflictResolution, SyncConflictType, SyncMode, SyncOutcome, SyncProgress,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info, warn};


// --- Serializable types for staged changes ---

#[derive(Debug, Serialize, Clone)]
pub struct StagedFile {
    pub file_id: String,
    pub path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct StagedConflict {
    pub file_id: String,
    pub path: String,
    pub conflict_type: String,
    pub has_local: bool,
    pub has_remote: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct StagedChanges {
    pub uploads: Vec<StagedFile>,
    pub downloads: Vec<StagedFile>,
    pub local_deletes: Vec<StagedFile>,
    pub remote_deletes: Vec<StagedFile>,
    pub conflicts: Vec<StagedConflict>,
    pub unchanged_count: usize,
}

/// Thin wrapper around `hcfs_client::Drive` that adds error mapping to `String`
/// (required for Tauri IPC) and tracks the sync folder path and config directory.
pub struct HcfsDriveManager {
    drive: Drive,
    sync_path: PathBuf,
    config_dir: PathBuf,
    client_config: Option<HcfsClientConfig>,
}

impl HcfsDriveManager {
    pub fn new(sync_path: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            drive: Drive::with_config_dir(&sync_path, &config_dir),
            sync_path,
            config_dir,
            client_config: None,
        }
    }

    pub fn init(&mut self, password: &str, mnemonic: Option<&str>) -> Result<String, String> {
        self.drive
            .init(password, mnemonic)
            .map_err(|e| e.to_string())
    }

    pub fn unlock(&mut self, password: &str) -> Result<String, String> {
        self.drive.unlock(password).map_err(|e| e.to_string())?;
        self.drive
            .user_id()
            .map(|s| s.to_string())
            .ok_or_else(|| "Failed to get user_id after unlock".to_string())
    }

    pub fn is_unlocked(&self) -> bool {
        self.drive.is_unlocked()
    }
    pub fn is_initialized(&self) -> bool {
        self.drive.is_initialized()
    }
    #[allow(dead_code)]
    pub fn user_id(&self) -> Option<String> {
        self.drive.user_id()
    }
    pub fn sync_path(&self) -> &Path {
        &self.sync_path
    }

    /// Load the persisted sync state from disk.
    ///
    /// Returns the three-tree sync state (`local`, `remote`, `synced`) plus
    /// the `path_index` mapping path hashes to relative file paths.
    pub fn load_sync_state(&self) -> Result<hcfs_client::sync::SyncState, String> {
        self.drive.load_sync_state().map_err(|e| e.to_string())
    }

    pub fn set_config(&mut self, config: HcfsClientConfig) -> Result<(), String> {
        self.client_config = Some(config.clone());
        self.drive.set_config(config).map_err(|e| e.to_string())
    }

    /// Update only the bearer token on a live drive, preserving all other config.
    pub fn update_bearer_token(&mut self, token: String) -> Result<(), String> {
        let mut config = self
            .client_config
            .clone()
            .ok_or("Drive has no config set")?;
        config.bearer_token = token;
        self.set_config(config)
    }

    pub fn set_progress(&mut self, progress: SyncProgress) {
        self.drive.set_progress_handlers(progress);
    }

    /// Stage changes and resolve FileIds to human-readable paths using the path_index.
    ///
    /// **Important:** `drive.stage()` does NOT fetch remote state — it uses the cached
    /// remote tree saved to disk by the last `sync_with_resolver()` call. This means the
    /// plan may miss conflicts that only become visible with fresh remote data (TOCTOU gap).
    /// The caller must handle this; see `trigger_sync()` for the re-staging fallback.
    ///
    /// `stage()` does not expose the resulting `SyncState`, so we call `load_sync_state()`
    /// + `scan_local_files()` again to access `path_index` for FileId → path resolution.
    ///
    /// This method is `async` for API consistency with the rest of `HcfsDriveManager`,
    /// though the underlying `drive.stage()` is synchronous.
    pub async fn stage_with_paths(&self) -> Result<StagedChanges, String> {
        let plan = self.drive.stage().map_err(|e| e.to_string())?;

        // Load state separately for path_index (see doc comment above)
        let mut state = self.drive.load_sync_state().map_err(|e| e.to_string())?;
        self.drive
            .scan_local_files(&mut state)
            .map_err(|e| e.to_string())?;

        // Diagnostic: log the staging plan summary and any conflicts
        debug!(
            uploads = plan.uploads.len(),
            downloads = plan.downloads.len(),
            local_deletes = plan.local_deletes.len(),
            remote_deletes = plan.remote_deletes.len(),
            conflicts = plan.conflicts.len(),
            unchanged = plan.unchanged.len(),
            "Stage plan summary",
        );
        debug!(
            local = state.local.files.len(),
            remote = state.remote.files.len(),
            synced = state.synced.files.len(),
            ss58 = %state.ss58_address,
            "Stage trees",
        );
        for c in &plan.conflicts {
            let conflict_type = match c.conflict_type {
                SyncConflictType::ModifyModify => "ModifyModify",
                SyncConflictType::ModifyDelete => "ModifyDelete",
                SyncConflictType::DeleteModify => "DeleteModify",
                SyncConflictType::CreateCreate => "CreateCreate",
            };
            let path = state
                .path_index
                .get(&c.path_hash)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| hex::encode(c.path_hash));
            debug!(
                conflict_type = conflict_type,
                path = %path,
                has_local = c.local_hash.is_some(),
                has_remote = c.remote_hash.is_some(),
                "Stage conflict",
            );
        }

        let resolve_path = |file_id: &[u8; 32]| -> String {
            state
                .path_index
                .get(file_id)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| hex::encode(file_id))
        };

        let resolve_file = |file_id: &[u8; 32]| -> StagedFile {
            StagedFile {
                file_id: hex::encode(file_id),
                path: resolve_path(file_id),
            }
        };

        let uploads = plan.uploads.iter().map(resolve_file).collect();
        let downloads = plan.downloads.iter().map(resolve_file).collect();
        let local_deletes = plan.local_deletes.iter().map(resolve_file).collect();
        let remote_deletes = plan.remote_deletes.iter().map(resolve_file).collect();

        let conflicts = plan
            .conflicts
            .iter()
            .map(|c| {
                let conflict_type_str = match c.conflict_type {
                    SyncConflictType::ModifyModify => "modify_modify",
                    SyncConflictType::ModifyDelete => "modify_delete",
                    SyncConflictType::DeleteModify => "delete_modify",
                    SyncConflictType::CreateCreate => "create_create",
                };
                StagedConflict {
                    // path_hash (from staging) == file_id (from sync resolver) — both are [u8; 32]
                    file_id: hex::encode(c.path_hash),
                    path: resolve_path(&c.path_hash),
                    conflict_type: conflict_type_str.to_string(),
                    has_local: c.local_hash.is_some(),
                    has_remote: c.remote_hash.is_some(),
                }
            })
            .collect();

        Ok(StagedChanges {
            uploads,
            downloads,
            local_deletes,
            remote_deletes,
            conflicts,
            unchanged_count: plan.unchanged.len(),
        })
    }

    /// Sync with pre-collected conflict resolutions.
    /// The `resolutions` map keys are hex-encoded FileIds, values are resolution strings.
    pub async fn sync_with_resolutions(
        &mut self,
        resolutions: HashMap<String, String>,
    ) -> Result<SyncOutcome, String> {
        self.drive
            .sync_with_resolver(SyncMode::NonInteractive, |conflict| {
                let file_id_hex = match conflict {
                    SyncConflict::Plan(c) => hex::encode(c.file_id),
                    SyncConflict::Upload(c) => hex::encode(c.file_id),
                };

                resolutions
                    .get(&file_id_hex)
                    .map(|r| match r.as_str() {
                        "keep_local" => SyncConflictResolution::KeepLocal,
                        "accept_remote" => SyncConflictResolution::AcceptRemote,
                        "keep_both" => SyncConflictResolution::KeepBoth,
                        _ => SyncConflictResolution::Skip,
                    })
                    .unwrap_or(SyncConflictResolution::Skip)
            })
            .await
            .map_err(|e| e.to_string())
    }

    /// Decrypt and return the Drive's actual BIP-39 mnemonic.
    pub fn export_mnemonic(&self, password: &str) -> Result<String, String> {
        let enc_path = self.config_dir.join("enc_mnemonic.json");
        let mnemonic =
            hcfs_client::auth::recover_mnemonic(&enc_path, password).map_err(|e| e.to_string())?;
        Ok(mnemonic.to_string())
    }

    pub fn cleanup_temp(&self) {
        self.drive.cleanup_stale_temp_files();
    }

    /// Log sync state diagnostics — user_id, local/remote/synced file counts.
    pub fn log_sync_diagnostics(&self, label: &str) {
        let state = match self.drive.load_sync_state() {
            Ok(s) => s,
            Err(e) => {
                warn!(label = label, error = %e, "Failed to load sync state");
                return;
            }
        };
        info!(
            label = label,
            ss58 = %state.ss58_address,
            folder_hash = %state.folder_hash,
            local = state.local.files.len(),
            remote = state.remote.files.len(),
            synced = state.synced.files.len(),
            path_index = state.path_index.len(),
            "Drive diagnostics",
        );
        // Log each remote file's path_hash prefix for cross-referencing
        for file_id in state.remote.files.keys() {
            let known_path = state
                .path_index
                .get(file_id)
                .map(|p| p.display().to_string());
            let enc_path = state.remote_encrypted_paths.contains_key(file_id);
            debug!(
                file_id = %hex::encode(&file_id[..8]),
                known_path = ?known_path,
                has_encrypted_path = enc_path,
                "Remote file",
            );
        }
    }

    /// Remove files left behind by failed downloads and return their
    /// hex-encoded file IDs (the full `path_hash`).
    ///
    /// When hcfs-client cannot decrypt a downloaded file it leaves a
    /// partial or empty file on disk named `downloaded_<hex>`. It may
    /// also leave a 0-byte stub with the encrypted name (`file_<hex>`)
    /// when decryption fails. These are not real user files — they are
    /// artifacts of the fallback naming in `resolve_download_path`.
    /// Scan the sync folder (recursively), delete any that match, and
    /// return the file IDs so the caller can also purge them from the
    /// server.
    pub fn cleanup_failed_downloads(&self) -> Vec<String> {
        let mut failed_ids = Vec::new();
        self.cleanup_failed_downloads_recursive(&self.sync_path, &mut failed_ids);
        failed_ids
    }

    fn cleanup_failed_downloads_recursive(
        &self,
        dir: &std::path::Path,
        failed_ids: &mut Vec<String>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();

            // Use file_type() (not is_dir()) to avoid following symlinks,
            // which could escape the sync folder or cause infinite loops.
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                self.cleanup_failed_downloads_recursive(&path, failed_ids);
                continue;
            }

            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            // Pattern 1: `downloaded_<hex>` — raw encrypted content artifact
            if let Some(hex_part) =
                crate::sync_logic::is_failed_download_artifact(&name_str)
            {
                info!(artifact = %name_str, "Removing failed download artifact");
                if let Err(e) = std::fs::remove_file(&path) {
                    warn!(artifact = %name_str, error = %e, "Failed to remove download artifact");
                }
                failed_ids.push(hex_part.to_string());
                continue;
            }

            // Pattern 2: `file_<hex>` with 0 bytes — encrypted-name stub
            // from a decryption failure. The full name (including `file_`
            // prefix) is pushed to `failed_ids` to match how pending
            // activity entries store encrypted filenames.
            if crate::sync_logic::is_encrypted_name_stub(&name_str).is_some() {
                let is_empty = entry.metadata().map(|m| m.len() == 0).unwrap_or(false);
                if is_empty {
                    info!(stub = %name_str, "Removing 0-byte encrypted-name stub");
                    if let Err(e) = std::fs::remove_file(&path) {
                        warn!(stub = %name_str, error = %e, "Failed to remove encrypted-name stub");
                    }
                    failed_ids.push(name_str.to_string());
                }
            }
        }
    }

    /// Build a path_index from the current sync state + local scan,
    /// mapping encrypted on-disk name prefixes to real file names.
    ///
    /// Stores both the truncated prefix (first 8 bytes hex = 16 chars,
    /// matching `file_<16hex>`) and the full file_id hex. This way
    /// lookups succeed regardless of how much of the ID is available,
    /// and full-ID entries prevent collisions when two files share the
    /// same 8-byte prefix.
    pub fn build_path_index(&self) -> Result<HashMap<String, String>, String> {
        let mut state = self.drive.load_sync_state().map_err(|e| e.to_string())?;
        self.drive
            .scan_local_files(&mut state)
            .map_err(|e| e.to_string())?;

        let mut index = HashMap::new();
        for (file_id, path) in &state.path_index {
            let real_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string());
            // Insert full hex for collision-free lookup
            let full_hex = hex::encode(file_id);
            index.insert(full_hex, real_name.clone());
            // Also insert truncated prefix for encrypted name matching
            if file_id.len() >= 8 {
                let prefix = hex::encode(&file_id[..8]);
                index.insert(prefix, real_name);
            }
        }
        Ok(index)
    }
}

/// Number of consecutive health check failures before alerting the user.
/// Auth expired (401/403) bypasses this and alerts immediately.
const HEALTH_FAILURE_THRESHOLD: u32 = 2;

/// Run a health check against the HCFS server's `/health` endpoint.
///
/// Classifies the result into a `ConnectivityStatus`, updates
/// `sync.health`, and emits `hcfs_connectivity_changed` when the
/// status transitions. Returns the new status.
async fn check_server_health(app: &AppHandle) -> ConnectivityStatus {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;
    let health_client = &app_state.health_client;

    let server_url: Option<String> = {
        let guard = sync.drives.lock().await;
        guard
            .values()
            .find_map(|m| m.client_config.as_ref().map(|c| c.base_url.clone()))
    };

    let Some(server_url) = server_url else {
        return ConnectivityStatus::Connected;
    };

    let health_url = format!("{}/health", server_url);
    let now = chrono::Utc::now().timestamp();

    let result = health_client
        .get(&health_url)
        .header("X-API-Key", "Arion")
        .send()
        .await;

    match result {
        Ok(resp) => {
            let status_code = resp.status().as_u16();
            match status_code {
                200 => {
                    let version =
                        resp.json::<serde_json::Value>().await.ok().and_then(|v| {
                            v.get("version").and_then(|s| s.as_str()).map(String::from)
                        });
                    record_health_success(sync, app, version, now)
                }
                401 | 403 => {
                    let msg = format!("Auth failed (HTTP {})", status_code);
                    warn!("{}", msg);
                    record_health_failure(sync, app, ConnectivityStatus::AuthExpired, msg, now)
                }
                _ => {
                    let msg = format!("Server returned HTTP {}", status_code);
                    warn!("{}", msg);
                    record_health_failure(sync, app, ConnectivityStatus::Degraded, msg, now)
                }
            }
        }
        Err(e) => {
            let (status, msg) = classify_request_error(&e);
            warn!("{}", msg);
            record_health_failure(sync, app, status, msg, now)
        }
    }
}

/// Classify a reqwest error into a connectivity status.
fn classify_request_error(e: &reqwest::Error) -> (ConnectivityStatus, String) {
    let msg = format!("{e}");
    if e.is_timeout() {
        (
            ConnectivityStatus::Degraded,
            format!("Request timed out: {msg}"),
        )
    } else if e.is_connect() {
        if msg.contains("dns") || msg.contains("resolve") || msg.contains("lookup") {
            (
                ConnectivityStatus::NetworkOffline,
                format!("DNS resolution failed: {msg}"),
            )
        } else {
            (
                ConnectivityStatus::ServerUnreachable,
                format!("Connection failed: {msg}"),
            )
        }
    } else if e.is_request() {
        (
            ConnectivityStatus::NetworkOffline,
            format!("Request failed: {msg}"),
        )
    } else {
        (
            ConnectivityStatus::ServerUnreachable,
            format!("Unknown error: {msg}"),
        )
    }
}

/// Record a successful health check. Emits event if status was previously unhealthy.
fn record_health_success(
    sync: &crate::sync_engine::SyncEngine,
    app: &AppHandle,
    version: Option<String>,
    now: i64,
) -> ConnectivityStatus {
    let should_emit = update_health_atomic(sync, |h| {
        let was_unhealthy = h.status != ConnectivityStatus::Connected;
        if was_unhealthy {
            info!(previous_status = ?h.status, "Connection restored");
        }
        h.status = ConnectivityStatus::Connected;
        h.last_check_time = Some(now);
        h.last_successful_check = Some(now);
        h.consecutive_failures = 0;
        h.server_version = version;
        h.error_message = None;
        was_unhealthy
    });
    if should_emit {
        emit_health_event(sync, app);
    }
    ConnectivityStatus::Connected
}

/// Record a failed health check. Emits event based on threshold rules.
fn record_health_failure(
    sync: &crate::sync_engine::SyncEngine,
    app: &AppHandle,
    new_status: ConnectivityStatus,
    error_msg: String,
    now: i64,
) -> ConnectivityStatus {
    let should_emit = update_health_atomic(sync, |h| {
        let previous_status = h.status.clone();
        let new_failures = h.consecutive_failures + 1;
        h.status = new_status.clone();
        h.last_check_time = Some(now);
        h.consecutive_failures = new_failures;
        h.error_message = Some(error_msg);

        crate::sync_logic::should_emit_health_change(
            &previous_status,
            &new_status,
            new_failures,
            HEALTH_FAILURE_THRESHOLD,
        )
    });

    if should_emit {
        emit_health_event(sync, app);
    }

    new_status
}

/// Atomically update health state and return a computed value under the lock.
fn update_health_atomic<F, R>(sync: &crate::sync_engine::SyncEngine, f: F) -> R
where
    F: FnOnce(&mut SyncEngineHealth) -> R,
{
    let mut health = sync
        .health
        .lock()
        .unwrap_or_else(|poisoned| {
            warn!("Poisoned mutex recovered in update_health_atomic");
            poisoned.into_inner()
        });
    f(&mut health)
}

/// Emit the current health state to the frontend.
fn emit_health_event(sync: &crate::sync_engine::SyncEngine, app: &AppHandle) {
    let health = sync.get_health();
    info!(
        status = ?health.status,
        failures = health.consecutive_failures,
        "Emitting connectivity change",
    );
    if let Err(e) = app.emit("hcfs_connectivity_changed", &health) {
        warn!(error = %e, "Failed to emit hcfs_connectivity_changed");
    }
}

/// Check if sync should be skipped based on health status.
fn should_skip_sync(sync: &crate::sync_engine::SyncEngine, status: &ConnectivityStatus) -> bool {
    crate::sync_logic::should_skip_sync_check(
        status,
        sync.get_health().consecutive_failures,
        HEALTH_FAILURE_THRESHOLD,
    )
}

/// Heartbeat interval: sync every 30 seconds regardless of local changes
const HEARTBEAT_SECS: u64 = 30;

/// Debounce interval: wait 5 seconds after local changes before syncing
const DEBOUNCE_SECS: u64 = 5;

/// Start background sync loop that iterates through all registered drives.
pub async fn start_sync_loop(app: AppHandle) {
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();

    info!("Starting sync loop");

    // Abort the previous sync loop if one is still running
    {
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            info!("Aborting previous sync loop task");
            prev.abort();
        }
    }

    // Collect all sync paths from registered drives
    let drive_paths: Vec<(String, PathBuf)> = {
        let guard = sync.drives.lock().await;
        guard
            .iter()
            .map(|(label, m)| (label.clone(), m.sync_path().to_path_buf()))
            .collect()
    };

    if drive_paths.is_empty() {
        info!("No drives registered, sync loop not started");
        return;
    }

    for (label, path) in &drive_paths {
        info!(label = %label, path = ?path, "Watching drive");
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(256);

    // File watcher — forwards events to channel, filtering out internal
    // metadata paths (.hcfs/, sync_progress/) that the sync engine writes.
    // If sync is active, sets changes_pending for real user changes only.
    let tx_clone = tx.clone();
    let sync_for_watcher = sync.clone();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Filter out internal metadata files that the sync engine writes.
                // These would otherwise create a feedback loop: sync writes state →
                // watcher fires → triggers another sync → writes state → ...
                let dominated_by_internal = event.paths.iter().all(|p| {
                    let path_str = p.to_string_lossy();
                    path_str.contains("/.hcfs/")
                        || path_str.contains("\\.hcfs\\")
                        || path_str.contains("/sync_progress/")
                        || path_str.contains("\\sync_progress\\")
                });
                if dominated_by_internal {
                    return;
                }

                if sync_for_watcher.sync_in_progress.load(Ordering::Acquire) {
                    sync_for_watcher.changes_pending.store(true, Ordering::Release);
                }
                let _ = tx_clone.try_send(());
            }
        },
    ) {
        Ok(w) => w,
        Err(e) => {
            error!(error = %e, "Failed to create file watcher, sync loop will run without file watching");
            // Fall back to heartbeat-only sync loop without a watcher
            let sync_fallback = sync.clone();
            let handle = tokio::spawn(async move {
                // Initial sync on startup
                info!("Running initial sync (no file watcher)");
                check_server_health(&app).await;
                trigger_sync(&app).await;

                let mut interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
                loop {
                    // Apply exponential backoff on consecutive failures
                    let failures = sync_fallback.get_sync_failures();
                    let backoff_secs =
                        crate::sync_logic::compute_backoff(failures, HEARTBEAT_SECS);
                    if failures > 0 {
                        // Override interval for backoff
                        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                    } else {
                        interval.tick().await;
                    }
                    if sync_fallback.is_cancelled() {
                        break;
                    }
                    let health_status = check_server_health(&app).await;
                    if should_skip_sync(&sync_fallback, &health_status) {
                        warn!(status = ?health_status, "Skipping sync due to connectivity");
                    } else {
                        // Proactive token refresh
                        {
                            let app_state = app.state::<crate::app_state::AppState>();
                            if let (Ok(pool), Ok(acct)) = (
                                app_state.pool(),
                                crate::utils::sync::current_account_id(&app_state),
                            ) {
                                if crate::utils::auth_tokens::is_token_expiring(
                                    pool,
                                    &acct,
                                    crate::utils::auth_tokens::TOKEN_REFRESH_MARGIN_SECS,
                                )
                                .await
                                {
                                    info!("Token expiring soon, proactively refreshing");
                                    if let Err(e) =
                                        crate::commands::auth::refresh_auth_token_internal(
                                            pool, &app, &acct,
                                        )
                                        .await
                                    {
                                        warn!(error = %e, "Proactive token refresh failed");
                                    }
                                }
                            }
                        }
                        trigger_sync(&app).await;
                    }
                }
                info!("Sync loop exited (no file watcher)");
            });
            let mut handle_guard = sync.loop_handle.lock().await;
            *handle_guard = Some(handle);
            return;
        }
    };

    // Watch all drive paths
    for (label, path) in &drive_paths {
        if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
            error!(path = ?path, label = %label, error = %e, "Failed to watch path, continuing with heartbeat-only sync");
        }
    }

    let sync_task = sync.clone();
    let handle = tokio::spawn(async move {
        let _watcher = watcher; // keep alive

        // Clean up any stale temp files from previous runs
        {
            let guard = sync_task.drives.lock().await;
            for manager in guard.values() {
                manager.cleanup_temp();
            }
        }

        // Initial sync on startup — sync all drives
        info!("Running initial sync");
        check_server_health(&app).await;
        trigger_sync(&app).await;

        let mut debounce = tokio::time::interval(Duration::from_secs(DEBOUNCE_SECS));
        let mut has_changes = false;
        let mut last_sync = Instant::now();

        loop {
            if sync_task.is_cancelled() {
                break;
            }

            tokio::select! {
                msg = rx.recv() => {
                    if msg.is_none() { break; }
                    has_changes = true;
                }
                _ = debounce.tick() => {
                    // Exponential backoff: after consecutive failures, extend the
                    // heartbeat interval to avoid hammering the server.
                    // 0 failures -> 30s, 1 -> 60s, 2 -> 120s, capped at 5 min.
                    let failures = sync_task.get_sync_failures();
                    let backoff_secs =
                        crate::sync_logic::compute_backoff(failures, HEARTBEAT_SECS);
                    let heartbeat_due = last_sync.elapsed() >= Duration::from_secs(backoff_secs);
                    if has_changes || heartbeat_due {
                        // Run health check on heartbeat ticks
                        if heartbeat_due {
                            let health_status = check_server_health(&app).await;
                            if should_skip_sync(&sync_task, &health_status) {
                                warn!(status = ?health_status, "Skipping sync due to connectivity");
                                last_sync = Instant::now();
                                continue;
                            }
                        }

                        // Proactively refresh the auth token if it's expiring
                        // within the next hour, so the sync doesn't hit a 401.
                        if heartbeat_due {
                            let app_state = app.state::<crate::app_state::AppState>();
                            if let (Ok(pool), Ok(acct)) = (app_state.pool(), crate::utils::sync::current_account_id(&app_state)) {
                                if crate::utils::auth_tokens::is_token_expiring(
                                    pool,
                                    &acct,
                                    crate::utils::auth_tokens::TOKEN_REFRESH_MARGIN_SECS,
                                ).await {
                                    info!("Token expiring soon, proactively refreshing");
                                    if let Err(e) = crate::commands::auth::refresh_auth_token_internal(
                                        pool, &app, &acct,
                                    ).await {
                                        warn!(error = %e, "Proactive token refresh failed");
                                    }
                                }
                            }
                        }

                        // Only clear has_changes if sync actually ran (not skipped)
                        let sync_ran = trigger_sync(&app).await;
                        if sync_ran {
                            has_changes = false;
                            last_sync = Instant::now();

                            // Drain any watcher events that arrived during sync.
                            // Sync writes internal files (sync_state.json, etc.)
                            // which trigger the watcher after sync_in_progress
                            // is cleared. Without this drain, the next debounce
                            // tick would run a pointless "No changes" cycle.
                            while rx.try_recv().is_ok() {}

                            // If real user changes arrived during sync, schedule
                            // an immediate re-sync on the next loop iteration.
                            if sync_task.changes_pending.swap(false, Ordering::AcqRel) {
                                has_changes = true;
                            }
                        }
                        // If sync was skipped (already in progress), keep has_changes = true
                        // so we retry on next debounce tick
                    }
                }
            }
        }
        info!("Sync loop exited");
    });

    // Store the handle so we can abort it later
    {
        let mut handle_guard = sync.loop_handle.lock().await;
        *handle_guard = Some(handle);
    }
}

/// Execute one sync cycle for ALL registered drives in round-robin.
/// Returns true if sync was executed, false if skipped.
pub async fn trigger_sync(app: &AppHandle) -> bool {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let labels: Vec<String> = {
        let guard = sync.drives.lock().await;
        guard.keys().cloned().collect()
    };
    let mut any_ran = false;
    for label in labels {
        any_ran |= trigger_sync_for_drive(app, &label).await;
    }
    any_ran
}

/// Execute one sync cycle for a specific drive by label.
/// Returns true if sync was executed, false if skipped (e.g., already in progress).
pub async fn trigger_sync_for_drive(app: &AppHandle, label: &str) -> bool {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Atomically check review mode, is_syncing, and token refresh under a single lock scope
    {
        let mut states = sync
            .states
            .lock()
            .unwrap_or_else(|poisoned| {
                warn!("Poisoned mutex recovered in trigger_sync_for_drive");
                poisoned.into_inner()
            });

        // Block sync during token refresh to avoid 401 races
        if sync.is_token_refreshing() {
            debug!(label = label, "Token refresh in progress, skipping sync");
            return false;
        }

        if sync.review_mode.load(Ordering::Acquire) {
            // Auto-exit review mode after 5 minutes to prevent indefinite stall
            const REVIEW_TIMEOUT_SECS: i64 = 300;
            if sync.is_review_timed_out(REVIEW_TIMEOUT_SECS) {
                warn!(
                    timeout_secs = REVIEW_TIMEOUT_SECS,
                    label = label,
                    "Review mode timed out, auto-skipping conflicts and resuming sync"
                );
                sync.review_mode.store(false, Ordering::Release);
                sync.clear_review_entered();
                // Notify frontend that review mode was auto-cleared
                if let Err(e) = app.emit(
                    "hcfs_review_mode_timeout",
                    serde_json::json!({ "label": label }),
                ) {
                    warn!(error = %e, "Failed to emit hcfs_review_mode_timeout");
                }
            } else {
                debug!(label = label, "Review mode active, skipping auto-sync");
                return false;
            }
        }

        // Atomic check-and-set: check is_syncing and set it true in a single lock scope
        match states.get_mut(label) {
            Some(s) if s.is_syncing => {
                debug!(
                    label = label,
                    "Sync already in progress, will retry on next cycle"
                );
                return false;
            }
            Some(s) => {
                s.is_syncing = true;
            }
            None => {
                states.insert(
                    label.to_string(),
                    crate::sync_shared::HcfsSyncState {
                        is_syncing: true,
                        ..Default::default()
                    },
                );
            }
        }
    }

    // Suppress file watcher events during sync to prevent feedback loops
    sync.sync_in_progress.store(true, Ordering::Release);

    info!(label = label, "Starting sync cycle");

    // Track whether we emitted sync_started - only emit sync_completed if we did
    let mut emitted_sync_started = false;

    // Tri-state result: synced, conflicts pending (user must resolve), or not available.
    // Carries staged file lists so we can record activity with real file names
    // (the download progress callback only sees encrypted names).
    enum SyncResult {
        Synced {
            outcome: Result<SyncOutcome, String>,
            staged_downloads: Vec<StagedFile>,
        },
        ConflictsPending,
        #[allow(dead_code)]
        NoChanges,
        NotAvailable,
    }

    let result = {
        let mut guard = sync.drives.lock().await;
        match guard.get_mut(label) {
            Some(m) if m.is_unlocked() => {
                debug!(label = label, "Drive is unlocked, syncing directly");
                m.log_sync_diagnostics(label);

                // Emit sync_started with zero counts — real counts arrive
                // via the on_sync_plan_ready callback once the live sync
                // fetches fresh remote state.
                let empty: Vec<String> = Vec::new();
                if let Err(e) = app.emit(
                    "hcfs_sync_started",
                    serde_json::json!({
                        "label": label,
                        "uploads": 0, "downloads": 0,
                        "local_deletes": 0, "remote_deletes": 0,
                        "upload_files": empty,
                        "download_files": empty,
                        "local_delete_files": empty,
                        "remote_delete_files": empty,
                    }),
                ) {
                    warn!(error = %e, "Failed to emit hcfs_sync_started");
                }
                emitted_sync_started = true;

                // Create empty session — the plan_ready callback will
                // merge real counts once the sync engine has a plan.
                let _ = crate::sync_progress::merge_into_session(
                    sync, 0, 0, 0, 0, None, Some(label.to_string()),
                );

                // Run sync with stall detection.  Every 10 s we check
                // whether any progress callback has fired in the last
                // 3 minutes (and whether cancellation was requested).
                info!(label = label, "sync_with_resolutions starting");
                sync.reset_progress_time();
                let outcome = {
                    let sync_future = m.sync_with_resolutions(HashMap::new());
                    tokio::pin!(sync_future);
                    loop {
                        tokio::select! {
                            result = &mut sync_future => break result,
                            _ = tokio::time::sleep(Duration::from_secs(10)) => {
                                if sync.is_progress_stalled() {
                                    error!(label = label, "Sync stalled — no progress for 3 minutes");
                                    break Err("Sync stalled — no progress for 3 minutes".to_string());
                                }
                                if sync.is_cancelled() {
                                    break Err("Sync cancelled".to_string());
                                }
                            }
                        }
                    }
                };
                info!(
                    label = label,
                    success = outcome.is_ok(),
                    "sync_with_resolutions returned",
                );

                match &outcome {
                    Ok(o) if o.conflicts_skipped > 0 => {
                        info!(
                            conflicts_skipped = o.conflicts_skipped,
                            label = label,
                            "Conflicts skipped during auto-sync, re-staging for review",
                        );

                        if let Err(e) = app.emit(
                            "hcfs_sync_completed",
                            serde_json::json!({
                                "label": label,
                                "files_uploaded": o.files_uploaded,
                                "files_downloaded": o.files_downloaded,
                                "files_deleted_locally": o.files_deleted_locally,
                                "files_deleted_remotely": o.files_deleted_remotely,
                                "conflicts_resolved": o.conflicts_resolved,
                                "conflicts_skipped": o.conflicts_skipped,
                            }),
                        ) {
                            warn!(error = %e, "Failed to emit hcfs_sync_completed");
                        }

                        // Re-stage AFTER sync to present real conflicts
                        // for user review (the pre-sync stage is skipped).
                        match m.stage_with_paths().await {
                            Ok(restaged) if !restaged.conflicts.is_empty() => {
                                sync.review_mode.store(true, Ordering::Release);
                                sync.set_review_entered();
                                if let Err(e) = app.emit(
                                    "hcfs_conflicts_pending",
                                    serde_json::json!({
                                        "label": label,
                                        "staged": restaged,
                                    }),
                                ) {
                                    warn!(error = %e, "Failed to emit hcfs_conflicts_pending");
                                }
                            }
                            _ => {
                                info!(
                                    label = label,
                                    "Re-stage after sync found no conflicts",
                                );
                            }
                        }
                        SyncResult::ConflictsPending
                    }
                    _ => SyncResult::Synced {
                        outcome,
                        staged_downloads: Vec::new(),
                    },
                }
            }
            Some(_) => {
                warn!(label = label, "Drive exists but is not unlocked");
                SyncResult::NotAvailable
            }
            None => {
                warn!(label = label, "Drive not found in registry");
                SyncResult::NotAvailable
            }
        }
    };

    // Wait for the OS to flush trailing filesystem events generated by sync
    // (e.g. sync_state.json writes, downloaded files). The drain in
    // start_sync_loop happens AFTER this returns, so awaiting inline ensures
    // the drain captures all trailing events instead of racing with them.
    tokio::time::sleep(Duration::from_millis(200)).await;
    sync.sync_in_progress.store(false, Ordering::Release);

    sync.update_state(label, |s| {
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    });

    // Log post-sync diagnostics and clean up local artifacts from
    // failed downloads (e.g. files named `downloaded_<hex>` or 0-byte
    // `file_<hex>` stubs). We intentionally do NOT delete the
    // corresponding remote files — decryption failures usually mean a
    // different device encrypted with a different key, and deleting
    // would destroy their data.
    {
        let guard = sync.drives.lock().await;
        if let Some(m) = guard.get(label) {
            m.log_sync_diagnostics(label);
            let failed_ids = m.cleanup_failed_downloads();
            if !failed_ids.is_empty() {
                info!(
                    count = failed_ids.len(),
                    label = label,
                    "Cleaned up local download artifact(s) (remote files preserved)",
                );
                // Remove pending activity entries for cleaned-up files so
                // they don't appear in recent activity.
                let mut pending = sync
                    .pending_activity
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let before = pending.len();
                pending.retain(|item| {
                    if item.label != label || item.action != "downloaded" {
                        return true;
                    }
                    !failed_ids.iter().any(|id| item.file_name.contains(id))
                });
                let removed = before - pending.len();
                if removed > 0 {
                    info!(
                        removed,
                        label = label,
                        "Removed pending activity for failed downloads",
                    );
                }
            }
        }
    }

    // Refresh the synced-paths cache so the file browser shows accurate
    // sync status even when the drives lock is held by the next cycle.
    {
        let guard = sync.drives.lock().await;
        if let Some(m) = guard.get(label) {
            if let Ok(state) = m.load_sync_state() {
                let paths = crate::commands::file_commands::build_synced_paths_from_state(&state);
                sync.update_synced_paths_cache(label, paths);
            }
        }
    }

    let label_owned = label.to_string();
    match result {
        SyncResult::Synced {
            outcome: Ok(outcome),
            staged_downloads,
        } => {
            sync.reset_sync_failures();
            info!(
                label = %label_owned,
                uploaded = outcome.files_uploaded,
                downloaded = outcome.files_downloaded,
                deleted_local = outcome.files_deleted_locally,
                deleted_remote = outcome.files_deleted_remotely,
                conflicts_resolved = outcome.conflicts_resolved,
                conflicts_skipped = outcome.conflicts_skipped,
                "Sync completed",
            );

            if outcome.files_uploaded > 0 || outcome.files_downloaded > 0 {
                // Download progress callbacks record entries with encrypted
                // names (e.g. "file_a7339456c25845c2"). Replace them with
                // real file names before committing.
                {
                    let now = chrono::Utc::now().timestamp();

                    if !staged_downloads.is_empty() {
                        // Staged plan had the downloads — use those names
                        // (they are already human-readable).
                        // Collect new items first, then retain + push in a single
                        // lock scope to prevent TOCTOU interleaving.
                        let new_items: Vec<_> = staged_downloads
                            .iter()
                            .map(|f| {
                                let file_name = std::path::Path::new(&f.path)
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_else(|| f.path.clone());
                                SyncActivityItem {
                                    file_name,
                                    action: "downloaded".to_string(),
                                    timestamp: now,
                                    size_bytes: 0,
                                    label: label_owned.clone(),
                                }
                            })
                            .collect();
                        {
                            let mut pending = sync
                                .pending_activity
                                .lock()
                                .unwrap_or_else(|p| p.into_inner());
                            pending.retain(|item| {
                                !(item.label == label_owned && item.action == "downloaded")
                            });
                            pending.extend(new_items);
                        }
                    } else if outcome.files_downloaded > 0 {
                        // Staging missed these downloads (stale remote cache).
                        // Resolve encrypted names via the path_index.
                        let path_index = {
                            let guard = sync.drives.lock().await;
                            guard
                                .get(&label_owned)
                                .and_then(|m| m.build_path_index().ok())
                        };

                        let mut pending = sync
                            .pending_activity
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        for item in pending.iter_mut() {
                            if item.label == label_owned
                                && item.action == "downloaded"
                                && item.file_name.starts_with("file_")
                            {
                                let hash_prefix = item.file_name.trim_start_matches("file_");
                                let resolved = path_index
                                    .as_ref()
                                    .and_then(|idx| idx.get(hash_prefix).cloned());
                                match resolved {
                                    Some(real_name) => {
                                        debug!(
                                            from = %item.file_name,
                                            to = %real_name,
                                            "Resolved download name",
                                        );
                                        item.file_name = real_name;
                                    }
                                    None => {
                                        debug!(
                                            encrypted_name = %item.file_name,
                                            "Could not resolve encrypted name",
                                        );
                                        let short_hash = if hash_prefix.len() >= 6 {
                                            &hash_prefix[..6]
                                        } else {
                                            hash_prefix
                                        };
                                        item.file_name = format!("file ({})", short_hash);
                                    }
                                }
                            }
                        }
                    }
                }

                debug!(label = %label_owned, "Committing pending activity");
                sync.commit_pending_activity_for_label(&label_owned);
            } else {
                debug!(label = %label_owned, "Discarding pending activity (no files transferred)");
                sync.discard_pending_activity_for_label(&label_owned);
            }

            if emitted_sync_started {
                if let Err(e) = app.emit(
                    "hcfs_sync_completed",
                    serde_json::json!({
                        "label": label_owned,
                        "files_uploaded": outcome.files_uploaded,
                        "files_downloaded": outcome.files_downloaded,
                        "files_deleted_locally": outcome.files_deleted_locally,
                        "files_deleted_remotely": outcome.files_deleted_remotely,
                        "conflicts_resolved": outcome.conflicts_resolved,
                        "conflicts_skipped": outcome.conflicts_skipped,
                    }),
                ) {
                    warn!(error = %e, "Failed to emit hcfs_sync_completed");
                }
            }

            // After a successful migration drive sync, report migrated files.
            // Called on every sync (not just when files_uploaded > 0) so that
            // server-side status is re-checked even after the initial report.
            // The report function itself is idempotent and skips already-complete migrations.
            if label_owned == "migration" {
                use tauri::Manager;
                let app_state = app.state::<crate::app_state::AppState>();
                match crate::utils::sync::current_account_id(&app_state) {
                    Ok(active_account) => {
                        let app_clone = app.clone();
                        tokio::spawn(async move {
                            if let Err(e) = crate::commands::migration::report_migrated_files(
                                &app_clone,
                                &active_account,
                            )
                            .await
                            {
                                error!(error = %e, "Migration report error");
                            }
                        });
                    }
                    Err(e) => {
                        warn!(error = %e, "Migration cannot report: no active account");
                    }
                }
            }
        }
        SyncResult::Synced {
            outcome: Err(e), ..
        } => {
            let failures = sync.record_sync_failure();
            sync.discard_pending_activity_for_label(&label_owned);
            let err_str = e.to_string();
            error!(
                label = %label_owned,
                consecutive_failure = failures,
                error = %err_str,
                "Sync failed",
            );

            // Detect auth token expiration — attempt automatic refresh so
            // the next sync cycle uses a valid token without frontend round-trip.
            if err_str.contains("401") || err_str.contains("Unauthorized") {
                warn!(label = %label_owned, "Auth token expired, attempting automatic refresh");
                if let Err(e) = app.emit(
                    "hcfs_auth_token_expired",
                    serde_json::json!({"label": label_owned}),
                ) {
                    warn!(error = %e, "Failed to emit hcfs_auth_token_expired");
                }

                // Try to refresh the token automatically using the stored mnemonic.
                // This avoids requiring the frontend to manually call refresh_auth_token.
                {
                    if let (Ok(pool), Ok(acct)) = (
                        app_state.pool(),
                        crate::utils::sync::current_account_id(&app_state),
                    ) {
                        let pool = pool.clone();
                        let app_clone = app.clone();
                        tokio::spawn(async move {
                            match crate::commands::auth::refresh_auth_token_internal(
                                &pool, &app_clone, &acct,
                            )
                            .await
                            {
                                Ok(()) => info!(
                                    "Auto token refresh succeeded, next sync will use fresh token"
                                ),
                                Err(e) => warn!(error = %e, "Auto token refresh failed"),
                            }
                        });
                    }
                }
            }

            if emitted_sync_started {
                if let Err(e) = app.emit(
                    "hcfs_sync_error",
                    serde_json::json!({"label": label_owned, "error": err_str}),
                ) {
                    warn!(error = %e, "Failed to emit hcfs_sync_error");
                }
            }
        }
        SyncResult::NoChanges => {
            sync.reset_sync_failures();
            sync.discard_pending_activity_for_label(&label_owned);
        }
        SyncResult::ConflictsPending => {
            sync.discard_pending_activity_for_label(&label_owned);
            if emitted_sync_started {
                if let Err(e) = app.emit(
                    "hcfs_sync_completed",
                    serde_json::json!({
                        "label": label_owned,
                        "files_uploaded": 0,
                        "files_downloaded": 0,
                        "files_deleted_locally": 0,
                        "files_deleted_remotely": 0,
                        "conflicts_resolved": 0,
                        "conflicts_skipped": 0,
                    }),
                ) {
                    warn!(error = %e, "Failed to emit hcfs_sync_completed");
                }
            }
        }
        SyncResult::NotAvailable => {
            sync.discard_pending_activity_for_label(&label_owned);
            warn!(label = %label_owned, "Drive not available or not unlocked, skipping sync");
            return false;
        }
    }

    true
}
