//! Consolidated sync engine state.
//!
//! Lives as `AppState.sync: Arc<SyncEngine>` (see `app_state.rs`). Tauri
//! commands access it via `state.sync`, background tasks via
//! `app.state::<AppState>().sync.clone()`, and sync callbacks capture the
//! `Arc<SyncEngine>` at setup time.
//!
//! All fields use interior mutability so `&SyncEngine` suffices everywhere:
//! - `AtomicBool` / `AtomicI64` for simple flags and counters
//! - `std::sync::Mutex` for complex types accessed from sync callbacks
//! - `tokio::sync::Mutex` for drive registry (async-only access)

use crate::hcfs_drive::HcfsDriveManager;
use crate::sync_progress::SyncProgressState;
use crate::sync_shared::{HcfsSyncState, SyncActivityItem, SyncEngineHealth};

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

/// Per-drive state stored in the drives registry.
///
/// The `manager` is behind its own `TokioMutex` so syncing one drive does not
/// block access to other drives. The `cancel_token` is replaced at the start
/// of each sync cycle; calling `.cancel()` on it aborts the in-progress sync
/// for this drive without touching the drives map lock.
pub struct DriveSlot {
    pub manager: Arc<TokioMutex<HcfsDriveManager>>,
    pub cancel_token: CancellationToken,
}

/// Maximum number of recent activity items to keep per drive.
const MAX_ACTIVITY: usize = 100;

/// RAII guard that sets `token_refreshing` to true on creation and false on drop.
/// Holds an `Arc<SyncEngine>` so it works without global state.
pub struct TokenRefreshGuard {
    sync: std::sync::Arc<SyncEngine>,
}

impl TokenRefreshGuard {
    pub fn new(sync: std::sync::Arc<SyncEngine>) -> Self {
        sync.set_token_refreshing(true);
        Self { sync }
    }
}

impl Drop for TokenRefreshGuard {
    fn drop(&mut self) {
        self.sync.set_token_refreshing(false);
    }
}

/// RAII guard that enters review mode for a specific drive on creation.
/// On drop, exits review mode — unless `commit()` was called (meaning
/// the review was successfully entered and should stay active).
pub struct ReviewModeGuard {
    sync: Arc<SyncEngine>,
    label: String,
    committed: bool,
}

impl ReviewModeGuard {
    pub fn new(sync: Arc<SyncEngine>, label: String) -> Self {
        sync.set_drive_review(&label);
        Self {
            sync,
            label,
            committed: false,
        }
    }

    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for ReviewModeGuard {
    fn drop(&mut self) {
        if !self.committed {
            self.sync.clear_drive_review(&self.label);
        }
    }
}

// Manual Debug impl because several fields (Mutex internals, JoinHandle, AppHandle)
// don't implement Debug. We only need the derive for Tauri's `manage()`.
impl std::fmt::Debug for SyncEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncEngine").finish_non_exhaustive()
    }
}

pub struct SyncEngine {
    // ── Drive Registry (async-only access) ──────────────────────────────
    pub drives: TokioMutex<HashMap<String, DriveSlot>>,
    pub loop_handle: TokioMutex<Option<JoinHandle<()>>>,

    // ── Atomic Flags (lock-free, any context) ───────────────────────────
    pub cancel_token: AtomicBool,
    /// Counter of drives currently syncing. File watcher suppresses events
    /// when > 0. Replaces the old `AtomicBool` to support concurrent syncs.
    pub syncs_in_progress: AtomicU32,
    pub changes_pending: AtomicBool,
    pub token_refreshing: AtomicBool,
    pub consecutive_failures: AtomicI64,
    pub emit_scheduled: AtomicBool,
    /// Epoch timestamp of the last progress callback. Used by stall detection
    /// to abort syncs that stop making forward progress (e.g. hung upload).
    pub last_progress_time: AtomicI64,
    /// Epoch-second timestamp when the next retry will be attempted after a failure.
    /// 0 means no retry is scheduled.
    pub retry_at: AtomicI64,
    /// Last sync error message (cleared on success).
    pub last_error: StdMutex<Option<String>>,

    // ── Blocking Mutex State (sync-callback safe) ───────────────────────
    pub states: StdMutex<HashMap<String, HcfsSyncState>>,
    pub pending_activity: StdMutex<Vec<SyncActivityItem>>,
    pub health: StdMutex<SyncEngineHealth>,
    pub progress: StdMutex<SyncProgressState>,
    pub app_handle: StdMutex<Option<AppHandle>>,
    pub last_emit_time: StdMutex<Instant>,
    pub session_counter: AtomicU64,

    // ── Synced Paths Cache (fallback when drives lock unavailable) ────
    pub synced_paths_cache: StdMutex<HashMap<String, HashMap<String, crate::sync_shared::SyncedFileInfo>>>,

    // ── File Watcher (shared so new drives can be added dynamically) ──
    pub watcher: StdMutex<Option<notify::RecommendedWatcher>>,

    /// Rename hints captured by the file watcher.
    /// Drained per-drive at the start of each sync cycle.
    pub rename_hints: StdMutex<Vec<crate::sync_logic::RenameHint>>,

    /// Maps drive label → sync folder root path.
    /// Populated when drives are registered, used by
    /// `apply_rename_to_activity` to convert absolute paths to relative.
    pub label_roots: StdMutex<HashMap<String, std::path::PathBuf>>,
}

impl SyncEngine {
    pub fn new() -> Self {
        Self {
            drives: TokioMutex::new(HashMap::new()),
            loop_handle: TokioMutex::new(None),
            cancel_token: AtomicBool::new(false),
            syncs_in_progress: AtomicU32::new(0),
            changes_pending: AtomicBool::new(false),
            token_refreshing: AtomicBool::new(false),
            consecutive_failures: AtomicI64::new(0),
            emit_scheduled: AtomicBool::new(false),
            last_progress_time: AtomicI64::new(0),
            retry_at: AtomicI64::new(0),
            last_error: StdMutex::new(None),
            states: StdMutex::new(HashMap::new()),
            pending_activity: StdMutex::new(Vec::new()),
            health: StdMutex::new(SyncEngineHealth::default()),
            progress: StdMutex::new(SyncProgressState {
                current_session: None,
                recent_files: Vec::new(),
                last_updated: crate::sync_progress::now_ms(),
            }),
            app_handle: StdMutex::new(None),
            last_emit_time: StdMutex::new(Instant::now()),
            session_counter: AtomicU64::new(0),
            synced_paths_cache: StdMutex::new(HashMap::new()),
            watcher: StdMutex::new(None),
            rename_hints: StdMutex::new(Vec::new()),
            label_roots: StdMutex::new(HashMap::new()),
        }
    }

    // ── Cancellation ────────────────────────────────────────────────────

    pub fn request_cancel(&self) {
        self.cancel_token.store(true, Ordering::SeqCst);
    }

    pub fn clear_cancel(&self) {
        self.cancel_token.store(false, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel_token.load(Ordering::SeqCst)
    }

    // ── Sync-In-Progress Counter ────────────────────────────────────────

    /// Increment when a drive starts syncing.
    pub fn begin_sync(&self) {
        self.syncs_in_progress.fetch_add(1, Ordering::Release);
    }

    /// Decrement when a drive finishes syncing.
    pub fn end_sync(&self) {
        self.syncs_in_progress.fetch_sub(1, Ordering::Release);
    }

    /// True when at least one drive is actively syncing.
    pub fn is_any_sync_in_progress(&self) -> bool {
        self.syncs_in_progress.load(Ordering::Acquire) > 0
    }

    /// True when OTHER drives (besides the caller) are still syncing.
    /// Used to defer session completion until the last drive finishes,
    /// preventing the sync widget from disappearing prematurely.
    pub fn other_syncs_in_progress(&self) -> bool {
        self.syncs_in_progress.load(Ordering::Acquire) > 1
    }

    /// Reset counter to zero (used during full stop).
    pub fn reset_sync_counter(&self) {
        self.syncs_in_progress.store(0, Ordering::Release);
    }

    // ── Stall Detection ────────────────────────────────────────────────

    /// Record that forward progress was just made (called from every
    /// progress callback).
    pub fn touch_progress_time(&self) {
        self.last_progress_time.store(chrono::Utc::now().timestamp(), Ordering::Release);
    }

    /// Reset the progress clock at the start of a sync cycle.
    pub fn reset_progress_time(&self) {
        self.last_progress_time.store(chrono::Utc::now().timestamp(), Ordering::Release);
    }

    /// Returns `true` when no progress callback has fired for 3 minutes,
    /// indicating the sync is probably hung.
    pub fn is_progress_stalled(&self) -> bool {
        let last = self.last_progress_time.load(Ordering::Acquire);
        if last == 0 {
            return false;
        }
        (chrono::Utc::now().timestamp() - last) > 180
    }

    // ── Review Mode (per-drive) ────────────────────────────────────────

    /// Enter review mode for a specific drive (only if not in cooldown).
    /// Returns true if review mode was entered, false if cooldown is active.
    pub fn set_drive_review(&self, label: &str) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        let mut states = self.states.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let s = states.entry(label.to_string()).or_default();
        if s.review_cooldown_until > now {
            return false;
        }
        s.in_review = true;
        s.review_entered_at = now;
        true
    }

    /// Check if a specific drive is in review mode.
    pub fn is_drive_in_review(&self, label: &str) -> bool {
        let states = self.states.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        states.get(label).is_some_and(|s| s.in_review)
    }

    /// Exit review mode for a specific drive and start a 60-second cooldown
    /// that prevents the same conflict from immediately re-triggering the banner.
    pub fn clear_drive_review(&self, label: &str) {
        let cooldown_ms = 60_000; // 60 seconds
        let now = chrono::Utc::now().timestamp_millis();
        let mut states = self.states.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(s) = states.get_mut(label) {
            s.in_review = false;
            s.review_entered_at = 0;
            s.review_cooldown_until = now + cooldown_ms;
        }
    }

    /// Exit review mode for ALL drives with cooldown (used during full stop/reset).
    pub fn clear_all_reviews(&self) {
        let cooldown_ms = 60_000;
        let now = chrono::Utc::now().timestamp_millis();
        let mut states = self.states.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for s in states.values_mut() {
            s.in_review = false;
            s.review_entered_at = 0;
            s.review_cooldown_until = now + cooldown_ms;
        }
    }

    // ── Token Refresh ───────────────────────────────────────────────────

    pub fn is_token_refreshing(&self) -> bool {
        self.token_refreshing.load(Ordering::SeqCst)
    }

    pub fn set_token_refreshing(&self, v: bool) {
        self.token_refreshing.store(v, Ordering::SeqCst);
    }

    // ── Consecutive Failures ────────────────────────────────────────────

    pub fn record_sync_failure(&self) -> i64 {
        self.consecutive_failures.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn reset_sync_failures(&self) {
        self.consecutive_failures.store(0, Ordering::SeqCst);
    }

    pub fn get_sync_failures(&self) -> i64 {
        self.consecutive_failures.load(Ordering::SeqCst)
    }

    /// Clear all failure-related state after a successful sync.
    pub fn clear_failure_state(&self) {
        self.reset_sync_failures();
        self.retry_at.store(0, Ordering::Relaxed);
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = None;
        }
    }

    // ── Health ──────────────────────────────────────────────────────────

    pub fn get_health(&self) -> SyncEngineHealth {
        self.health
            .lock()
            .unwrap_or_else(|p| {
                warn!("Poisoned mutex recovered in get_health");
                p.into_inner()
            })
            .clone()
    }

    pub fn reset_health(&self) {
        let mut health = self.health.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in reset_health");
            p.into_inner()
        });
        *health = SyncEngineHealth::default();
    }

    // ── Per-Drive Sync State ────────────────────────────────────────────

    pub fn update_state<F>(&self, label: &str, f: F)
    where
        F: FnOnce(&mut HcfsSyncState),
    {
        let mut states = self.states.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in update_state");
            p.into_inner()
        });
        let state = states.entry(label.to_string()).or_default();
        f(state);
    }

    pub fn reset_all_states(&self) {
        let mut states = self.states.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in reset_all_states");
            p.into_inner()
        });
        states.clear();
    }

    pub fn remove_state(&self, label: &str) {
        let mut states = self.states.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in remove_state");
            p.into_inner()
        });
        states.remove(label);
    }

    // ── Pending Activity ────────────────────────────────────────────────

    pub fn add_pending_activity(&self, item: SyncActivityItem) {
        let mut pending = self.pending_activity.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in add_pending_activity");
            p.into_inner()
        });
        let already_exists = pending.iter().any(|existing| {
            existing.file_name == item.file_name
                && existing.action == item.action
                && existing.label == item.label
                && existing.size_bytes == item.size_bytes
        });
        if !already_exists {
            pending.push(item);
        }
    }

    pub fn commit_pending_activity_for_label(&self, label: &str) {
        let items: Vec<SyncActivityItem> = {
            let mut pending = self.pending_activity.lock().unwrap_or_else(|p| {
                warn!("Poisoned mutex recovered in commit_pending_activity_for_label");
                p.into_inner()
            });
            let (matching, remaining): (Vec<_>, Vec<_>) = pending.drain(..).partition(|item| item.label == label);
            *pending = remaining;
            matching
        };
        if !items.is_empty() {
            info!("[Sync] Committing {} activity items for label '{}' to recent files", items.len(), label);
            self.update_state(label, |state| {
                for item in &items {
                    info!("[Sync] -> {} ({})", item.file_name, item.action);
                }
                for item in items {
                    state.add_activity(item);
                }
            });
        }
    }

    pub fn discard_pending_activity_for_label(&self, label: &str) {
        let mut pending = self.pending_activity.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in discard_pending_activity_for_label");
            p.into_inner()
        });
        let before = pending.len();
        pending.retain(|item| item.label != label);
        let removed = before - pending.len();
        if removed > 0 {
            info!(
                "[Sync] Discarding {} pending activity items for label '{}' (sync failed or no real transfers)",
                removed, label
            );
        }
    }

    pub fn discard_all_pending_activity(&self) {
        let mut pending = self.pending_activity.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in discard_all_pending_activity");
            p.into_inner()
        });
        if !pending.is_empty() {
            info!("[Sync] Discarding all {} pending activity items", pending.len());
        }
        pending.clear();
    }

    // ── Combined Sync Status (Tauri commands) ───────────────────────────

    pub fn get_sync_status(&self) -> crate::sync_shared::CombinedSyncState {
        let states = self.states.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in get_sync_status");
            p.into_inner()
        });

        let is_syncing = states.values().any(|s| s.is_syncing);
        let last_sync_time = states.values().filter_map(|s| s.last_sync_time).max();

        let mut all_activity: Vec<SyncActivityItem> = states.values().flat_map(|s| s.recent_activity.iter().cloned()).collect();
        all_activity.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        all_activity.truncate(MAX_ACTIVITY);

        crate::sync_shared::CombinedSyncState {
            is_syncing,
            last_sync_time,
            recent_activity: all_activity.into(),
        }
    }

    pub fn get_sync_activity(&self, limit: Option<usize>, label: Option<String>) -> Vec<SyncActivityItem> {
        let max = limit.unwrap_or(50);

        // Committed activity from previous sync cycles
        let states = self.states.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in get_sync_activity");
            p.into_inner()
        });

        let mut all: Vec<SyncActivityItem> = if let Some(ref lbl) = label {
            states.get(lbl).map(|s| s.recent_activity.iter().cloned().collect()).unwrap_or_default()
        } else {
            states.values().flat_map(|s| s.recent_activity.iter().cloned()).collect()
        };
        drop(states);

        // Include pending activity (files completed during the current
        // sync cycle that haven't been committed yet). This lets the
        // frontend show recently synced files before the cycle ends.
        if let Ok(pending) = self.pending_activity.lock() {
            for item in pending.iter() {
                let dominated = label.as_ref().is_some_and(|l| l != &item.label);
                if !dominated {
                    all.push(item.clone());
                }
            }
        }

        all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        all.truncate(max);
        all
    }

    // ── App Handle (for snapshot emission) ──────────────────────────────

    pub fn set_app_handle(&self, app: AppHandle) {
        if let Ok(mut handle) = self.app_handle.lock() {
            *handle = Some(app);
        }
    }

    // ── Snapshot Emission (throttled) ───────────────────────────────────

    pub fn emit_snapshot(&self, immediate: bool) {
        let mut snapshot = {
            let state = self.progress.lock().unwrap_or_else(|p| {
                warn!("Poisoned mutex in emit_snapshot");
                p.into_inner()
            });
            crate::sync_progress::build_snapshot(&state)
        };

        // Inject retry state from SyncEngine atomics
        let retry_at = self.retry_at.load(Ordering::Relaxed);
        if retry_at > 0 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            snapshot.retry_in_secs = (retry_at - now).max(0) as u64;
        }
        snapshot.last_error = self.last_error.lock().ok().and_then(|g| g.clone());

        let app = self.app_handle.lock().ok().and_then(|g| g.clone());

        let Some(app) = app else { return };

        if immediate {
            if let Ok(mut t) = self.last_emit_time.lock() {
                *t = Instant::now();
            }
            let _ = app.emit("sync_progress_snapshot", &snapshot);
            return;
        }

        // Throttled path
        let should_emit = self.last_emit_time.lock().ok().is_none_or(|t| t.elapsed().as_millis() >= 250);

        if should_emit {
            if let Ok(mut t) = self.last_emit_time.lock() {
                *t = Instant::now();
            }
            let _ = app.emit("sync_progress_snapshot", &snapshot);
        } else if !self.emit_scheduled.swap(true, Ordering::AcqRel) {
            let app_clone = app.clone();
            // Retrieve the SyncEngine from Tauri managed AppState inside the
            // thread — avoids raw pointers and lifetime issues.
            std::thread::spawn(move || {
                use tauri::Manager;
                std::thread::sleep(std::time::Duration::from_millis(250));
                let app_state = app_clone.state::<crate::app_state::AppState>();
                let sync = &app_state.sync;
                sync.emit_scheduled.store(false, Ordering::Release);
                let mut snapshot = {
                    let state = sync.progress.lock().unwrap_or_else(|p| {
                        warn!("Poisoned mutex in delayed emit");
                        p.into_inner()
                    });
                    crate::sync_progress::build_snapshot(&state)
                };
                // Inject retry state
                let retry_at = sync.retry_at.load(Ordering::Relaxed);
                if retry_at > 0 {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    snapshot.retry_in_secs = (retry_at - now).max(0) as u64;
                }
                snapshot.last_error = sync.last_error.lock().ok().and_then(|g| g.clone());
                if let Ok(mut t) = sync.last_emit_time.lock() {
                    *t = Instant::now();
                }
                let _ = app_clone.emit("sync_progress_snapshot", &snapshot);
            });
        }
    }

    // ── Synced Paths Cache ───────────────────────────────────────────────

    /// Update the cached synced-paths map for a given drive label.
    /// Called after each successful sync so the file browser can fall back
    /// to this snapshot when the drives lock is unavailable.
    pub fn update_synced_paths_cache(&self, label: &str, paths: HashMap<String, crate::sync_shared::SyncedFileInfo>) {
        if let Ok(mut cache) = self.synced_paths_cache.lock() {
            cache.insert(label.to_string(), paths);
        }
    }

    /// Return a clone of the cached synced-paths for `label`, if available.
    pub fn get_cached_synced_paths(&self, label: &str) -> Option<HashMap<String, crate::sync_shared::SyncedFileInfo>> {
        let cache = self.synced_paths_cache.lock().ok()?;
        cache.get(label).cloned()
    }

    /// Insert or update a single file entry in the synced-paths cache.
    /// Called from the `on_file_synced` progress callback to make arion
    /// hashes available to the frontend before the full sync cycle ends.
    pub fn upsert_synced_path(&self, label: &str, rel_path: String, info: crate::sync_shared::SyncedFileInfo) {
        if let Ok(mut cache) = self.synced_paths_cache.lock() {
            cache.entry(label.to_string()).or_default().insert(rel_path, info);
        }
    }

    // ── Rename Hints ────────────────────────────────────────────────────

    /// Push a rename hint captured by the file watcher.
    /// Drops the hint if the buffer is at capacity (10 000) to prevent
    /// unbounded memory growth under bulk-rename workloads.
    ///
    /// Also updates existing activity items so the recent-files list
    /// reflects the new filename immediately (without waiting for a
    /// full sync cycle).
    pub fn push_rename_hint(&self, hint: crate::sync_logic::RenameHint) {
        const MAX_RENAME_HINTS: usize = 10_000;

        // Update activity items before storing the hint
        self.apply_rename_to_activity(&hint);

        let mut guard = self.rename_hints.lock().unwrap_or_else(|p| {
            warn!("Poisoned rename_hints mutex recovered");
            p.into_inner()
        });
        if guard.len() >= MAX_RENAME_HINTS {
            return;
        }
        guard.push(hint);
    }

    /// Drain rename hints whose paths fall under `sync_root`.
    /// Hints for other drives remain in the buffer. This prevents
    /// concurrent drives from stealing each other's hints.
    pub fn drain_rename_hints_for_root(&self, sync_root: &std::path::Path) -> Vec<crate::sync_logic::RenameHint> {
        let mut guard = self.rename_hints.lock().unwrap_or_else(|p| {
            warn!("Poisoned rename_hints mutex recovered in drain");
            p.into_inner()
        });
        let mut matched = Vec::new();
        let mut remaining = Vec::new();
        for hint in guard.drain(..) {
            if hint.old_path.starts_with(sync_root) || hint.new_path.starts_with(sync_root) {
                matched.push(hint);
            } else {
                remaining.push(hint);
            }
        }
        *guard = remaining;
        matched
    }

    // ── Label Roots (for rename → activity mapping) ──────────────────

    /// Register the sync folder root for a drive label.
    pub fn register_label_root(&self, label: String, root: std::path::PathBuf) {
        let mut guard = self.label_roots.lock().unwrap_or_else(|p| {
            warn!("Poisoned label_roots mutex recovered");
            p.into_inner()
        });
        guard.insert(label, root);
    }

    /// Remove a label root (when a drive is stopped).
    pub fn unregister_label_root(&self, label: &str) {
        let mut guard = self.label_roots.lock().unwrap_or_else(|p| {
            warn!("Poisoned label_roots mutex recovered");
            p.into_inner()
        });
        guard.remove(label);
    }

    /// Clear all label roots (on full stop).
    pub fn clear_label_roots(&self) {
        let mut guard = self.label_roots.lock().unwrap_or_else(|p| {
            warn!("Poisoned label_roots mutex recovered");
            p.into_inner()
        });
        guard.clear();
    }

    /// Update file_name in committed and pending activity items when
    /// a file is renamed on disk. Emits `hcfs_activity_updated` so
    /// the frontend can refresh the recent-files list.
    fn apply_rename_to_activity(&self, hint: &crate::sync_logic::RenameHint) {
        // Find the label and relative paths for this rename hint
        let label_roots = self.label_roots.lock().unwrap_or_else(|p| {
            warn!("Poisoned label_roots mutex in apply_rename");
            p.into_inner()
        });

        let mut matched_label = None;
        let mut old_relative = None;
        let mut new_relative = None;

        for (label, root) in label_roots.iter() {
            if hint.old_path.starts_with(root)
                && let Ok(old_rel) = hint.old_path.strip_prefix(root)
            {
                let new_rel = if hint.new_path.starts_with(root) {
                    hint.new_path.strip_prefix(root).ok()
                } else {
                    None
                };
                if let Some(nr) = new_rel {
                    matched_label = Some(label.clone());
                    old_relative = Some(old_rel.to_string_lossy().to_string());
                    new_relative = Some(nr.to_string_lossy().to_string());
                    break;
                }
            }
        }
        drop(label_roots);

        let (Some(label), Some(old_rel), Some(new_rel)) = (matched_label, old_relative, new_relative) else {
            return;
        };

        let mut updated = false;

        // Update committed activity (per-drive state)
        {
            let mut states = self.states.lock().unwrap_or_else(|p| {
                warn!("Poisoned states mutex in apply_rename");
                p.into_inner()
            });
            if let Some(state) = states.get_mut(&label) {
                for item in &mut state.recent_activity {
                    if item.file_name == old_rel {
                        info!(
                            old = %old_rel,
                            new = %new_rel,
                            label = %label,
                            "Renamed file in committed activity",
                        );
                        item.file_name.clone_from(&new_rel);
                        updated = true;
                    }
                }
            }
        }

        // Update pending activity (current sync cycle)
        {
            let mut pending = self.pending_activity.lock().unwrap_or_else(|p| {
                warn!("Poisoned pending mutex in apply_rename");
                p.into_inner()
            });
            for item in pending.iter_mut() {
                if item.file_name == old_rel && item.label == label {
                    info!(
                        old = %old_rel,
                        new = %new_rel,
                        label = %label,
                        "Renamed file in pending activity",
                    );
                    item.file_name.clone_from(&new_rel);
                    updated = true;
                }
            }
        }

        // Also update the synced_paths_cache so get_synced_file_metadata
        // returns the new name before the next sync cycle
        {
            let mut cache = self.synced_paths_cache.lock().unwrap_or_else(|p| {
                warn!("Poisoned synced_paths_cache in apply_rename");
                p.into_inner()
            });
            if let Some(drive_cache) = cache.get_mut(&label)
                && let Some(info) = drive_cache.remove(&old_rel)
            {
                drive_cache.insert(new_rel.clone(), info);
                updated = true;
            }
        }

        if updated {
            // Emit event so frontend refreshes recent files
            let app = self.app_handle.lock().ok().and_then(|g| g.clone());
            if let Some(app) = app {
                let _ = app.emit(crate::sync_events::ACTIVITY_UPDATED, ());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_shared::SyncActivityItem;

    fn activity(name: &str, action: &str, label: &str, size: u64) -> SyncActivityItem {
        SyncActivityItem {
            file_name: name.to_string(),
            action: action.to_string(),
            timestamp: chrono::Utc::now().timestamp_millis(),
            size_bytes: size,
            label: label.to_string(),
        }
    }

    #[test]
    fn duplicate_pending_activity_is_skipped() {
        let eng = SyncEngine::new();
        let item = activity("a.txt", "uploaded", "docs", 100);
        eng.add_pending_activity(item.clone());
        eng.add_pending_activity(item);
        eng.commit_pending_activity_for_label("docs");
        let states = eng.states.lock().unwrap();
        assert_eq!(states.get("docs").unwrap().recent_activity.len(), 1);
    }

    #[test]
    fn different_action_is_not_deduplicated() {
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("a.txt", "uploaded", "docs", 100));
        eng.add_pending_activity(activity("a.txt", "downloaded", "docs", 100));
        eng.commit_pending_activity_for_label("docs");
        let states = eng.states.lock().unwrap();
        assert_eq!(states.get("docs").unwrap().recent_activity.len(), 2);
    }

    #[test]
    fn different_size_is_not_deduplicated() {
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("a.txt", "uploaded", "docs", 100));
        eng.add_pending_activity(activity("a.txt", "uploaded", "docs", 200));
        eng.commit_pending_activity_for_label("docs");
        let states = eng.states.lock().unwrap();
        assert_eq!(states.get("docs").unwrap().recent_activity.len(), 2);
    }

    #[test]
    fn different_label_is_not_deduplicated() {
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("a.txt", "uploaded", "docs", 100));
        eng.add_pending_activity(activity("a.txt", "uploaded", "photos", 100));
        eng.commit_pending_activity_for_label("docs");
        eng.commit_pending_activity_for_label("photos");
        let states = eng.states.lock().unwrap();
        assert_eq!(states.get("docs").unwrap().recent_activity.len(), 1);
        assert_eq!(states.get("photos").unwrap().recent_activity.len(), 1);
    }

    #[test]
    fn commit_moves_matching_label_only() {
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("d.txt", "uploaded", "docs", 10));
        eng.add_pending_activity(activity("p.jpg", "uploaded", "photos", 20));
        eng.commit_pending_activity_for_label("docs");
        let states = eng.states.lock().unwrap();
        assert_eq!(states.get("docs").unwrap().recent_activity.len(), 1);
        assert!(states.get("photos").is_none());
    }

    #[test]
    fn discard_removes_matching_label_only() {
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("d.txt", "uploaded", "docs", 10));
        eng.add_pending_activity(activity("p.jpg", "uploaded", "photos", 20));
        eng.discard_pending_activity_for_label("docs");
        eng.commit_pending_activity_for_label("photos");
        let states = eng.states.lock().unwrap();
        assert!(states.get("docs").is_none());
        assert_eq!(states.get("photos").unwrap().recent_activity.len(), 1);
    }

    #[test]
    fn discard_all_clears_everything() {
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("a.txt", "uploaded", "docs", 10));
        eng.add_pending_activity(activity("b.jpg", "uploaded", "photos", 20));
        eng.discard_all_pending_activity();
        eng.commit_pending_activity_for_label("docs");
        eng.commit_pending_activity_for_label("photos");
        let states = eng.states.lock().unwrap();
        assert!(states.get("docs").is_none());
        assert!(states.get("photos").is_none());
    }

    #[test]
    fn activity_ring_buffer_caps_at_100() {
        let eng = SyncEngine::new();
        for i in 0..120 {
            eng.update_state("docs", |state| {
                state.add_activity(activity(&format!("file_{i}.txt"), "uploaded", "docs", i as u64));
            });
        }
        let states = eng.states.lock().unwrap();
        assert_eq!(states.get("docs").unwrap().recent_activity.len(), 100);
    }

    #[test]
    fn per_label_state_is_isolated() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| s.is_syncing = true);
        eng.update_state("photos", |s| s.last_sync_time = Some(1234));
        let states = eng.states.lock().unwrap();
        let docs = states.get("docs").unwrap();
        let photos = states.get("photos").unwrap();
        assert!(docs.is_syncing);
        assert_eq!(docs.last_sync_time, None);
        assert!(!photos.is_syncing);
        assert_eq!(photos.last_sync_time, Some(1234));
    }

    #[test]
    fn remove_state_deletes_label() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| s.is_syncing = true);
        eng.remove_state("docs");
        let states = eng.states.lock().unwrap();
        assert!(states.get("docs").is_none());
    }

    #[test]
    fn combined_status_any_syncing() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| s.is_syncing = false);
        eng.update_state("photos", |s| s.is_syncing = true);
        let combined = eng.get_sync_status();
        assert!(combined.is_syncing);
    }

    #[test]
    fn combined_status_last_sync_time_is_max() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| s.last_sync_time = Some(100));
        eng.update_state("photos", |s| s.last_sync_time = Some(500));
        eng.update_state("music", |s| s.last_sync_time = Some(300));
        let combined = eng.get_sync_status();
        assert_eq!(combined.last_sync_time, Some(500));
    }

    #[test]
    fn combined_status_merges_activity_sorted_by_time() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| {
            s.add_activity(SyncActivityItem {
                file_name: "old.txt".to_string(),
                action: "uploaded".to_string(),
                timestamp: 100,
                size_bytes: 1,
                label: "docs".to_string(),
            });
        });
        eng.update_state("photos", |s| {
            s.add_activity(SyncActivityItem {
                file_name: "new.jpg".to_string(),
                action: "uploaded".to_string(),
                timestamp: 200,
                size_bytes: 2,
                label: "photos".to_string(),
            });
        });
        let combined = eng.get_sync_status();
        assert_eq!(combined.recent_activity.len(), 2);
        assert_eq!(combined.recent_activity[0].file_name, "new.jpg");
        assert_eq!(combined.recent_activity[1].file_name, "old.txt");
    }

    #[test]
    fn get_activity_filters_by_label() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| {
            s.add_activity(activity("a.txt", "uploaded", "docs", 1));
        });
        eng.update_state("photos", |s| {
            s.add_activity(activity("b.jpg", "uploaded", "photos", 2));
        });
        let result = eng.get_sync_activity(None, Some("docs".to_string()));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name, "a.txt");
    }

    #[test]
    fn get_activity_no_label_returns_all() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| {
            s.add_activity(activity("a.txt", "uploaded", "docs", 1));
        });
        eng.update_state("photos", |s| {
            s.add_activity(activity("b.jpg", "uploaded", "photos", 2));
        });
        let result = eng.get_sync_activity(None, None);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn get_activity_respects_limit() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| {
            for i in 0..10 {
                s.add_activity(activity(&format!("file_{i}.txt"), "uploaded", "docs", i as u64));
            }
        });
        let result = eng.get_sync_activity(Some(3), Some("docs".to_string()));
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn get_activity_unknown_label_returns_empty() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| {
            s.add_activity(activity("a.txt", "uploaded", "docs", 1));
        });
        let result = eng.get_sync_activity(None, Some("nonexistent".to_string()));
        assert!(result.is_empty());
    }

    #[test]
    fn push_and_drain_rename_hints_by_root() {
        let engine = SyncEngine::new();

        engine.push_rename_hint(crate::sync_logic::RenameHint {
            old_path: std::path::PathBuf::from("/drive_a/old.txt"),
            new_path: std::path::PathBuf::from("/drive_a/new.txt"),
        });
        engine.push_rename_hint(crate::sync_logic::RenameHint {
            old_path: std::path::PathBuf::from("/drive_b/old.txt"),
            new_path: std::path::PathBuf::from("/drive_b/new.txt"),
        });

        // Drain only drive_a hints
        let a_hints = engine.drain_rename_hints_for_root(std::path::Path::new("/drive_a"));
        assert_eq!(a_hints.len(), 1);
        assert_eq!(a_hints[0].old_path, std::path::PathBuf::from("/drive_a/old.txt"));

        // drive_b hint is still in the buffer
        let b_hints = engine.drain_rename_hints_for_root(std::path::Path::new("/drive_b"));
        assert_eq!(b_hints.len(), 1);
        assert_eq!(b_hints[0].old_path, std::path::PathBuf::from("/drive_b/old.txt"));

        // Buffer is now empty
        let empty = engine.drain_rename_hints_for_root(std::path::Path::new("/drive_a"));
        assert!(empty.is_empty());
    }

    #[test]
    fn rename_hints_capped_at_10000() {
        let engine = SyncEngine::new();

        for i in 0..10_001 {
            engine.push_rename_hint(crate::sync_logic::RenameHint {
                old_path: std::path::PathBuf::from(format!("/sync/old_{i}.txt")),
                new_path: std::path::PathBuf::from(format!("/sync/new_{i}.txt")),
            });
        }

        let drained = engine.drain_rename_hints_for_root(std::path::Path::new("/sync"));
        assert_eq!(drained.len(), 10_000);
    }

    #[test]
    fn drain_rename_hints_empty_by_default() {
        let engine = SyncEngine::new();
        let drained = engine.drain_rename_hints_for_root(std::path::Path::new("/sync"));
        assert!(drained.is_empty());
    }

    #[test]
    fn rename_updates_committed_activity() {
        let eng = SyncEngine::new();
        eng.register_label_root("docs".to_string(), std::path::PathBuf::from("/sync/docs"));
        eng.update_state("docs", |s| {
            s.add_activity(activity("report.txt", "uploaded", "docs", 100));
        });

        eng.push_rename_hint(crate::sync_logic::RenameHint {
            old_path: std::path::PathBuf::from("/sync/docs/report.txt"),
            new_path: std::path::PathBuf::from("/sync/docs/report_v2.txt"),
        });

        let result = eng.get_sync_activity(None, Some("docs".to_string()));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name, "report_v2.txt");
    }

    #[test]
    fn rename_updates_pending_activity() {
        let eng = SyncEngine::new();
        eng.register_label_root("docs".to_string(), std::path::PathBuf::from("/sync/docs"));
        eng.add_pending_activity(activity("draft.md", "uploaded", "docs", 50));

        eng.push_rename_hint(crate::sync_logic::RenameHint {
            old_path: std::path::PathBuf::from("/sync/docs/draft.md"),
            new_path: std::path::PathBuf::from("/sync/docs/final.md"),
        });

        let result = eng.get_sync_activity(None, Some("docs".to_string()));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name, "final.md");
    }

    #[test]
    fn rename_without_label_root_is_no_op() {
        let eng = SyncEngine::new();
        eng.update_state("docs", |s| {
            s.add_activity(activity("report.txt", "uploaded", "docs", 100));
        });

        // No label root registered — rename should not change anything
        eng.push_rename_hint(crate::sync_logic::RenameHint {
            old_path: std::path::PathBuf::from("/sync/docs/report.txt"),
            new_path: std::path::PathBuf::from("/sync/docs/report_v2.txt"),
        });

        let result = eng.get_sync_activity(None, Some("docs".to_string()));
        assert_eq!(result[0].file_name, "report.txt");
    }

    #[test]
    fn rename_only_affects_matching_label() {
        let eng = SyncEngine::new();
        eng.register_label_root("docs".to_string(), std::path::PathBuf::from("/sync/docs"));
        eng.register_label_root("photos".to_string(), std::path::PathBuf::from("/sync/photos"));
        eng.update_state("docs", |s| {
            s.add_activity(activity("file.txt", "uploaded", "docs", 10));
        });
        eng.update_state("photos", |s| {
            s.add_activity(activity("file.txt", "uploaded", "photos", 20));
        });

        eng.push_rename_hint(crate::sync_logic::RenameHint {
            old_path: std::path::PathBuf::from("/sync/docs/file.txt"),
            new_path: std::path::PathBuf::from("/sync/docs/renamed.txt"),
        });

        let docs = eng.get_sync_activity(None, Some("docs".to_string()));
        assert_eq!(docs[0].file_name, "renamed.txt");
        let photos = eng.get_sync_activity(None, Some("photos".to_string()));
        assert_eq!(photos[0].file_name, "file.txt");
    }

    #[test]
    fn rename_in_subfolder_uses_relative_path() {
        let eng = SyncEngine::new();
        eng.register_label_root("docs".to_string(), std::path::PathBuf::from("/sync/docs"));
        eng.update_state("docs", |s| {
            s.add_activity(activity("sub/deep/file.txt", "uploaded", "docs", 100));
        });

        eng.push_rename_hint(crate::sync_logic::RenameHint {
            old_path: std::path::PathBuf::from("/sync/docs/sub/deep/file.txt"),
            new_path: std::path::PathBuf::from("/sync/docs/sub/deep/renamed.txt"),
        });

        let result = eng.get_sync_activity(None, Some("docs".to_string()));
        assert_eq!(result[0].file_name, "sub/deep/renamed.txt");
    }

    #[test]
    fn subfolder_file_name_preserved_in_activity() {
        // Verify that activity items with subfolder-relative paths
        // (e.g. "deps/photo.jpg") retain the full relative path after
        // commit, not just the basename. This is critical for
        // recent-files to construct the correct on-disk source path.
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("deps/librust_plugin.rmeta", "downloaded", "march-09", 48));
        eng.add_pending_activity(activity("branch-cleanup.md", "uploaded", "march-09", 4186));
        eng.commit_pending_activity_for_label("march-09");

        let result = eng.get_sync_activity(None, Some("march-09".to_string()));
        assert_eq!(result.len(), 2);

        // Subfolder file must keep its relative path prefix
        let subfolder_file = result.iter().find(|i| i.file_name.contains("librust_plugin")).unwrap();
        assert_eq!(subfolder_file.file_name, "deps/librust_plugin.rmeta");

        // Root-level file should remain as-is
        let root_file = result.iter().find(|i| i.file_name.contains("branch-cleanup")).unwrap();
        assert_eq!(root_file.file_name, "branch-cleanup.md");
    }

    #[test]
    fn deeply_nested_subfolder_path_preserved() {
        let eng = SyncEngine::new();
        eng.add_pending_activity(activity("a/b/c/deep-file.txt", "uploaded", "sync-folder", 100));
        eng.commit_pending_activity_for_label("sync-folder");

        let result = eng.get_sync_activity(None, Some("sync-folder".to_string()));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name, "a/b/c/deep-file.txt");
    }
}
