//! HCFS Drive wrapper and background sync loop.
//!
//! This module is the heart of the sync engine. It wraps `hcfs_client::Drive`
//! in `HcfsDriveManager`, manages a global drive instance (`HCFS_DRIVE`), and
//! runs a background sync loop with file watching and heartbeat timing.
//!
//! ## Lifecycle
//! 1. `initialize_sync` (in syncing.rs) creates a `HcfsDriveManager` and stores it in `HCFS_DRIVE`
//! 2. `start_sync_loop` spawns a tokio task that watches for file changes and syncs periodically
//! 3. `stop_sync` cancels the loop, aborts the task, and drops the drive
//!
//! ## Key globals
//! - `HCFS_DRIVE` — the active drive instance (None when logged out)
//! - `SYNC_LOOP_HANDLE` — the background task handle (for abort)
//! - `SYNC_IN_PROGRESS` — suppresses file watcher during active sync

use crate::sync_shared::{
    HCFS_SYNC_STATE, commit_pending_activity, discard_pending_activity, is_cancelled,
};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::drive::Drive;
use hcfs_client::sync::{
    SyncConflict, SyncConflictResolution, SyncConflictType, SyncMode, SyncOutcome, SyncProgress,
};
use hcfs_shared::network::SyncStatusResult;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Flag to suppress file watcher events while a sync is in progress,
/// preventing a feedback loop where sync-generated file changes trigger more syncs.
pub(crate) static SYNC_IN_PROGRESS: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

/// Flag to pause auto-sync while the user is reviewing staged changes.
/// When true, `trigger_sync` becomes a no-op so the review dialog has stable data.
pub static SYNC_REVIEW_MODE: AtomicBool = AtomicBool::new(false);

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

/// Server-side sync progress status.
/// This mirrors `SyncStatusResult` from hcfs-shared but is Tauri-serializable.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServerSyncStatus {
    pub active: bool,
    pub progress_percent: f64,
    pub bytes_completed: u64,
    pub bytes_total: u64,
    pub files_completed: u64,
    pub files_active: u64,
    pub files_pending: u64,
    pub files_failed: u64,
    pub started_at: i64,
    pub last_activity_at: i64,
}

impl From<SyncStatusResult> for ServerSyncStatus {
    fn from(r: SyncStatusResult) -> Self {
        Self {
            active: r.active,
            progress_percent: r.progress_percent,
            bytes_completed: r.bytes_completed,
            bytes_total: r.bytes_total,
            files_completed: r.files_completed,
            files_active: r.files_active,
            files_pending: r.files_pending,
            files_failed: r.files_failed,
            started_at: r.started_at,
            last_activity_at: r.last_activity_at,
        }
    }
}

/// Thin wrapper around `hcfs_client::Drive` that adds error mapping to `String`
/// (required for Tauri IPC) and tracks the sync folder path and config directory.
pub struct HcfsDriveManager {
    drive: Drive,
    sync_path: PathBuf,
    config_dir: PathBuf,
}

impl HcfsDriveManager {
    pub fn new(sync_path: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            drive: Drive::with_config_dir(&sync_path, &config_dir),
            sync_path,
            config_dir,
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
    pub fn user_id(&self) -> Option<&str> {
        self.drive.user_id()
    }
    /// Override the user_id to use substrate address instead of derived ed25519 hex.
    /// This is now done via the HcfsClientConfig.account_ss58 field.
    /// Deprecated: set account_ss58 in the config instead.
    pub fn set_user_id(&mut self, _user_id: String) {
        // No-op: user_id is now set via config.account_ss58
        // The Drive will use account_ss58 if set, otherwise derives from mnemonic
    }
    pub fn sync_path(&self) -> &Path {
        &self.sync_path
    }

    pub fn set_config(&mut self, config: HcfsClientConfig) -> Result<(), String> {
        self.drive.set_config(config).map_err(|e| e.to_string())
    }

    pub fn set_progress(&mut self, progress: SyncProgress) {
        self.drive.set_progress_handlers(progress);
    }

    pub async fn sync(&mut self) -> Result<SyncOutcome, String> {
        self.drive
            .sync_async(SyncMode::NonInteractive)
            .await
            .map_err(|e| {
                let mut msg = format!("{e}");
                let mut source = std::error::Error::source(&e);
                while let Some(cause) = source {
                    msg.push_str(&format!(" -> caused by: {cause}"));
                    source = std::error::Error::source(cause);
                }
                msg
            })
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
        let mnemonic = hcfs_client::auth::recover_mnemonic(&enc_path, password)
            .map_err(|e| e.to_string())?;
        Ok(mnemonic.to_string())
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    pub fn cleanup_temp(&self) {
        self.drive.cleanup_stale_temp_files();
    }

    /// Get the current server-side sync progress.
    /// Returns the user_id and the sync status from the server.
    pub async fn get_server_sync_status(&self) -> Result<ServerSyncStatus, String> {
        let user_id = self
            .drive
            .user_id()
            .ok_or("Drive not unlocked")?;
        
        let client = self
            .drive
            .client()
            .ok_or("HCFS client not configured")?;

        let status = client
            .get_sync_status(user_id)
            .await
            .map_err(|e| e.to_string())?;

        let result: ServerSyncStatus = status.into();
        
        // Log server sync status for debugging
        println!(
            "[ServerSync] active={}, progress={}%, files: completed={}, active={}, pending={}, failed={}",
            result.active,
            result.progress_percent,
            result.files_completed,
            result.files_active,
            result.files_pending,
            result.files_failed
        );

        Ok(result)
    }
}

/// Global Drive instance
pub static HCFS_DRIVE: Lazy<Arc<Mutex<Option<HcfsDriveManager>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

/// Handle for the background sync loop task so we can abort it before starting a new one.
pub static SYNC_LOOP_HANDLE: Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

/// Heartbeat interval: sync every 30 seconds regardless of local changes
const HEARTBEAT_SECS: u64 = 30;

/// Debounce interval: wait 5 seconds after local changes before syncing
const DEBOUNCE_SECS: u64 = 5;

/// Start background sync loop
pub async fn start_sync_loop(app: AppHandle) {
    println!("[Sync] Starting sync loop...");

    // Abort the previous sync loop if one is still running
    {
        let mut handle_guard = SYNC_LOOP_HANDLE.lock().await;
        if let Some(prev) = handle_guard.take() {
            println!("[Sync] Aborting previous sync loop task");
            prev.abort();
        }
    }

    let sync_path = {
        let guard = HCFS_DRIVE.lock().await;
        guard.as_ref().map(|m| m.sync_path().to_path_buf())
    };

    let Some(sync_path) = sync_path else {
        println!("[Sync] Drive not available, sync loop not started");
        return;
    };

    println!("[Sync] Watching sync path: {:?}", sync_path);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(256);

    // File watcher — suppressed during active sync to avoid feedback loops
    let tx_clone = tx.clone();
    let sync_flag = SYNC_IN_PROGRESS.clone();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            if sync_flag.load(Ordering::Acquire) {
                return; // Ignore events generated by an ongoing sync
            }
            if let Ok(_event) = res {
                let _ = tx_clone.blocking_send(());
            }
        },
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!(
                "[Sync] Failed to create file watcher: {}. Sync loop will run without file watching.",
                e
            );
            // Fall back to heartbeat-only sync loop without a watcher
            let handle = tokio::spawn(async move {
                // Initial sync on startup
                println!("[Sync] Running initial sync (no file watcher)...");
                trigger_sync(&app).await;

                let mut interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
                loop {
                    interval.tick().await;
                    if is_cancelled() {
                        break;
                    }
                    trigger_sync(&app).await;
                }
                println!("[Sync] Sync loop exited (no file watcher)");
            });
            let mut handle_guard = SYNC_LOOP_HANDLE.lock().await;
            *handle_guard = Some(handle);
            return;
        }
    };

    if let Err(e) = watcher.watch(&sync_path, RecursiveMode::Recursive) {
        eprintln!(
            "[Sync] Failed to watch path {:?}: {}. Continuing with heartbeat-only sync.",
            sync_path, e
        );
    }

    let handle = tokio::spawn(async move {
        let _watcher = watcher; // keep alive

        // Clean up any stale temp files from previous runs
        {
            let guard = HCFS_DRIVE.lock().await;
            if let Some(manager) = guard.as_ref() {
                manager.cleanup_temp();
            }
        }

        // Initial sync on startup
        println!("[Sync] Running initial sync...");
        trigger_sync(&app).await;

        let mut debounce = tokio::time::interval(Duration::from_secs(DEBOUNCE_SECS));
        let mut has_changes = false;
        let mut last_sync = Instant::now();

        loop {
            if is_cancelled() {
                break;
            }

            tokio::select! {
                msg = rx.recv() => {
                    if msg.is_none() { break; }
                    has_changes = true;
                }
                _ = debounce.tick() => {
                    let heartbeat_due = last_sync.elapsed() >= Duration::from_secs(HEARTBEAT_SECS);
                    if has_changes || heartbeat_due {
                        // Only clear has_changes if sync actually ran (not skipped)
                        let sync_ran = trigger_sync(&app).await;
                        if sync_ran {
                            has_changes = false;
                            last_sync = Instant::now();
                        }
                        // If sync was skipped (already in progress), keep has_changes = true
                        // so we retry on next debounce tick
                    }
                }
            }
        }
        println!("[Sync] Sync loop exited");
    });

    // Store the handle so we can abort it later
    {
        let mut handle_guard = SYNC_LOOP_HANDLE.lock().await;
        *handle_guard = Some(handle);
    }
}

/// Execute one sync cycle.
/// Returns true if sync was executed, false if skipped (e.g., already in progress).
pub async fn trigger_sync(app: &AppHandle) -> bool {
    // Atomically check review mode and is_syncing under the same lock
    // to prevent a race where two calls both pass review check then compete on is_syncing.
    {
        let mut s = HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if SYNC_REVIEW_MODE.load(Ordering::Acquire) {
            println!("[Sync] Review mode active, skipping auto-sync");
            return false;
        }
        if s.is_syncing {
            println!("[Sync] Sync already in progress, will retry on next cycle");
            return false;
        }
        s.is_syncing = true;
    }

    // Suppress file watcher events during sync to prevent feedback loops
    SYNC_IN_PROGRESS.store(true, Ordering::Release);

    println!("[Sync] Starting sync cycle...");

    // Track whether we emitted sync_started - only emit sync_completed if we did
    let mut emitted_sync_started = false;

    // Tri-state result: synced, conflicts pending (user must resolve), or not available
    enum SyncResult {
        Synced(Result<SyncOutcome, String>),
        ConflictsPending,
        NoChanges,
        NotAvailable,
    }

    let result = {
        let mut guard = HCFS_DRIVE.lock().await;
        match guard.as_mut() {
            Some(m) if m.is_unlocked() => {
                println!("[Sync] Drive is unlocked, staging changes...");
                match m.stage_with_paths().await {
                    Ok(staged) if staged.conflicts.is_empty() => {
                        // Check if there are any actual changes to sync
                        let has_changes = !staged.uploads.is_empty()
                            || !staged.downloads.is_empty()
                            || !staged.local_deletes.is_empty()
                            || !staged.remote_deletes.is_empty();

                        if !has_changes {
                            println!("[Sync] No changes to sync, skipping");
                            SyncResult::NoChanges
                        } else {
                            println!(
                                "[Sync] Changes detected — syncing (uploads={}, downloads={}, local_deletes={}, remote_deletes={})",
                                staged.uploads.len(),
                                staged.downloads.len(),
                                staged.local_deletes.len(),
                                staged.remote_deletes.len(),
                            );
                            // Emit sync_started with file details so frontend can show accurate progress
                            // Include full file list for all operations
                            let _ = app.emit("hcfs_sync_started", serde_json::json!({
                                "uploads": staged.uploads.len(),
                                "downloads": staged.downloads.len(),
                                "local_deletes": staged.local_deletes.len(),
                                "remote_deletes": staged.remote_deletes.len(),
                                "upload_files": staged.uploads.iter().map(|f| &f.path).collect::<Vec<_>>(),
                                "download_files": staged.downloads.iter().map(|f| &f.path).collect::<Vec<_>>(),
                                "local_delete_files": staged.local_deletes.iter().map(|f| &f.path).collect::<Vec<_>>(),
                                "remote_delete_files": staged.remote_deletes.iter().map(|f| &f.path).collect::<Vec<_>>(),
                            }));
                            emitted_sync_started = true;

                            // Use sync_with_resolutions so unexpected conflicts default
                            // to Skip (not AcceptRemote which re-downloads deleted files).
                            let outcome = m.sync_with_resolutions(HashMap::new()).await;

                            // The sync fetches fresh remote state and may discover conflicts
                            // that our stale-cached stage() missed (TOCTOU gap). If any
                            // were skipped, emit sync_completed for the auto-sync part first,
                            // then re-stage (state is now updated from save_sync_state) and
                            // enter review mode. This ordering ensures:
                            //   sync_started → sync_completed → conflicts_pending
                            // so useSyncEvents clears isSyncing before the banner appears.
                            match &outcome {
                                Ok(o) if o.conflicts_skipped > 0 => {
                                    println!(
                                        "[Sync] {} conflict(s) skipped during auto-sync, re-staging for review",
                                        o.conflicts_skipped
                                    );

                                    // Emit sync_completed for the auto-sync that just finished
                                    let _ = app.emit(
                                        "hcfs_sync_completed",
                                        serde_json::json!({
                                            "files_uploaded": o.files_uploaded,
                                            "files_downloaded": o.files_downloaded,
                                            "files_deleted_locally": o.files_deleted_locally,
                                            "files_deleted_remotely": o.files_deleted_remotely,
                                            "conflicts_resolved": o.conflicts_resolved,
                                            "conflicts_skipped": o.conflicts_skipped,
                                        }),
                                    );

                                    match m.stage_with_paths().await {
                                        Ok(restaged) if !restaged.conflicts.is_empty() => {
                                            SYNC_REVIEW_MODE.store(true, Ordering::Release);
                                            let _ = app.emit("hcfs_conflicts_pending", &restaged);
                                            SyncResult::ConflictsPending
                                        }
                                        _ => SyncResult::ConflictsPending, // sync_completed already emitted
                                    }
                                }
                                _ => SyncResult::Synced(outcome),
                            }
                        }
                    }
                    Ok(staged) => {
                        // Conflicts detected from staging — emit sync_started since user needs to resolve
                        println!(
                            "[Sync] {} conflict(s) detected, entering review mode",
                            staged.conflicts.len()
                        );
                        let _ = app.emit("hcfs_sync_started", serde_json::json!({
                            "uploads": staged.uploads.len(),
                            "downloads": staged.downloads.len(),
                            "local_deletes": staged.local_deletes.len(),
                            "remote_deletes": staged.remote_deletes.len(),
                            "upload_files": staged.uploads.iter().map(|f| &f.path).collect::<Vec<_>>(),
                            "download_files": staged.downloads.iter().map(|f| &f.path).collect::<Vec<_>>(),
                            "local_delete_files": staged.local_deletes.iter().map(|f| &f.path).collect::<Vec<_>>(),
                            "remote_delete_files": staged.remote_deletes.iter().map(|f| &f.path).collect::<Vec<_>>(),
                        }));
                        emitted_sync_started = true;
                        SYNC_REVIEW_MODE.store(true, Ordering::Release);
                        let _ = app.emit("hcfs_conflicts_pending", &staged);
                        SyncResult::ConflictsPending
                    }
                    Err(e) => {
                        println!("[Sync] Staging failed: {}", e);
                        // Don't emit sync_started for staging errors - nothing to show
                        SyncResult::Synced(Err(e))
                    }
                }
            }
            Some(_) => {
                println!("[Sync] Drive exists but is not unlocked");
                SyncResult::NotAvailable
            }
            None => {
                println!("[Sync] Drive not available (None)");
                SyncResult::NotAvailable
            }
        }
    };

    // Re-enable file watcher after a short delay to ignore trailing FS events
    let flag = SYNC_IN_PROGRESS.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        flag.store(false, Ordering::Release);
    });

    {
        let mut s = HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    }

    match result {
        SyncResult::Synced(Ok(outcome)) => {
            println!(
                "[Sync] Sync completed: uploaded={}, downloaded={}, deleted_local={}, deleted_remote={}, conflicts_resolved={}, conflicts_skipped={}",
                outcome.files_uploaded,
                outcome.files_downloaded,
                outcome.files_deleted_locally,
                outcome.files_deleted_remotely,
                outcome.conflicts_resolved,
                outcome.conflicts_skipped,
            );

            // Commit pending activity only if the sync actually transferred files.
            // Progress callbacks buffer items when bytes are sent/received, but the
            // server may reject them (e.g. 502). The outcome counts reflect reality.
            if outcome.files_uploaded > 0 || outcome.files_downloaded > 0 {
                println!("[Sync] Committing pending activity (files transferred)");
                commit_pending_activity();
            } else {
                println!("[Sync] Discarding pending activity (no files transferred)");
                discard_pending_activity();
            }

            // Only emit sync_completed if we emitted sync_started
            if emitted_sync_started {
                let _ = app.emit(
                    "hcfs_sync_completed",
                    serde_json::json!({
                        "files_uploaded": outcome.files_uploaded,
                        "files_downloaded": outcome.files_downloaded,
                        "files_deleted_locally": outcome.files_deleted_locally,
                        "files_deleted_remotely": outcome.files_deleted_remotely,
                        "conflicts_resolved": outcome.conflicts_resolved,
                        "conflicts_skipped": outcome.conflicts_skipped,
                    }),
                );
            }
        }
        SyncResult::Synced(Err(e)) => {
            discard_pending_activity();
            println!("[Sync] Sync failed with error: {}", e);
            // Only emit error if we emitted sync_started
            if emitted_sync_started {
                let _ = app.emit("hcfs_sync_error", serde_json::json!({"error": e}));
            }
        }
        SyncResult::NoChanges => {
            // No changes detected - don't emit any events, UI stays unchanged
            discard_pending_activity();
        }
        SyncResult::ConflictsPending => {
            // Conflicts event already emitted above.
            // Emit sync_completed with zeros so frontend knows the sync phase finished
            // and is now waiting for user to resolve conflicts.
            // SYNC_REVIEW_MODE is set, so subsequent heartbeats will skip.
            discard_pending_activity();
            if emitted_sync_started {
                let _ = app.emit(
                    "hcfs_sync_completed",
                    serde_json::json!({
                        "files_uploaded": 0,
                        "files_downloaded": 0,
                        "files_deleted_locally": 0,
                        "files_deleted_remotely": 0,
                        "conflicts_resolved": 0,
                        "conflicts_skipped": 0,
                    }),
                );
            }
        }
        SyncResult::NotAvailable => {
            discard_pending_activity();
            println!("[Sync] Drive not available or not unlocked, skipping sync");
            // Don't emit error for unavailable drive - it's expected during startup
        }
    }
    
    // Sync was executed (even if there were no changes)
    true}