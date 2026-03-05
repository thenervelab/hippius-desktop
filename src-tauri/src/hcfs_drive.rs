//! HCFS Drive wrapper and background sync loop.
//!
//! This module is the heart of the sync engine. It wraps `hcfs_client::Drive`
//! in `HcfsDriveManager`, manages a drive registry (`HCFS_DRIVES`) keyed by
//! label, and runs a background sync loop with file watching and heartbeat
//! timing in a sequential round-robin fashion.
//!
//! ## Lifecycle
//! 1. `initialize_sync` (in syncing.rs) creates a `HcfsDriveManager` and stores it in `HCFS_DRIVES`
//! 2. `start_sync_loop` spawns a tokio task that watches for file changes and syncs periodically
//! 3. `stop_sync` cancels the loop, aborts the task, and drops all drives
//!
//! ## Key globals
//! - `HCFS_DRIVES` — the active drive instances, keyed by label (empty when logged out)
//! - `SYNC_LOOP_HANDLE` — the background task handle (for abort)
//! - `SYNC_IN_PROGRESS` — suppresses file watcher during active sync

use crate::sync_shared::{
    SyncActivityItem, add_pending_activity, commit_pending_activity_for_label,
    discard_pending_activity_for_label, is_cancelled, update_state,
};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::drive::Drive;
use hcfs_client::sync::{
    SyncConflict, SyncConflictResolution, SyncConflictType, SyncMode, SyncOutcome, SyncProgress,
};
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
        let mnemonic =
            hcfs_client::auth::recover_mnemonic(&enc_path, password).map_err(|e| e.to_string())?;
        Ok(mnemonic.to_string())
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    pub fn cleanup_temp(&self) {
        self.drive.cleanup_stale_temp_files();
    }

    /// Build a path_index from the current sync state + local scan,
    /// mapping encrypted on-disk name prefixes to real file names.
    ///
    /// Stores both the truncated prefix (first 8 bytes hex = 16 chars,
    /// matching `file_<16hex>`) and the full file_id hex. This way
    /// lookups succeed regardless of how much of the ID is available,
    /// and full-ID entries prevent collisions when two files share the
    /// same 8-byte prefix.
    pub fn build_path_index(
        &self,
    ) -> Result<HashMap<String, String>, String> {
        let mut state = self
            .drive
            .load_sync_state()
            .map_err(|e| e.to_string())?;
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

/// Drive registry: maps label → HcfsDriveManager
pub static HCFS_DRIVES: Lazy<Arc<Mutex<HashMap<String, HcfsDriveManager>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Handle for the background sync loop task so we can abort it before starting a new one.
pub static SYNC_LOOP_HANDLE: Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

/// Heartbeat interval: sync every 30 seconds regardless of local changes
const HEARTBEAT_SECS: u64 = 30;

/// Debounce interval: wait 5 seconds after local changes before syncing
const DEBOUNCE_SECS: u64 = 5;

/// Start background sync loop that iterates through all registered drives.
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

    // Collect all sync paths from registered drives
    let drive_paths: Vec<(String, PathBuf)> = {
        let guard = HCFS_DRIVES.lock().await;
        guard
            .iter()
            .map(|(label, m)| (label.clone(), m.sync_path().to_path_buf()))
            .collect()
    };

    if drive_paths.is_empty() {
        println!("[Sync] No drives registered, sync loop not started");
        return;
    }

    for (label, path) in &drive_paths {
        println!("[Sync] Watching drive '{}' at: {:?}", label, path);
    }

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

    // Watch all drive paths
    for (label, path) in &drive_paths {
        if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
            eprintln!(
                "[Sync] Failed to watch path {:?} for drive '{}': {}. Continuing with heartbeat-only sync.",
                path, label, e
            );
        }
    }

    let handle = tokio::spawn(async move {
        let _watcher = watcher; // keep alive

        // Clean up any stale temp files from previous runs
        {
            let guard = HCFS_DRIVES.lock().await;
            for manager in guard.values() {
                manager.cleanup_temp();
            }
        }

        // Initial sync on startup — sync all drives
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

                            // Drain any watcher events that arrived during sync.
                            // Sync writes internal files (sync_state.json, etc.)
                            // which trigger the watcher after SYNC_IN_PROGRESS
                            // is cleared. Without this drain, the next debounce
                            // tick would run a pointless "No changes" cycle.
                            while rx.try_recv().is_ok() {}
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

/// Execute one sync cycle for ALL registered drives in round-robin.
/// Returns true if sync was executed, false if skipped.
pub async fn trigger_sync(app: &AppHandle) -> bool {
    let labels: Vec<String> = {
        let guard = HCFS_DRIVES.lock().await;
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
    // Atomically check review mode and is_syncing under the same state update
    {
        let states = crate::sync_shared::HCFS_SYNC_STATES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if SYNC_REVIEW_MODE.load(Ordering::Acquire) {
            println!(
                "[Sync] Review mode active, skipping auto-sync for '{}'",
                label
            );
            return false;
        }
        if let Some(state) = states.get(label) {
            if state.is_syncing {
                println!(
                    "[Sync] Sync already in progress for '{}', will retry on next cycle",
                    label
                );
                return false;
            }
        }
    }

    // Mark as syncing
    update_state(label, |s| {
        s.is_syncing = true;
    });

    // Suppress file watcher events during sync to prevent feedback loops
    SYNC_IN_PROGRESS.store(true, Ordering::Release);

    println!("[Sync] Starting sync cycle for drive '{}'...", label);

    // Track whether we emitted sync_started - only emit sync_completed if we did
    let mut emitted_sync_started = false;

    // Tri-state result: synced, conflicts pending (user must resolve), or not available.
    // Carries staged file lists so we can record activity with real file names
    // (the download progress callback only sees encrypted names).
    enum SyncResult {
        Synced {
            outcome: Result<SyncOutcome, String>,
            staged_downloads: Vec<StagedFile>,
            staged_uploads: Vec<StagedFile>,
        },
        ConflictsPending,
        NoChanges,
        NotAvailable,
    }

    let result = {
        let mut guard = HCFS_DRIVES.lock().await;
        match guard.get_mut(label) {
            Some(m) if m.is_unlocked() => {
                println!("[Sync] Drive '{}' is unlocked, staging changes...", label);
                match m.stage_with_paths().await {
                    Ok(staged) if staged.conflicts.is_empty() => {
                        // Check if there are any actual changes to sync
                        let has_changes = !staged.uploads.is_empty()
                            || !staged.downloads.is_empty()
                            || !staged.local_deletes.is_empty()
                            || !staged.remote_deletes.is_empty();

                        if !has_changes {
                            // Stage uses cached remote state — always run
                            // the real sync so it can fetch fresh remote
                            // data and discover files uploaded by other
                            // devices.
                            println!(
                                "[Sync] No staged changes for '{}', running sync to check remote",
                                label
                            );
                            let empty: Vec<String> = Vec::new();
                            let _ = app.emit("hcfs_sync_started", serde_json::json!({
                                "label": label,
                                "uploads": 0, "downloads": 0,
                                "local_deletes": 0, "remote_deletes": 0,
                                "upload_files": empty,
                                "download_files": empty,
                                "local_delete_files": empty,
                                "remote_delete_files": empty,
                            }));
                            emitted_sync_started = true;

                            let outcome = m.sync_with_resolutions(HashMap::new()).await;
                            SyncResult::Synced {
                                outcome,
                                staged_downloads: Vec::new(),
                                staged_uploads: Vec::new(),
                            }
                        } else {
                            println!(
                                "[Sync] Changes detected for '{}' — syncing (uploads={}, downloads={}, local_deletes={}, remote_deletes={})",
                                label,
                                staged.uploads.len(),
                                staged.downloads.len(),
                                staged.local_deletes.len(),
                                staged.remote_deletes.len(),
                            );
                            let _ = app.emit("hcfs_sync_started", serde_json::json!({
                                "label": label,
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

                            let outcome = m.sync_with_resolutions(HashMap::new()).await;

                            match &outcome {
                                Ok(o) if o.conflicts_skipped > 0 => {
                                    println!(
                                        "[Sync] {} conflict(s) skipped during auto-sync for '{}', re-staging for review",
                                        o.conflicts_skipped, label
                                    );

                                    let _ = app.emit(
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
                                    );

                                    match m.stage_with_paths().await {
                                        Ok(restaged) if !restaged.conflicts.is_empty() => {
                                            SYNC_REVIEW_MODE.store(true, Ordering::Release);
                                            let _ = app.emit(
                                                "hcfs_conflicts_pending",
                                                serde_json::json!({
                                                    "label": label,
                                                    "staged": restaged,
                                                }),
                                            );
                                            SyncResult::ConflictsPending
                                        }
                                        _ => SyncResult::ConflictsPending,
                                    }
                                }
                                _ => SyncResult::Synced {
                                    outcome,
                                    staged_downloads: staged.downloads,
                                    staged_uploads: staged.uploads,
                                },
                            }
                        }
                    }
                    Ok(staged) => {
                        println!(
                            "[Sync] {} conflict(s) detected for '{}', entering review mode",
                            staged.conflicts.len(),
                            label
                        );
                        let _ = app.emit("hcfs_sync_started", serde_json::json!({
                            "label": label,
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
                        let _ = app.emit(
                            "hcfs_conflicts_pending",
                            serde_json::json!({
                                "label": label,
                                "staged": staged,
                            }),
                        );
                        SyncResult::ConflictsPending
                    }
                    Err(e) => {
                        println!("[Sync] Staging failed for '{}': {}", label, e);
                        SyncResult::Synced {
                            outcome: Err(e),
                            staged_downloads: Vec::new(),
                            staged_uploads: Vec::new(),
                        }
                    }
                }
            }
            Some(_) => {
                println!("[Sync] Drive '{}' exists but is not unlocked", label);
                SyncResult::NotAvailable
            }
            None => {
                println!("[Sync] Drive '{}' not found in registry", label);
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

    update_state(label, |s| {
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    });

    let label_owned = label.to_string();
    match result {
        SyncResult::Synced {
            outcome: Ok(outcome),
            staged_downloads,
            staged_uploads,
        } => {
            println!(
                "[Sync] Sync completed for '{}': uploaded={}, downloaded={}, deleted_local={}, deleted_remote={}, conflicts_resolved={}, conflicts_skipped={}",
                label_owned,
                outcome.files_uploaded,
                outcome.files_downloaded,
                outcome.files_deleted_locally,
                outcome.files_deleted_remotely,
                outcome.conflicts_resolved,
                outcome.conflicts_skipped,
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
                        {
                            let mut pending = crate::sync_shared::PENDING_ACTIVITY
                                .lock()
                                .unwrap_or_else(|p| p.into_inner());
                            pending.retain(|item| {
                                !(item.label == label_owned
                                    && item.action == "downloaded")
                            });
                        }
                        for f in &staged_downloads {
                            let file_name = std::path::Path::new(&f.path)
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_else(|| f.path.clone());
                            add_pending_activity(SyncActivityItem {
                                file_name,
                                action: "downloaded".to_string(),
                                timestamp: now,
                                size_bytes: 0,
                                label: label_owned.clone(),
                            });
                        }
                    } else if outcome.files_downloaded > 0 {
                        // Staging missed these downloads (stale remote cache).
                        // Resolve encrypted names via the path_index.
                        let path_index = {
                            let guard = HCFS_DRIVES.lock().await;
                            guard
                                .get(&label_owned)
                                .and_then(|m| m.build_path_index().ok())
                        };

                        let mut pending = crate::sync_shared::PENDING_ACTIVITY
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        for item in pending.iter_mut() {
                            if item.label == label_owned
                                && item.action == "downloaded"
                                && item.file_name.starts_with("file_")
                            {
                                let hash_prefix =
                                    item.file_name.trim_start_matches("file_");
                                let resolved = path_index
                                    .as_ref()
                                    .and_then(|idx| idx.get(hash_prefix).cloned());
                                match resolved {
                                    Some(real_name) => {
                                        println!(
                                            "[Sync] Resolved download name: {} -> {}",
                                            item.file_name, real_name
                                        );
                                        item.file_name = real_name;
                                    }
                                    None => {
                                        println!(
                                            "[Sync] Could not resolve encrypted name: {}",
                                            item.file_name
                                        );
                                        item.file_name = "synced file".to_string();
                                    }
                                }
                            }
                        }
                    }
                }

                println!("[Sync] Committing pending activity for '{}'", label_owned);
                commit_pending_activity_for_label(&label_owned);
            } else {
                println!(
                    "[Sync] Discarding pending activity for '{}' (no files transferred)",
                    label_owned
                );
                discard_pending_activity_for_label(&label_owned);
            }

            if emitted_sync_started {
                let _ = app.emit(
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
                );
            }
        }
        SyncResult::Synced {
            outcome: Err(e), ..
        } => {
            discard_pending_activity_for_label(&label_owned);
            println!("[Sync] Sync failed for '{}' with error: {}", label_owned, e);
            if emitted_sync_started {
                let _ = app.emit(
                    "hcfs_sync_error",
                    serde_json::json!({"label": label_owned, "error": e}),
                );
            }
        }
        SyncResult::NoChanges => {
            discard_pending_activity_for_label(&label_owned);
        }
        SyncResult::ConflictsPending => {
            discard_pending_activity_for_label(&label_owned);
            if emitted_sync_started {
                let _ = app.emit(
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
                );
            }
        }
        SyncResult::NotAvailable => {
            discard_pending_activity_for_label(&label_owned);
            println!(
                "[Sync] Drive '{}' not available or not unlocked, skipping sync",
                label_owned
            );
            return false;
        }
    }

    true
}
