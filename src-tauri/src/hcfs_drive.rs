use crate::sync_shared::{is_cancelled, HCFS_SYNC_STATE};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::drive::Drive;
use hcfs_client::sync::{SyncMode, SyncOutcome, SyncPlan, SyncProgress};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

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
        self.drive.init(password, mnemonic).map_err(|e| e.to_string())
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
            .map_err(|e| e.to_string())
    }

    #[allow(dead_code)]
    pub fn stage(&self) -> Result<SyncPlan, String> {
        self.drive.stage().map_err(|e| e.to_string())
    }

    pub fn cleanup_temp(&self) {
        self.drive.cleanup_stale_temp_files();
    }
}

/// Global Drive instance
pub static HCFS_DRIVE: Lazy<Arc<Mutex<Option<HcfsDriveManager>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

/// Start background sync loop
pub async fn start_sync_loop(app: AppHandle) {
    let sync_path = {
        let guard = HCFS_DRIVE.lock().await;
        guard.as_ref().map(|m| m.sync_path().to_path_buf())
    };

    let Some(sync_path) = sync_path else {
        return;
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(256);

    // File watcher
    let tx_clone = tx.clone();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |_: Result<notify::Event, notify::Error>| {
            let _ = tx_clone.blocking_send(());
        })
        .expect("Failed to create watcher");

    watcher
        .watch(&sync_path, RecursiveMode::Recursive)
        .expect("Failed to watch path");

    tokio::spawn(async move {
        let _watcher = watcher; // keep alive

        // Clean up any stale temp files from previous runs
        {
            let guard = HCFS_DRIVE.lock().await;
            if let Some(manager) = guard.as_ref() {
                manager.cleanup_temp();
            }
        }

        // Initial sync on startup
        trigger_sync(&app).await;

        let mut debounce = tokio::time::interval(Duration::from_secs(5));
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        let mut has_changes = false;

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
                    if has_changes {
                        has_changes = false;
                        trigger_sync(&app).await;
                    }
                }
                _ = heartbeat.tick() => {
                    trigger_sync(&app).await;
                }
            }
        }
    });
}

/// Execute one sync cycle
pub async fn trigger_sync(app: &AppHandle) {
    {
        let mut s = HCFS_SYNC_STATE.lock().unwrap();
        if s.is_syncing {
            return;
        } // already running
        s.is_syncing = true;
    }

    let _ = app.emit("hcfs_sync_started", ());

    let result = {
        let mut guard = HCFS_DRIVE.lock().await;
        match guard.as_mut() {
            Some(m) if m.is_unlocked() => Some(m.sync().await),
            _ => None,
        }
    };

    {
        let mut s = HCFS_SYNC_STATE.lock().unwrap();
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    }

    match result {
        Some(Ok(outcome)) => {
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
        Some(Err(e)) => {
            let _ = app.emit("hcfs_sync_error", serde_json::json!({"error": e}));
        }
        None => {}
    }
}
