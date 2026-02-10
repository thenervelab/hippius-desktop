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
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::Serialize;
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

/// Thin wrapper around `hcfs_client::Drive` that adds error mapping to `String`
/// (required for Tauri IPC) and tracks the sync folder path.
pub struct HcfsDriveManager {
    drive: Drive,
    sync_path: PathBuf,
}

impl HcfsDriveManager {
    pub fn new(sync_path: PathBuf) -> Self {
        Self {
            drive: Drive::new(&sync_path),
            sync_path,
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
    /// Fetches fresh remote state from the server so the plan accurately reflects
    /// what would actually happen during a sync.
    ///
    /// Note: `drive.stage()` internally calls `load_sync_state()` + `scan_local_files()`
    /// + `fetch_remote_state()` but does not expose the resulting `SyncState`. We must
    /// load it again to access `path_index` for FileId → path resolution.
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
        let enc_path = self.sync_path.join(".hippius").join("enc_mnemonic.json");
        let mnemonic = hcfs_client::auth::recover_mnemonic(&enc_path, password)
            .map_err(|e| e.to_string())?;
        Ok(mnemonic.to_string())
    }

    pub fn cleanup_temp(&self) {
        self.drive.cleanup_stale_temp_files();
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
                        has_changes = false;
                        trigger_sync(&app).await;
                        last_sync = Instant::now();
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

/// Execute one sync cycle
pub async fn trigger_sync(app: &AppHandle) {
    // Atomically check review mode and is_syncing under the same lock
    // to prevent a race where two calls both pass review check then compete on is_syncing.
    {
        let mut s = HCFS_SYNC_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if SYNC_REVIEW_MODE.load(Ordering::Acquire) {
            println!("[Sync] Review mode active, skipping auto-sync");
            return;
        }
        if s.is_syncing {
            println!("[Sync] Sync already in progress, skipping");
            return;
        }
        s.is_syncing = true;
    }

    // Suppress file watcher events during sync to prevent feedback loops
    SYNC_IN_PROGRESS.store(true, Ordering::Release);

    println!("[Sync] Starting sync cycle...");
    let _ = app.emit("hcfs_sync_started", ());

    // Tri-state result: synced, conflicts pending (user must resolve), or not available
    enum SyncResult {
        Synced(Result<SyncOutcome, String>),
        ConflictsPending,
        NotAvailable,
    }

    let result = {
        let mut guard = HCFS_DRIVE.lock().await;
        match guard.as_mut() {
            Some(m) if m.is_unlocked() => {
                println!("[Sync] Drive is unlocked, staging changes...");
                match m.stage_with_paths().await {
                    Ok(staged) if staged.conflicts.is_empty() => {
                        println!(
                            "[Sync] No conflicts — auto-syncing (uploads={}, downloads={}, local_deletes={}, remote_deletes={})",
                            staged.uploads.len(),
                            staged.downloads.len(),
                            staged.local_deletes.len(),
                            staged.remote_deletes.len(),
                        );
                        // Use sync_with_resolutions (not sync) so any unexpected
                        // conflicts default to Skip rather than the NonInteractive
                        // default of AcceptRemote which re-downloads deleted files.
                        SyncResult::Synced(m.sync_with_resolutions(HashMap::new()).await)
                    }
                    Ok(staged) => {
                        println!(
                            "[Sync] {} conflict(s) detected, entering review mode",
                            staged.conflicts.len()
                        );
                        SYNC_REVIEW_MODE.store(true, Ordering::Release);
                        let _ = app.emit("hcfs_conflicts_pending", &staged);
                        SyncResult::ConflictsPending
                    }
                    Err(e) => {
                        println!("[Sync] Staging failed: {}", e);
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
                commit_pending_activity();
            } else {
                discard_pending_activity();
            }

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
        SyncResult::Synced(Err(e)) => {
            discard_pending_activity();
            println!("[Sync] Sync failed with error: {}", e);
            let _ = app.emit("hcfs_sync_error", serde_json::json!({"error": e}));
        }
        SyncResult::ConflictsPending => {
            // Conflicts event already emitted above — nothing more to do.
            // SYNC_REVIEW_MODE is set, so subsequent heartbeats will skip.
            discard_pending_activity();
        }
        SyncResult::NotAvailable => {
            discard_pending_activity();
            println!("[Sync] Drive not available or not unlocked, skipping sync");
            let _ = app.emit(
                "hcfs_sync_error",
                serde_json::json!({"error": "Drive not initialized or not unlocked"}),
            );
        }
    }
}
