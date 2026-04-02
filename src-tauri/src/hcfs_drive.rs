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

use crate::sync_events;
use crate::sync_shared::{ConnectivityStatus, SyncActivityItem, SyncEngineHealth};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::drive::{Drive, ExcludeRules};
use hcfs_client::sync::{SyncConflict, SyncConflictResolution, SyncConflictType, SyncMode, SyncOutcome, SyncProgress};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

/// A file identified for sync during the staging phase.
#[derive(Debug, Serialize, Clone)]
pub struct StagedFile {
    pub file_id: String,
    pub path: String,
}

/// A file with conflicting local and remote versions requiring resolution.
#[derive(Debug, Serialize, Clone)]
pub struct StagedConflict {
    pub file_id: String,
    pub path: String,
    pub conflict_type: String,
    pub has_local: bool,
    pub has_remote: bool,
}

/// Complete sync plan produced by staging — everything the next sync
/// cycle will upload, download, delete, or ask the user to resolve.
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
        self.drive.init(password, mnemonic).map_err(|e| e.to_string())
    }

    pub fn unlock(&mut self, password: &str) -> Result<String, String> {
        self.drive.unlock(password).map_err(|e| e.to_string())?;
        self.drive.user_id().ok_or_else(|| "Failed to get user_id after unlock".to_string())
    }

    pub fn is_unlocked(&self) -> bool {
        self.drive.is_unlocked()
    }
    pub fn is_initialized(&self) -> bool {
        self.drive.is_initialized()
    }
    #[expect(dead_code)]
    pub fn user_id(&self) -> Option<String> {
        self.drive.user_id()
    }
    pub fn sync_path(&self) -> &Path {
        &self.sync_path
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    // ── Exclusion pattern delegates ─────────────────────────────────────

    /// List all active exclusion patterns for this drive.
    pub fn list_exclude_patterns(&self) -> Vec<String> {
        self.drive.list_exclude_patterns()
    }

    /// Add an exclusion pattern. Returns `true` if added, `false` if
    /// already present.
    pub fn add_exclude_pattern(&self, pattern: &str) -> Result<bool, String> {
        self.drive.add_exclude_pattern(pattern).map_err(|e| e.to_string())
    }

    /// Remove an exclusion pattern. Returns `true` if removed, `false` if
    /// not found.
    pub fn remove_exclude_pattern(&self, pattern: &str) -> Result<bool, String> {
        self.drive.remove_exclude_pattern(pattern).map_err(|e| e.to_string())
    }

    /// Check whether a relative path is excluded by the current rules.
    pub fn is_excluded(&self, path: &Path, is_dir: bool) -> bool {
        self.drive.is_excluded(path, is_dir)
    }

    pub fn client_config(&self) -> Option<&HcfsClientConfig> {
        self.client_config.as_ref()
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
        let mut config = self.client_config.clone().ok_or("Drive has no config set")?;
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
    /// This method is `async` for API consistency with the rest of `HcfsDriveManager`,
    /// though the underlying `drive.stage()` is synchronous.
    pub async fn stage_with_paths(&self) -> Result<StagedChanges, String> {
        let (plan, state) = self.drive.stage().map_err(|e| e.to_string())?;

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
                .map_or_else(|| hex::encode(c.path_hash), |p| p.to_string_lossy().to_string());
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
                .map_or_else(|| hex::encode(file_id), |p| p.to_string_lossy().to_string())
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
    pub async fn sync_with_resolutions(&mut self, resolutions: HashMap<String, String>) -> Result<SyncOutcome, String> {
        self.drive
            .sync_with_resolver(SyncMode::NonInteractive, Self::build_resolver(&resolutions))
            .await
            .map_err(|e| e.to_string())
    }

    /// Like [`sync_with_resolutions`] but accepts a [`CancellationToken`] that
    /// aborts the sync between file operations when cancelled.
    pub async fn sync_with_resolutions_cancellable(
        &mut self,
        resolutions: HashMap<String, String>,
        cancel_token: CancellationToken,
    ) -> Result<SyncOutcome, String> {
        self.drive
            .sync_with_resolver_cancellable(SyncMode::NonInteractive, Self::build_resolver(&resolutions), cancel_token)
            .await
            .map_err(|e| e.to_string())
    }

    fn build_resolver(resolutions: &HashMap<String, String>) -> impl Fn(&SyncConflict) -> SyncConflictResolution + '_ {
        |conflict| {
            let file_id_hex = match conflict {
                SyncConflict::Plan(c) => hex::encode(c.file_id),
                SyncConflict::Upload(c) => hex::encode(c.file_id),
            };
            resolutions.get(&file_id_hex).map_or(SyncConflictResolution::Skip, |r| match r.as_str() {
                "keep_local" => SyncConflictResolution::KeepLocal,
                "accept_remote" => SyncConflictResolution::AcceptRemote,
                "keep_both" => SyncConflictResolution::KeepBoth,
                _ => SyncConflictResolution::Skip,
            })
        }
    }

    /// Decrypt and return the Drive's actual BIP-39 mnemonic.
    pub fn export_mnemonic(&self, password: &str) -> Result<String, String> {
        let enc_path = self.config_dir.join("enc_mnemonic.json");
        let mnemonic = hcfs_client::auth::recover_mnemonic(&enc_path, password).map_err(|e| e.to_string())?;
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
            let known_path = state.path_index.get(file_id).map(|p| p.display().to_string());
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
        cleanup_failed_downloads_recursive(&self.sync_path, &mut failed_ids);
        failed_ids
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
            .scan_local_files(&mut state, &ExcludeRules::load(self.config_dir()))
            .map_err(|e| e.to_string())?;

        let mut index = HashMap::new();
        for (file_id, path) in &state.path_index {
            // Use the full relative path (e.g. "subdir/photo.jpg") so
            // activity items and recent-files can resolve the correct
            // on-disk location within the sync folder.
            let real_name = path.to_string_lossy().to_string();
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

/// Recursively walk `dir` to find and remove failed download artifacts.
fn cleanup_failed_downloads_recursive(dir: &std::path::Path, failed_ids: &mut Vec<String>) {
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
            cleanup_failed_downloads_recursive(&path, failed_ids);
            continue;
        }

        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Pattern 1: `downloaded_<hex>` — raw encrypted content artifact
        if let Some(hex_part) = crate::sync_logic::is_failed_download_artifact(&name_str) {
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
        // Briefly lock each per-drive mutex to read config.
        // Uses try_lock to avoid blocking if a drive is syncing.
        let mut url = None;
        for slot in guard.values() {
            if let Ok(m) = slot.manager.try_lock()
                && let Some(c) = m.client_config()
            {
                url = Some(c.base_url.clone());
                break;
            }
        }
        url
    };

    let Some(server_url) = server_url else {
        return ConnectivityStatus::Connected;
    };

    let health_url = format!("{server_url}/health");
    let now = chrono::Utc::now().timestamp();

    let result = health_client.get(&health_url).header("X-API-Key", "Arion").send().await;

    match result {
        Ok(resp) => {
            let status_code = resp.status().as_u16();
            match status_code {
                200 => {
                    let version = resp
                        .json::<serde_json::Value>()
                        .await
                        .ok()
                        .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(String::from));
                    record_health_success(sync, app, version, now)
                }
                401 | 403 => {
                    let msg = format!("Auth failed (HTTP {status_code})");
                    warn!("{}", msg);
                    record_health_failure(sync, app, ConnectivityStatus::AuthExpired, msg, now)
                }
                _ => {
                    let msg = format!("Server returned HTTP {status_code}");
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
        (ConnectivityStatus::Degraded, format!("Request timed out: {msg}"))
    } else if e.is_connect() {
        if msg.contains("dns") || msg.contains("resolve") || msg.contains("lookup") {
            (ConnectivityStatus::NetworkOffline, format!("DNS resolution failed: {msg}"))
        } else {
            (ConnectivityStatus::ServerUnreachable, format!("Connection failed: {msg}"))
        }
    } else if e.is_request() {
        (ConnectivityStatus::NetworkOffline, format!("Request failed: {msg}"))
    } else {
        (ConnectivityStatus::ServerUnreachable, format!("Unknown error: {msg}"))
    }
}

/// Record a successful health check. Emits event if status was previously unhealthy.
fn record_health_success(sync: &crate::sync_engine::SyncEngine, app: &AppHandle, version: Option<String>, now: i64) -> ConnectivityStatus {
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

        crate::sync_logic::should_emit_health_change(&previous_status, &new_status, new_failures, HEALTH_FAILURE_THRESHOLD)
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
    let mut health = sync.health.lock().unwrap_or_else(|poisoned| {
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
    if let Err(e) = app.emit(sync_events::CONNECTIVITY_CHANGED, &health) {
        warn!(error = %e, "Failed to emit connectivity_changed");
    }
}

/// Check if sync should be skipped based on health status.
fn should_skip_sync(sync: &crate::sync_engine::SyncEngine, status: &ConnectivityStatus) -> bool {
    crate::sync_logic::should_skip_sync_check(status, sync.get_health().consecutive_failures, HEALTH_FAILURE_THRESHOLD)
}

/// Heartbeat interval: sync every 30 seconds regardless of local changes
const HEARTBEAT_SECS: u64 = 30;

/// Debounce interval: wait 5 seconds after local changes before syncing
const DEBOUNCE_SECS: u64 = 5;

/// Proactively refresh the auth token if it expires within the refresh margin.
async fn maybe_refresh_token(app: &AppHandle) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    if let (Ok(pool), Ok(acct)) = (app_state.pool(), crate::utils::sync::current_account_id(&app_state))
        && crate::utils::auth_tokens::is_token_expiring(pool, &acct, crate::utils::auth_tokens::TOKEN_REFRESH_MARGIN_SECS).await
    {
        info!("Token expiring soon, proactively refreshing");
        if let Err(e) = crate::auth_service::refresh_auth_token_internal(pool, app, &acct).await {
            warn!(error = %e, "Proactive token refresh failed");
        }
    }
}

/// Process a single file-watcher event: filter internal paths, capture rename
/// hints, flag pending changes, and notify the sync channel.
fn handle_watcher_event(
    event: notify::Event,
    sync: &crate::sync_engine::SyncEngine,
    pending: &std::sync::Arc<std::sync::Mutex<Option<crate::sync_logic::PendingRenameFrom>>>,
    tx: &tokio::sync::mpsc::Sender<()>,
) {
    // Filter out internal metadata files (.hcfs/, sync_progress/) that
    // would create a feedback loop: sync writes state -> watcher fires ->
    // triggers another sync -> writes state -> ...
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

    // Capture rename events as hints for efficient rename detection.
    use notify::event::{ModifyKind, RenameMode};
    if let notify::EventKind::Modify(ModifyKind::Name(mode)) = &event.kind {
        let now = std::time::Instant::now();
        let mut pending_guard = recover_mutex(pending);
        let mut local_hints = Vec::new();

        let rename_kind = match mode {
            RenameMode::From => event.paths.first().map(|p| (crate::sync_logic::RenameEventKind::From, p)),
            RenameMode::To => event.paths.first().map(|p| (crate::sync_logic::RenameEventKind::To, p)),
            RenameMode::Both if event.paths.len() >= 2 => Some((
                crate::sync_logic::RenameEventKind::Both {
                    from: event.paths[0].clone(),
                },
                &event.paths[1],
            )),
            _ => event.paths.first().map(|p| (crate::sync_logic::RenameEventKind::Any, p)),
        };

        if let Some((kind, path)) = rename_kind {
            crate::sync_logic::process_rename_event(kind, path, now, &mut pending_guard, &mut local_hints);
        }

        for hint in local_hints {
            tracing::debug!(
                old = %hint.old_path.display(),
                new = %hint.new_path.display(),
                "Rename hint captured",
            );
            sync.push_rename_hint(hint);
        }
    }

    if sync.is_any_sync_in_progress() {
        sync.changes_pending.store(true, Ordering::Release);
    }
    let _ = tx.try_send(());
}

/// Run the fallback sync loop (used when the file watcher cannot be created).
/// Polls on a heartbeat interval instead of reacting to FS events.
async fn run_fallback_sync_loop(app: AppHandle, sync: std::sync::Arc<crate::sync_engine::SyncEngine>) {
    info!("Running initial sync (no file watcher)");
    check_server_health(&app).await;
    trigger_sync(&app).await;

    let mut interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
    loop {
        let failures = sync.get_sync_failures();
        let backoff_secs = crate::sync_logic::compute_backoff(failures, HEARTBEAT_SECS);
        if failures > 0 {
            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        } else {
            interval.tick().await;
        }
        if sync.is_cancelled() {
            break;
        }
        let health_status = check_server_health(&app).await;
        if should_skip_sync(&sync, &health_status) {
            warn!(status = ?health_status, "Skipping sync due to connectivity");
        } else {
            maybe_refresh_token(&app).await;
            trigger_sync(&app).await;
        }
    }
    info!("Sync loop exited (no file watcher)");
}

/// Run the main sync loop that reacts to FS watcher events and heartbeat ticks.
async fn run_sync_loop(app: AppHandle, sync: std::sync::Arc<crate::sync_engine::SyncEngine>, mut rx: tokio::sync::mpsc::Receiver<()>) {
    // Clean up any stale temp files from previous runs
    {
        let guard = sync.drives.lock().await;
        for slot in guard.values() {
            if let Ok(manager) = slot.manager.try_lock() {
                manager.cleanup_temp();
            }
        }
    }

    info!("Running initial sync");
    check_server_health(&app).await;
    trigger_sync(&app).await;

    let mut debounce = tokio::time::interval(Duration::from_secs(DEBOUNCE_SECS));
    let mut has_changes = false;
    let mut last_sync = Instant::now();

    loop {
        if sync.is_cancelled() {
            break;
        }

        tokio::select! {
            msg = rx.recv() => {
                if msg.is_none() { break; }
                has_changes = true;
            }
            _ = debounce.tick() => {
                let failures = sync.get_sync_failures();
                let backoff_secs =
                    crate::sync_logic::compute_backoff(failures, HEARTBEAT_SECS);
                let heartbeat_due =
                    last_sync.elapsed() >= Duration::from_secs(backoff_secs);
                if has_changes || heartbeat_due {
                    if heartbeat_due {
                        let health_status = check_server_health(&app).await;
                        if should_skip_sync(&sync, &health_status) {
                            warn!(status = ?health_status, "Skipping sync due to connectivity");
                            last_sync = Instant::now();
                            continue;
                        }
                        maybe_refresh_token(&app).await;
                    }

                    let sync_ran = trigger_sync(&app).await;
                    if sync_ran {
                        has_changes = false;
                        last_sync = Instant::now();

                        // Drain watcher events that arrived during sync
                        while rx.try_recv().is_ok() {}

                        if sync.changes_pending.swap(false, Ordering::AcqRel) {
                            has_changes = true;
                        }
                    }
                }
            }
        }
    }

    // Loop exited -- clear the watcher
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered in sync loop exit");
            p.into_inner()
        });
        *watcher_guard = None;
    }
    info!("Sync loop exited");
}

/// Hot-add new drive paths to the existing watcher and trigger a background
/// sync. Called when `start_sync_loop` detects a loop is already running.
async fn hot_add_drives(app: &AppHandle, sync: &crate::sync_engine::SyncEngine) {
    let drive_paths = collect_drive_paths(sync).await;
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered");
            p.into_inner()
        });
        if let Some(w) = watcher_guard.as_mut() {
            for (label, path) in &drive_paths {
                match w.watch(path, RecursiveMode::Recursive) {
                    Ok(()) => info!(label = %label, path = ?path, "Watching new drive"),
                    Err(e) => error!(label = %label, path = ?path, error = %e, "Failed to watch new drive path"),
                }
            }
        } else {
            warn!("No file watcher available — new drives will sync on heartbeat only");
        }
    }
    info!("Sync loop already running — hot-added drives, triggering sync");

    let app_for_sync = app.clone();
    tokio::spawn(async move { trigger_sync(&app_for_sync).await });
}

/// Start or join the background sync loop.
///
/// If no loop is running, creates a file watcher for all registered drives,
/// stores it in `SyncEngine::watcher`, and spawns the sync loop task.
///
/// If a loop IS already running, adds any new drive paths to the existing
/// file watcher and triggers an immediate sync for all drives (already-syncing
/// drives will be skipped by `trigger_sync_for_drive`). This is the key
/// multi-folder behaviour: adding a second folder NEVER interrupts downloads
/// in progress for the first folder.
pub async fn start_sync_loop(app: AppHandle) {
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();

    // If a loop is already running, just hot-add new drives
    {
        let handle_guard = sync.loop_handle.lock().await;
        if handle_guard.is_some() {
            drop(handle_guard);
            hot_add_drives(&app, &sync).await;
            return;
        }
    }

    info!("Starting sync loop");

    let drive_paths = collect_drive_paths(&sync).await;
    if drive_paths.is_empty() {
        info!("No drives registered, sync loop not started");
        return;
    }

    for (label, path) in &drive_paths {
        info!(label = %label, path = ?path, "Watching drive");
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<()>(256);

    // Create file watcher
    let tx_clone = tx.clone();
    let sync_for_watcher = sync.clone();
    let pending_for_watcher: std::sync::Arc<std::sync::Mutex<Option<crate::sync_logic::PendingRenameFrom>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));

    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            handle_watcher_event(event, &sync_for_watcher, &pending_for_watcher, &tx_clone);
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            error!(error = %e, "Failed to create file watcher, sync loop will run without file watching");
            let sync_fallback = sync.clone();
            let handle = tokio::spawn(run_fallback_sync_loop(app, sync_fallback));
            let mut handle_guard = sync.loop_handle.lock().await;
            *handle_guard = Some(handle);
            return;
        }
    };

    for (label, path) in &drive_paths {
        if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
            error!(path = ?path, label = %label, error = %e, "Failed to watch path");
        }
    }

    // Store watcher so new drives can be hot-added
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered");
            p.into_inner()
        });
        *watcher_guard = Some(watcher);
    }

    let sync_task = sync.clone();
    let handle = tokio::spawn(run_sync_loop(app, sync_task, rx));
    let mut handle_guard = sync.loop_handle.lock().await;
    *handle_guard = Some(handle);
}

/// Collect (label, path) pairs from all registered drives.
///
/// Uses `try_lock` on each drive manager — drives currently mid-sync will
/// be skipped. This is fine for watcher registration since those drives
/// were already watched when first registered.
async fn collect_drive_paths(sync: &crate::sync_engine::SyncEngine) -> Vec<(String, PathBuf)> {
    let guard = sync.drives.lock().await;
    let mut paths = Vec::new();
    for (label, slot) in guard.iter() {
        if let Ok(m) = slot.manager.try_lock() {
            paths.push((label.clone(), m.sync_path().to_path_buf()));
        }
    }
    paths
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

    // Sync all drives concurrently — each drive has its own per-drive lock
    // so they don't block each other.
    let handles: Vec<_> = labels
        .into_iter()
        .map(|label| {
            let app = app.clone();
            tokio::spawn(async move { trigger_sync_for_drive(&app, &label).await })
        })
        .collect();

    let mut any_ran = false;
    for handle in handles {
        if let Ok(ran) = handle.await {
            any_ran |= ran;
        }
    }
    any_ran
}

/// Pre-sync check: verify the folder still exists on the server.
///
/// When another device calls `delete_remote_folder` (unregister), the folder
/// vanishes from the server. If we then run `sync_with_resolutions`, the
/// three-tree algorithm sees an empty remote tree and deletes all local files.
///
/// This function queries `list_remote_folders` *before* syncing. If our
/// folder_hash is missing it:
///   1. Re-registers the folder on the server.
///   2. Wipes local `sync_state.json` (so hcfs-client sees all local files as
///      new uploads rather than computing deletions).
///   3. Returns `true` so the caller can re-initialise the drive before syncing.
///
/// The function takes extracted data instead of `&HcfsDriveManager` so that
/// callers can drop the drives lock before making network calls.
///
/// Returns `Ok(true)` if recovery was performed,
/// `Ok(false)` if the folder exists and no action was needed,
/// `Err` if the server check itself failed.
async fn check_and_recover_remote_folder(
    config: &HcfsClientConfig,
    config_dir: &std::path::Path,
    label: &str,
    pool: &sqlx::SqlitePool,
    account_id: &str,
) -> Result<bool, String> {
    let folder_hash = config.folder_hash.clone();
    let ss58 = config.ss58_address.clone();

    // Build a client with an empty folder_hash — list_remote_folders is account-scoped
    let list_config = HcfsClientConfig {
        folder_hash: String::new(),
        ..config.clone()
    };
    let client = hcfs_client::client::HcfsClient::new(list_config).map_err(|e| format!("Failed to create HCFS client: {e}"))?;

    let folders = client
        .list_remote_folders(&ss58)
        .await
        .map_err(|e| format!("Failed to list remote folders: {e}"))?;

    let exists = !crate::sync_logic::folder_needs_recovery(&folders, &folder_hash);
    if exists {
        return Ok(false);
    }

    // Folder is gone — recover
    warn!(
        label = label,
        folder_hash = %folder_hash,
        "Remote folder missing — re-registering and resetting sync state",
    );

    // 1. Re-register the folder on the server
    ensure_folder_registered(config, label, pool).await?;

    // 2. Wipe sync_state.json so hcfs-client sees a fresh remote tree.
    //    All local files will be treated as new uploads.
    let state_path = config_dir.join("sync_state.json");
    let state_bak = config_dir.join("sync_state.json.bak");
    let _ = std::fs::remove_file(&state_path);
    let _ = std::fs::remove_file(&state_bak);

    info!(
        label = label,
        account_id = account_id,
        "Remote folder recovery complete — next sync will re-upload local files",
    );

    Ok(true)
}

/// Ensure the folder is registered in the server's folder registry.
///
/// This is idempotent — the server uses `ON CONFLICT DO UPDATE`, so calling it
/// when the folder already exists simply refreshes the `updated_at` timestamp.
/// This is critical because the server's upload endpoint does NOT check folder
/// registration: files can be uploaded to a folder that isn't in the registry,
/// making the folder invisible to `list_remote_folders` on other devices.
async fn ensure_folder_registered(config: &HcfsClientConfig, label: &str, pool: &sqlx::SqlitePool) -> Result<(), String> {
    let folder_hash = &config.folder_hash;
    let ss58 = &config.ss58_address;

    let register_client =
        hcfs_client::client::HcfsClient::new(config.clone()).map_err(|e| format!("Failed to create HCFS client for registration: {e}"))?;

    let dev_name: Option<String> = sqlx::query_scalar::<_, String>("SELECT device_name FROM device_settings WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to read device name: {e}"))
        .ok()
        .flatten();

    register_client
        .register_folder(ss58, folder_hash, label, dev_name.as_deref())
        .await
        .map_err(|e| {
            error!(
                label = label,
                error = %e,
                "Failed to register folder on server",
            );
            format!("Failed to register folder: {e}")
        })?;

    info!(label = label, folder_hash = %folder_hash, "Folder registered on server");
    Ok(())
}

/// Tri-state result of a single sync cycle for one drive.
///
/// Carries staged file lists so post-sync processing can record activity
/// with real file names (the download progress callback only sees encrypted
/// names).
enum SyncResult {
    Synced {
        outcome: Result<SyncOutcome, String>,
        staged_downloads: Vec<StagedFile>,
        sync_path: PathBuf,
    },
    ConflictsPending,
    #[expect(dead_code)]
    NoChanges,
    NotAvailable,
}

/// Recover a poisoned `std::sync::Mutex` by discarding the poison error.
fn recover_mutex<T>(lock: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Check token refresh, review mode timeout, and is_syncing under a single
/// lock scope. Returns `true` when the sync cycle may proceed.
fn check_sync_preconditions(app: &AppHandle, sync: &crate::sync_engine::SyncEngine, label: &str) -> bool {
    let mut states = recover_mutex(&sync.states);

    if sync.is_token_refreshing() {
        debug!(label = label, "Token refresh in progress, skipping sync");
        return false;
    }

    if let Some(s) = states.get(label)
        && s.in_review
    {
        const REVIEW_TIMEOUT_SECS: i64 = 300;
        let timed_out = s.review_entered_at > 0 && {
            let now = chrono::Utc::now().timestamp_millis();
            (now - s.review_entered_at) > REVIEW_TIMEOUT_SECS * 1000
        };
        if timed_out {
            warn!(
                timeout_secs = REVIEW_TIMEOUT_SECS,
                label = label,
                "Review mode timed out, auto-skipping conflicts and resuming sync"
            );
            if let Some(s) = states.get_mut(label) {
                s.in_review = false;
                s.review_entered_at = 0;
            }
            if let Err(e) = app.emit(sync_events::REVIEW_MODE_TIMEOUT, sync_events::LabelPayload { label: label.to_string() }) {
                warn!(error = %e, "Failed to emit review_mode_timeout");
            }
        } else {
            debug!(label = label, "Review mode active, skipping auto-sync");
            return false;
        }
    }

    match states.get_mut(label) {
        Some(s) if s.is_syncing => {
            debug!(label = label, "Sync already in progress, will retry on next cycle");
            false
        }
        Some(s) => {
            s.is_syncing = true;
            true
        }
        None => {
            states.insert(
                label.to_string(),
                crate::sync_shared::HcfsSyncState {
                    is_syncing: true,
                    ..Default::default()
                },
            );
            true
        }
    }
}

/// Pre-sync check: verify the folder still exists on the server.
///
/// If another device deleted the remote folder, re-register it and wipe sync
/// state so local files are re-uploaded instead of deleted. Extracts config
/// under the drives lock, then drops it before doing network I/O.
async fn run_presync_folder_check(app: &AppHandle, sync: &crate::sync_engine::SyncEngine, app_state: &crate::app_state::AppState, label: &str) {
    let drive_info = {
        let drive_arc = {
            let guard = sync.drives.lock().await;
            guard.get(label).map(|slot| slot.manager.clone())
        };
        if let Some(arc) = drive_arc {
            let m = arc.lock().await;
            m.client_config().map(|c| (c.clone(), m.config_dir().to_path_buf()))
        } else {
            None
        }
    };

    if let Some((config, config_dir)) = drive_info
        && let (Ok(pool), Ok(acct)) = (app_state.pool(), crate::utils::sync::current_account_id(app_state))
    {
        match check_and_recover_remote_folder(&config, &config_dir, label, pool, &acct).await {
            Ok(true) => {
                info!(label = label, "Remote folder recovered — sync will re-upload local files");
                if let Err(e) = app.emit(sync_events::FOLDER_RECOVERED, sync_events::LabelPayload { label: label.to_string() }) {
                    warn!(error = %e, "Failed to emit folder_recovered");
                }
            }
            Ok(false) => {}
            Err(e) => {
                warn!(label = label, error = %e, "Pre-sync folder check failed, continuing with sync");
            }
        }
    }
}

/// Drain rename hints for this drive's root, expand directory renames, and
/// resolve to relative paths. Currently consumed without effect pending
/// hcfs-client rename support (thenervelab/hcfs#52).
fn resolve_rename_hints(sync: &crate::sync_engine::SyncEngine, label: &str, drive_sync_path: &Path) {
    let raw_hints = sync.drain_rename_hints_for_root(drive_sync_path);
    if raw_hints.is_empty() {
        return;
    }

    let known_from_cache: Vec<std::path::PathBuf> = sync
        .get_cached_synced_paths(label)
        .map_or_else(Vec::new, |cache| cache.keys().map(std::path::PathBuf::from).collect());

    let mut file_hints = Vec::new();
    for hint in &raw_hints {
        let Some(rel_hint) = crate::sync_logic::hint_to_relative_pair(hint, drive_sync_path) else {
            continue;
        };

        let has_children = known_from_cache
            .iter()
            .any(|p| p.starts_with(&rel_hint.old_relative_path) && *p != rel_hint.old_relative_path);

        if has_children {
            let expanded = crate::sync_logic::expand_directory_hint(hint, drive_sync_path, &known_from_cache);
            info!(
                label = label,
                dir_old = %hint.old_path.display(),
                dir_new = %hint.new_path.display(),
                expanded_count = expanded.len(),
                "Expanded directory rename hint",
            );
            file_hints.extend(expanded);
        } else {
            file_hints.push(rel_hint);
        }
    }
    info!(
        label = label,
        raw_count = raw_hints.len(),
        resolved_count = file_hints.len(),
        "Rename hints resolved for sync cycle",
    );
    // TODO(thenervelab/hcfs#52): Pass `file_hints` to hcfs-client once it
    // accepts PathRenameHint.
    let _ = file_hints;
}

/// Execute the core sync cycle: resolve renames, run sync, handle conflicts.
///
/// Returns a `SyncResult` indicating what happened. Holds the per-drive lock
/// for the duration of the sync operation.
async fn run_sync_cycle(
    app: &AppHandle,
    sync: &std::sync::Arc<crate::sync_engine::SyncEngine>,
    label: &str,
    drive_arc: &std::sync::Arc<tokio::sync::Mutex<HcfsDriveManager>>,
    cancel_token: CancellationToken,
    emitted_sync_started: &mut bool,
) -> SyncResult {
    let mut m = drive_arc.lock().await;
    if !m.is_unlocked() {
        warn!(label = label, "Drive exists but is not unlocked");
        return SyncResult::NotAvailable;
    }

    let drive_sync_path = m.sync_path().to_path_buf();
    debug!(label = label, "Drive is unlocked, syncing directly");
    m.log_sync_diagnostics(label);

    resolve_rename_hints(sync, label, &drive_sync_path);

    if let Err(e) = app.emit(sync_events::SYNC_STARTED, sync_events::SyncStartedPayload::empty(label)) {
        warn!(error = %e, "Failed to emit sync_started");
    }
    *emitted_sync_started = true;

    info!(label = label, "sync_with_resolutions starting");
    sync.reset_progress_time();

    let stall_token = cancel_token.clone();
    let stall_sync = sync.clone();
    let stall_label = label.to_string();
    let stall_handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if stall_sync.is_progress_stalled() {
                error!(label = %stall_label, "Sync stalled — no progress for 3 minutes");
                stall_token.cancel();
                break;
            }
            if stall_sync.is_cancelled() {
                stall_token.cancel();
                break;
            }
        }
    });

    let outcome = m.sync_with_resolutions_cancellable(HashMap::new(), cancel_token).await;
    stall_handle.abort();

    info!(label = label, success = outcome.is_ok(), "sync_with_resolutions returned");

    match &outcome {
        Ok(o) if o.conflicts_skipped > 0 => handle_conflicts_skipped(app, sync, label, o, &mut m).await,
        _ => SyncResult::Synced {
            outcome,
            staged_downloads: Vec::new(),
            sync_path: drive_sync_path,
        },
    }
}

/// Handle the case where sync completed but skipped conflicts.
///
/// Finalizes the session for files that DID sync, emits completion, then
/// re-stages to present real conflicts for user review.
async fn handle_conflicts_skipped(
    app: &AppHandle,
    sync: &crate::sync_engine::SyncEngine,
    label: &str,
    outcome: &SyncOutcome,
    m: &mut HcfsDriveManager,
) -> SyncResult {
    info!(
        conflicts_skipped = outcome.conflicts_skipped,
        label = label,
        "Conflicts skipped during auto-sync, re-staging for review",
    );

    finalize_session_for_label(
        sync,
        label,
        outcome.files_uploaded as u32,
        outcome.files_downloaded as u32,
        false,
        sync.changes_pending.load(Ordering::Acquire),
    );

    if let Err(e) = app.emit(
        sync_events::SYNC_COMPLETED,
        sync_events::SyncCompletedPayload::from_outcome(label, outcome),
    ) {
        warn!(error = %e, "Failed to emit sync_completed");
    }

    // Re-stage AFTER sync to present real conflicts for user review.
    match m.stage_with_paths().await {
        Ok(restaged) if !restaged.conflicts.is_empty() => {
            if sync.set_drive_review(label) {
                if let Err(e) = app.emit(
                    sync_events::CONFLICTS_PENDING,
                    sync_events::ConflictsPendingPayload {
                        label: label.to_string(),
                        staged: restaged,
                    },
                ) {
                    warn!(error = %e, "Failed to emit conflicts_pending");
                }
            } else {
                info!(label = label, "Conflicts found but review cooldown active, skipping banner");
            }
        }
        _ => {
            info!(label = label, "Re-stage after sync found no conflicts");
        }
    }
    SyncResult::ConflictsPending
}

/// Finalize the progress session for a single drive's label.
///
/// Marks pending files as failed or completed, then optionally completes the
/// session (deferred when other drives are still syncing or new files are
/// pending from the watcher). When `require_active_session` is true, the
/// finalization is skipped if the current session is not active (prevents
/// spurious snapshots during no-op heartbeat cycles).
fn finalize_session_for_label(
    sync: &crate::sync_engine::SyncEngine,
    label: &str,
    files_uploaded: u32,
    files_downloaded: u32,
    require_active_session: bool,
    changes_pending: bool,
) {
    if require_active_session {
        let session_is_active = {
            let state = recover_mutex(&sync.progress);
            state.current_session.as_ref().is_some_and(|s| s.is_active)
        };
        if !crate::sync_logic::should_finalize_session(session_is_active) {
            return;
        }
    }

    let label_expected = {
        let state = recover_mutex(&sync.progress);
        state
            .current_session
            .as_ref()
            .map(|s| crate::sync_progress::count_expected_for_label(s, label))
    };

    if let Some((exp_up, exp_down)) = label_expected {
        let has_failures = files_uploaded < exp_up || files_downloaded < exp_down;
        if has_failures {
            if let Err(e) = crate::sync_progress::mark_pending_files_as_failed(sync, files_uploaded, files_downloaded, label) {
                warn!(label = %label, error = %e, "Failed to mark pending files as failed");
            }
        } else if let Err(e) = crate::sync_progress::complete_pending_files(sync, label) {
            warn!(label = %label, error = %e, "Failed to complete pending files");
        }
    }

    let no_other_syncs = if require_active_session {
        !sync.is_any_sync_in_progress()
    } else {
        !sync.other_syncs_in_progress()
    };

    if no_other_syncs && !crate::sync_logic::should_defer_completion(changes_pending) {
        if let Err(e) = crate::sync_progress::complete_session(sync, files_uploaded, files_downloaded) {
            warn!(error = %e, "Failed to complete sync session");
        }
    } else if changes_pending {
        info!(label = %label, "Deferring session completion — new files pending from watcher");
    }
}

/// Log post-sync diagnostics, clean up failed download artifacts, prune
/// pending activity, and refresh the synced-paths cache.
async fn post_sync_cleanup(sync: &crate::sync_engine::SyncEngine, drive_arc: &std::sync::Arc<tokio::sync::Mutex<HcfsDriveManager>>, label: &str) {
    let m = drive_arc.lock().await;
    m.log_sync_diagnostics(label);
    let failed_ids = m.cleanup_failed_downloads();
    if !failed_ids.is_empty() {
        info!(
            count = failed_ids.len(),
            label = label,
            "Cleaned up local download artifact(s) (remote files preserved)",
        );
        let mut pending = recover_mutex(&sync.pending_activity);
        let before = pending.len();
        pending.retain(|item| {
            if item.label != label || item.action != "downloaded" {
                return true;
            }
            !failed_ids.iter().any(|id| item.file_name.contains(id))
        });
        let removed = before - pending.len();
        if removed > 0 {
            info!(removed, label = label, "Removed pending activity for failed downloads");
        }
    }

    if let Ok(state) = m.load_sync_state() {
        let paths = crate::sync_shared::build_synced_paths_from_state(&state);
        sync.update_synced_paths_cache(label, paths);
    }
}

/// Resolve pending download activity entries: replace encrypted names with
/// human-readable paths from staged downloads or the drive's path index.
async fn resolve_download_activity(
    sync: &crate::sync_engine::SyncEngine,
    drive_arc: &std::sync::Arc<tokio::sync::Mutex<HcfsDriveManager>>,
    label: &str,
    staged_downloads: &[StagedFile],
    files_downloaded: usize,
) {
    let now = chrono::Utc::now().timestamp();

    if !staged_downloads.is_empty() {
        let new_items: Vec<_> = staged_downloads
            .iter()
            .map(|f| SyncActivityItem {
                file_name: f.path.clone(),
                action: "downloaded".to_string(),
                timestamp: now,
                size_bytes: 0,
                label: label.to_string(),
            })
            .collect();
        let mut pending = recover_mutex(&sync.pending_activity);
        pending.retain(|item| !(item.label == label && item.action == "downloaded"));
        pending.extend(new_items);
    } else if files_downloaded > 0 {
        let path_index = {
            let m = drive_arc.lock().await;
            m.build_path_index().ok()
        };

        let mut pending = recover_mutex(&sync.pending_activity);
        for item in pending.iter_mut() {
            if item.label != label || item.action != "downloaded" || !item.file_name.starts_with("file_") {
                continue;
            }
            let hash_prefix = item.file_name.trim_start_matches("file_");
            let resolved = path_index.as_ref().and_then(|idx| idx.get(hash_prefix).cloned());
            if let Some(real_name) = resolved {
                debug!(from = %item.file_name, to = %real_name, "Resolved download name");
                item.file_name = real_name;
            } else {
                debug!(encrypted_name = %item.file_name, "Could not resolve encrypted name");
                let short_hash = if hash_prefix.len() >= 6 { &hash_prefix[..6] } else { hash_prefix };
                item.file_name = format!("file ({short_hash})");
            }
        }
    }
}

/// Create pending activity entries for locally or remotely deleted files.
///
/// hcfs-client has no delete progress callback, so we derive delete file
/// names from the progress session.
fn build_delete_activity(sync: &crate::sync_engine::SyncEngine, label: &str) {
    let now = chrono::Utc::now().timestamp();
    let delete_items: Vec<SyncActivityItem> = {
        let state = recover_mutex(&sync.progress);
        state
            .current_session
            .as_ref()
            .map(|session| {
                session
                    .files
                    .values()
                    .filter(|f| {
                        f.label == label
                            && (f.action == crate::sync_progress::FileAction::LocalDelete
                                || f.action == crate::sync_progress::FileAction::RemoteDelete)
                    })
                    .map(|f| SyncActivityItem {
                        file_name: f.file_name.clone(),
                        action: "deleted".to_string(),
                        timestamp: now,
                        size_bytes: 0,
                        label: label.to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    if !delete_items.is_empty() {
        let mut pending = recover_mutex(&sync.pending_activity);
        pending.extend(delete_items);
    }
}

/// Attempt to recover from a remote folder removal error.
///
/// Returns `true` when recovery succeeded and the next sync cycle should
/// re-upload local files. Resets the failure counter on success so the retry
/// happens immediately.
async fn try_error_folder_recovery(
    app: &AppHandle,
    sync: &crate::sync_engine::SyncEngine,
    app_state: &crate::app_state::AppState,
    drive_arc: &std::sync::Arc<tokio::sync::Mutex<HcfsDriveManager>>,
    label: &str,
    err_str: &str,
    drive_sync_path: &Path,
) -> bool {
    if !crate::sync_logic::is_remote_folder_removed_error(err_str) {
        return false;
    }

    warn!(
        label = %label,
        local_path = %drive_sync_path.display(),
        "Remote folder was removed by another device — attempting auto-recovery",
    );

    let drive_info = {
        let m = drive_arc.lock().await;
        m.client_config().map(|c| (c.clone(), m.config_dir().to_path_buf()))
    };

    let recovered = if let Some((config, config_dir)) = drive_info {
        if let (Ok(pool), Ok(acct)) = (app_state.pool(), crate::utils::sync::current_account_id(app_state)) {
            check_and_recover_remote_folder(&config, &config_dir, label, pool, &acct)
                .await
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };

    if recovered {
        info!(label = %label, "Remote folder recovered via error handler — next sync will re-upload");
        if let Err(e) = app.emit(sync_events::FOLDER_RECOVERED, sync_events::LabelPayload { label: label.to_string() }) {
            warn!(error = %e, "Failed to emit folder_recovered");
        }
    }

    sync.reset_sync_failures();
    sync.retry_at.store(0, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut guard) = sync.last_error.lock() {
        *guard = None;
    }

    true
}

/// Compute backoff, detect 401/auth errors, mark files failed, and emit the
/// sync_error event to the frontend.
fn apply_error_backoff_and_notify(
    app: &AppHandle,
    sync: &crate::sync_engine::SyncEngine,
    app_state: &crate::app_state::AppState,
    label: &str,
    err_str: String,
    failures: i64,
) {
    let backoff_secs = crate::sync_logic::compute_backoff(failures, HEARTBEAT_SECS);
    let now_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    sync.retry_at.store(now_epoch + backoff_secs as i64, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut guard) = sync.last_error.lock() {
        *guard = Some(err_str.clone());
    }

    if err_str.contains("401") || err_str.contains("Unauthorized") {
        warn!(label = %label, "Auth token expired, attempting automatic refresh");
        if let Err(e) = app.emit(sync_events::AUTH_TOKEN_EXPIRED, sync_events::LabelPayload { label: label.to_string() }) {
            warn!(error = %e, "Failed to emit auth_token_expired");
        }

        if let (Ok(pool), Ok(acct)) = (app_state.pool(), crate::utils::sync::current_account_id(app_state)) {
            let pool = pool.clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                match crate::auth_service::refresh_auth_token_internal(&pool, &app_clone, &acct).await {
                    Ok(()) => info!("Auto token refresh succeeded, next sync will use fresh token"),
                    Err(e) => warn!(error = %e, "Auto token refresh failed"),
                }
            });
        }
    }

    if let Err(e) = crate::sync_progress::mark_all_pending_files_as_failed(sync, err_str.clone()) {
        warn!(error = %e, "Failed to mark all pending files as failed");
    }

    if let Err(e) = app.emit(
        sync_events::SYNC_ERROR,
        sync_events::SyncErrorPayload {
            label: label.to_string(),
            error: err_str,
            retry_in_secs: backoff_secs,
            consecutive_failures: failures,
        },
    ) {
        warn!(error = %e, "Failed to emit sync_error");
    }

    sync.emit_snapshot(true);
}

/// Route the `SyncResult` to the appropriate post-sync handler.
///
/// Returns `true` when sync was successful (or partially successful with
/// conflicts), `false` when the drive was not available.
async fn dispatch_sync_result(
    app: &AppHandle,
    app_state: &crate::app_state::AppState,
    sync: &crate::sync_engine::SyncEngine,
    drive_arc: &std::sync::Arc<tokio::sync::Mutex<HcfsDriveManager>>,
    result: SyncResult,
    emitted_sync_started: bool,
    label: &str,
) -> bool {
    match result {
        SyncResult::Synced {
            outcome: Ok(outcome),
            staged_downloads,
            ..
        } => {
            handle_sync_success(app, app_state, sync, drive_arc, &outcome, &staged_downloads, label).await;

            if emitted_sync_started
                && let Err(e) = app.emit(
                    sync_events::SYNC_COMPLETED,
                    sync_events::SyncCompletedPayload::from_outcome(label, &outcome),
                )
            {
                warn!(error = %e, "Failed to emit sync_completed");
            }
            true
        }
        SyncResult::Synced {
            outcome: Err(e),
            sync_path: drive_sync_path,
            ..
        } => handle_sync_error(app, app_state, sync, drive_arc, &e, &drive_sync_path, label).await,
        SyncResult::NoChanges => {
            sync.clear_failure_state();
            sync.discard_pending_activity_for_label(label);
            true
        }
        SyncResult::ConflictsPending => {
            sync.discard_pending_activity_for_label(label);
            // Only emit SYNC_COMPLETED when review mode is NOT active.
            if emitted_sync_started
                && !sync.is_drive_in_review(label)
                && let Err(e) = app.emit(sync_events::SYNC_COMPLETED, sync_events::SyncCompletedPayload::zeros(label))
            {
                warn!(error = %e, "Failed to emit sync_completed");
            }
            true
        }
        SyncResult::NotAvailable => {
            sync.discard_pending_activity_for_label(label);
            warn!(label = %label, "Drive not available or not unlocked, skipping sync");
            false
        }
    }
}

/// Handle a successful sync outcome: record activity, finalize session,
/// register folder, and run post-sync hooks.
async fn handle_sync_success(
    app: &AppHandle,
    app_state: &crate::app_state::AppState,
    sync: &crate::sync_engine::SyncEngine,
    drive_arc: &std::sync::Arc<tokio::sync::Mutex<HcfsDriveManager>>,
    outcome: &SyncOutcome,
    staged_downloads: &[StagedFile],
    label: &str,
) {
    sync.clear_failure_state();
    info!(
        label = %label,
        uploaded = outcome.files_uploaded,
        downloaded = outcome.files_downloaded,
        deleted_local = outcome.files_deleted_locally,
        deleted_remote = outcome.files_deleted_remotely,
        conflicts_resolved = outcome.conflicts_resolved,
        conflicts_skipped = outcome.conflicts_skipped,
        "Sync completed",
    );

    let has_file_changes =
        outcome.files_uploaded > 0 || outcome.files_downloaded > 0 || outcome.files_deleted_locally > 0 || outcome.files_deleted_remotely > 0;

    if has_file_changes {
        resolve_download_activity(sync, drive_arc, label, staged_downloads, outcome.files_downloaded).await;

        if outcome.files_deleted_locally > 0 || outcome.files_deleted_remotely > 0 {
            build_delete_activity(sync, label);
        }

        debug!(label = %label, "Committing pending activity");
        sync.commit_pending_activity_for_label(label);
    } else {
        debug!(label = %label, "Discarding pending activity (no files transferred)");
        sync.discard_pending_activity_for_label(label);
    }

    finalize_session_for_label(
        sync,
        label,
        outcome.files_uploaded as u32,
        outcome.files_downloaded as u32,
        true,
        sync.changes_pending.load(Ordering::Acquire),
    );

    // After uploading files, ensure the folder is registered on the server.
    if crate::sync_logic::should_register_after_upload(outcome.files_uploaded) {
        let maybe_config_and_pool = {
            let m = drive_arc.lock().await;
            m.client_config().cloned().zip(app_state.pool().ok())
        };
        if let Some((config, pool)) = maybe_config_and_pool
            && let Err(e) = ensure_folder_registered(&config, label, pool).await
        {
            warn!(label = %label, error = %e, "Post-upload folder registration failed");
        }
    }

    // Run post-sync hooks (e.g. migration reporting).
    {
        use tauri::Manager;
        let app_state = app.state::<crate::app_state::AppState>();
        match crate::utils::sync::current_account_id(&app_state) {
            Ok(active_account) => {
                let app_clone = app.clone();
                let label_for_hook = label.to_string();
                let sync_clone = app_state.sync.clone();
                tokio::spawn(async move {
                    sync_clone.run_post_sync_hooks(&app_clone, &label_for_hook, &active_account).await;
                });
            }
            Err(e) => {
                warn!(error = %e, "Post-sync hooks skipped: no active account");
            }
        }
    }
}

/// Handle a sync error: attempt folder recovery, apply backoff, and notify
/// the frontend.
async fn handle_sync_error(
    app: &AppHandle,
    app_state: &crate::app_state::AppState,
    sync: &crate::sync_engine::SyncEngine,
    drive_arc: &std::sync::Arc<tokio::sync::Mutex<HcfsDriveManager>>,
    err_str: &str,
    drive_sync_path: &Path,
    label: &str,
) -> bool {
    let failures = sync.record_sync_failure();
    sync.discard_pending_activity_for_label(label);
    error!(label = %label, consecutive_failure = failures, error = %err_str, "Sync failed");

    if try_error_folder_recovery(app, sync, app_state, drive_arc, label, err_str, drive_sync_path).await {
        return true;
    }

    apply_error_backoff_and_notify(app, sync, app_state, label, err_str.to_string(), failures);
    true
}

/// Execute one sync cycle for a specific drive by label.
/// Returns true if sync was executed, false if skipped (e.g., already in progress).
pub async fn trigger_sync_for_drive(app: &AppHandle, label: &str) -> bool {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    if !check_sync_preconditions(app, sync, label) {
        return false;
    }

    sync.begin_sync();
    info!(label = label, "Starting sync cycle");

    let mut emitted_sync_started = false;

    run_presync_folder_check(app, sync, &app_state, label).await;

    // Get the per-drive Arc and a fresh cancel token (microsecond outer lock).
    let (drive_arc, cancel_token) = {
        let mut guard = sync.drives.lock().await;
        if let Some(slot) = guard.get_mut(label) {
            let new_token = CancellationToken::new();
            slot.cancel_token = new_token.clone();
            (slot.manager.clone(), new_token)
        } else {
            warn!(label = label, "Drive not found in registry");
            sync.end_sync();
            sync.update_state(label, |s| s.is_syncing = false);
            return false;
        }
    };

    // Execute the core sync cycle under the per-drive lock.
    let result = run_sync_cycle(app, sync, label, &drive_arc, cancel_token, &mut emitted_sync_started).await;

    // Wait for the OS to flush trailing filesystem events generated by sync.
    tokio::time::sleep(Duration::from_millis(200)).await;
    sync.end_sync();

    // If the drive was removed while syncing, skip post-sync work.
    if !sync.drives.lock().await.contains_key(label) {
        warn!(label = label, "Drive removed during sync, skipping post-sync work");
        sync.discard_pending_activity_for_label(label);
        return false;
    }

    sync.update_state(label, |s| {
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    });

    post_sync_cleanup(sync, &drive_arc, label).await;

    dispatch_sync_result(app, &app_state, sync, &drive_arc, result, emitted_sync_started, label).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_progress::{FileAction, FileStatus, SyncFile, SyncSession};
    use std::collections::HashMap;

    /// Helper: build a `SyncEngine` for tests (no Tauri app needed).
    fn test_engine() -> crate::sync_engine::SyncEngine {
        crate::sync_engine::SyncEngine::new()
    }

    /// Helper: insert a `SyncSession` with specific files into the engine's
    /// progress state.
    fn seed_session(
        engine: &crate::sync_engine::SyncEngine,
        label: &str,
        files: Vec<(&str, FileAction)>,
        is_active: bool,
    ) {
        let mut state = engine.progress.lock().unwrap();
        let mut file_map = HashMap::new();
        for (path, action) in files {
            file_map.insert(
                path.to_string(),
                SyncFile {
                    id: format!("id_{path}"),
                    path: path.to_string(),
                    file_name: path.to_string(),
                    label: label.to_string(),
                    action,
                    status: FileStatus::Pending,
                    progress: 0,
                    bytes_encrypted: 0,
                    bytes_transferred: 0,
                    total_bytes: 100,
                    resumed_from_bytes: None,
                    started_at: 0,
                    completed_at: None,
                    error: None,
                },
            );
        }
        state.current_session = Some(SyncSession {
            session_id: "test-session".to_string(),
            started_at: 0,
            completed_at: None,
            is_active,
            expected_uploads: file_map
                .values()
                .filter(|f| f.action == FileAction::Upload)
                .count() as u32,
            expected_downloads: file_map
                .values()
                .filter(|f| f.action == FileAction::Download)
                .count() as u32,
            expected_local_deletes: file_map
                .values()
                .filter(|f| f.action == FileAction::LocalDelete)
                .count() as u32,
            expected_remote_deletes: file_map
                .values()
                .filter(|f| f.action == FileAction::RemoteDelete)
                .count() as u32,
            files: file_map,
        });
    }

    // ── recover_mutex ───────────────────────────────────────────────

    #[test]
    fn recover_mutex_returns_guard_on_healthy_mutex() {
        let m = std::sync::Mutex::new(42);
        let guard = recover_mutex(&m);
        assert_eq!(*guard, 42);
    }

    #[test]
    fn recover_mutex_recovers_poisoned_mutex() {
        let m = std::sync::Mutex::new(7);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("intentional");
        }));
        assert!(m.lock().is_err(), "mutex should be poisoned");
        let guard = recover_mutex(&m);
        assert_eq!(*guard, 7);
    }

    #[test]
    fn recover_mutex_allows_mutation_after_recovery() {
        let m = std::sync::Mutex::new(0);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("poison");
        }));
        {
            let mut guard = recover_mutex(&m);
            *guard = 99;
        }
        let guard = recover_mutex(&m);
        assert_eq!(*guard, 99);
    }

    // ── build_delete_activity ───────────────────────────────────────

    #[test]
    fn build_delete_activity_creates_entries_for_delete_actions() {
        let engine = test_engine();
        seed_session(
            &engine,
            "docs",
            vec![
                ("file_a.txt", FileAction::LocalDelete),
                ("file_b.txt", FileAction::RemoteDelete),
                ("file_c.txt", FileAction::Upload),
            ],
            true,
        );

        build_delete_activity(&engine, "docs");

        let pending = engine.pending_activity.lock().unwrap();
        assert_eq!(pending.len(), 2, "should have 2 delete items");
        assert!(pending.iter().all(|i| i.action == "deleted"));
        assert!(pending.iter().all(|i| i.label == "docs"));
        let names: Vec<&str> =
            pending.iter().map(|i| i.file_name.as_str()).collect();
        assert!(names.contains(&"file_a.txt"));
        assert!(names.contains(&"file_b.txt"));
    }

    #[test]
    fn build_delete_activity_skips_non_delete_actions() {
        let engine = test_engine();
        seed_session(
            &engine,
            "photos",
            vec![
                ("pic.jpg", FileAction::Upload),
                ("doc.pdf", FileAction::Download),
            ],
            true,
        );

        build_delete_activity(&engine, "photos");

        let pending = engine.pending_activity.lock().unwrap();
        assert!(pending.is_empty());
    }

    #[test]
    fn build_delete_activity_filters_by_label() {
        let engine = test_engine();
        seed_session(
            &engine,
            "work",
            vec![("a.txt", FileAction::LocalDelete)],
            true,
        );

        // Query for a different label — should find nothing.
        build_delete_activity(&engine, "personal");

        let pending = engine.pending_activity.lock().unwrap();
        assert!(pending.is_empty());
    }

    #[test]
    fn build_delete_activity_no_session_does_nothing() {
        let engine = test_engine();
        // No session seeded
        build_delete_activity(&engine, "any");
        let pending = engine.pending_activity.lock().unwrap();
        assert!(pending.is_empty());
    }

    // ── finalize_session_for_label ──────────────────────────────────

    #[test]
    fn finalize_skips_when_session_inactive_and_require_active() {
        let engine = test_engine();
        seed_session(
            &engine,
            "docs",
            vec![("file.txt", FileAction::Upload)],
            false, // inactive
        );

        finalize_session_for_label(&engine, "docs", 1, 0, true, false);

        // Session should remain unchanged (not finalized).
        let state = engine.progress.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        assert!(
            session.completed_at.is_none(),
            "inactive session should not be finalized"
        );
    }

    #[test]
    fn finalize_runs_when_session_active_and_require_active() {
        let engine = test_engine();
        seed_session(
            &engine,
            "docs",
            vec![("file.txt", FileAction::Upload)],
            true, // active
        );

        finalize_session_for_label(&engine, "docs", 1, 0, true, false);

        let state = engine.progress.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        // Session should be marked completed (is_active = false).
        assert!(!session.is_active);
    }

    #[test]
    fn finalize_always_runs_when_require_active_false() {
        let engine = test_engine();
        seed_session(
            &engine,
            "docs",
            vec![("file.txt", FileAction::Upload)],
            false, // inactive
        );

        // require_active_session = false bypasses the active check.
        finalize_session_for_label(&engine, "docs", 1, 0, false, false);

        let state = engine.progress.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        assert!(!session.is_active);
    }

    #[test]
    fn finalize_marks_excess_files_as_failed() {
        let engine = test_engine();
        seed_session(
            &engine,
            "docs",
            vec![
                ("a.txt", FileAction::Upload),
                ("b.txt", FileAction::Upload),
            ],
            true,
        );

        // Only 1 of 2 expected uploads succeeded.
        finalize_session_for_label(&engine, "docs", 1, 0, true, false);

        let state = engine.progress.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        let failed_count = session
            .files
            .values()
            .filter(|f| f.status == FileStatus::Error)
            .count();
        assert_eq!(failed_count, 1, "one file should be marked failed");
    }

    #[test]
    fn finalize_defers_when_changes_pending() {
        let engine = test_engine();
        seed_session(
            &engine,
            "docs",
            vec![("file.txt", FileAction::Upload)],
            true,
        );

        finalize_session_for_label(
            &engine, "docs", 1, 0, true, true, // changes_pending
        );

        let state = engine.progress.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        // Session should still be active because completion was deferred.
        assert!(
            session.is_active,
            "session should remain active when changes are pending"
        );
    }

    #[test]
    fn finalize_completes_all_pending_when_counts_match() {
        let engine = test_engine();
        seed_session(
            &engine,
            "docs",
            vec![
                ("a.txt", FileAction::Upload),
                ("b.txt", FileAction::Download),
            ],
            true,
        );

        finalize_session_for_label(&engine, "docs", 1, 1, true, false);

        let state = engine.progress.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        assert!(!session.is_active);
        // All files for this label should have been processed.
        let still_pending = session
            .files
            .values()
            .filter(|f| f.status == FileStatus::Pending)
            .count();
        assert_eq!(still_pending, 0);
    }
}
