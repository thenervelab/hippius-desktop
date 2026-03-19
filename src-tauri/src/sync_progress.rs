//! In-memory sync progress tracking.
//!
//! Replaces the frontend's localStorage-based `syncProgressService.ts`.
//! All state is transient (not persisted to SQLite) — it only lives for the
//! duration of the app process. Uses a global `Mutex<SyncProgressState>`
//! following the same pattern as `sync_shared.rs`.

use once_cell::sync::Lazy;
use std::cmp::Ordering as CmpOrdering;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tracing::warn;

// ── Constants ──────────────────────────────────────────────────────────

const RECENT_FILES_RETENTION_MS: i64 = 60 * 60 * 1000; // 1 hour
// ── Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Pending,
    Uploading,
    Downloading,
    Deleting,
    Completed,
    Error,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FileAction {
    Upload,
    Download,
    LocalDelete,
    RemoteDelete,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub label: String,
    pub action: FileAction,
    pub status: FileStatus,
    pub progress: u32,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSession {
    pub session_id: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub is_active: bool,
    pub expected_uploads: u32,
    pub expected_downloads: u32,
    pub expected_local_deletes: u32,
    pub expected_remote_deletes: u32,
    pub files: HashMap<String, SyncFile>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub label: String,
    pub action: FileAction,
    pub completed_at: i64,
    pub size_bytes: u64,
    pub session_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressState {
    pub current_session: Option<SyncSession>,
    pub recent_files: Vec<RecentFile>,
    pub last_updated: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverallProgress {
    pub is_active: bool,
    pub total_files: usize,
    pub completed_files: usize,
    pub in_progress_files: usize,
    pub failed_files: usize,
    pub overall_percent: u32,
    pub total_bytes_transferred: u64,
    pub total_bytes_expected: u64,
    pub current_file: Option<SyncFile>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileList {
    pub upload_files: Option<Vec<String>>,
    pub download_files: Option<Vec<String>>,
    pub local_delete_files: Option<Vec<String>>,
    pub remote_delete_files: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileProgressStatus {
    Pending,
    InProgress,
    Completed,
    Error,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgress {
    pub path: String,
    pub file_name: String,
    pub label: String,
    pub action: FileAction,
    pub status: FileProgressStatus,
    pub progress_percent: u32,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub is_active: bool,
    pub overall_percent: u32,
    pub bytes_transferred: u64,
    pub bytes_expected: u64,
    pub total_files: usize,
    pub completed_files: usize,
    pub failed_files: usize,
    pub files: Vec<FileProgress>,
}

// ── Global State ───────────────────────────────────────────────────────

pub static SYNC_PROGRESS: Lazy<Mutex<SyncProgressState>> = Lazy::new(|| {
    Mutex::new(SyncProgressState {
        current_session: None,
        recent_files: Vec::new(),
        last_updated: now_ms(),
    })
});

/// Global app handle for emitting snapshot events.
static SYNC_APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

/// Last time a snapshot was emitted (for byte-update throttling).
static LAST_EMIT_TIME: Lazy<Mutex<Instant>> = Lazy::new(|| Mutex::new(Instant::now()));

/// Whether a delayed emit is already scheduled.
static EMIT_SCHEDULED: Lazy<std::sync::atomic::AtomicBool> =
    Lazy::new(|| std::sync::atomic::AtomicBool::new(false));

const EMIT_THROTTLE_MS: u64 = 250;

/// Store the app handle for later event emission.
/// Call once during app setup.
pub fn set_app_handle(app: AppHandle) {
    if let Ok(mut handle) = SYNC_APP_HANDLE.lock() {
        *handle = Some(app);
    }
}

/// Emit a snapshot event to the frontend.
///
/// `immediate`: bypasses throttle for status transitions (file completed,
/// error, session start/stop). When false, throttles to one emit per 250ms
/// and schedules a delayed flush for pending byte-progress updates.
fn emit_snapshot_inner(immediate: bool) {
    let snapshot = {
        let state = SYNC_PROGRESS.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex in emit_snapshot");
            p.into_inner()
        });
        build_snapshot(&state)
    };

    let app = SYNC_APP_HANDLE
        .lock()
        .ok()
        .and_then(|g| g.clone());

    let Some(app) = app else { return };

    if immediate {
        if let Ok(mut t) = LAST_EMIT_TIME.lock() {
            *t = Instant::now();
        }
        let _ = app.emit("sync_progress_snapshot", &snapshot);
        return;
    }

    // Throttled path
    let should_emit = LAST_EMIT_TIME
        .lock()
        .ok()
        .map_or(true, |t| t.elapsed().as_millis() >= u128::from(EMIT_THROTTLE_MS));

    if should_emit {
        if let Ok(mut t) = LAST_EMIT_TIME.lock() {
            *t = Instant::now();
        }
        let _ = app.emit("sync_progress_snapshot", &snapshot);
    } else if !EMIT_SCHEDULED.swap(true, Ordering::AcqRel) {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(EMIT_THROTTLE_MS));
            EMIT_SCHEDULED.store(false, Ordering::Release);
            let snapshot = {
                let state = SYNC_PROGRESS.lock().unwrap_or_else(|p| {
                    warn!("Poisoned mutex in delayed emit");
                    p.into_inner()
                });
                build_snapshot(&state)
            };
            if let Ok(mut t) = LAST_EMIT_TIME.lock() {
                *t = Instant::now();
            }
            let _ = app_clone.emit("sync_progress_snapshot", &snapshot);
        });
    }
}

// ── Helper Functions ───────────────────────────────────────────────────

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn generate_file_id(path: &str) -> String {
    let mut hash: i32 = 0;
    for ch in path.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as i32);
    }
    format!("file_{:x}", hash.unsigned_abs())
}

fn generate_session_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "session_{}_{}",
        now_ms(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn is_encrypted_file_id(file_name: &str) -> bool {
    // Pattern 1: Starts with "file_" followed by hex
    if file_name.starts_with("file_")
        && file_name.len() > 5
        && file_name[5..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return true;
    }
    // Pattern 2: Pure hex string 20+ chars
    if file_name.len() >= 20 && file_name.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    // Pattern 3: Hex 16+ chars, no dot
    if file_name.len() >= 16
        && !file_name.contains('.')
        && file_name.chars().all(|c| c.is_ascii_hexdigit())
    {
        return true;
    }
    false
}

fn should_hide_file(path: &str) -> bool {
    let file_name = path
        .rsplit('/')
        .next()
        .or_else(|| path.rsplit('\\').next())
        .unwrap_or(path);
    is_encrypted_file_id(file_name)
}

fn extract_file_name(path: &str) -> String {
    let raw_name = path
        .rsplit('/')
        .next()
        .or_else(|| path.rsplit('\\').next())
        .unwrap_or(path);
    if is_encrypted_file_id(raw_name) {
        "Encrypted file".to_string()
    } else {
        raw_name.to_string()
    }
}

/// Remove expired recent files from state (call within lock).
fn clean_expired(state: &mut SyncProgressState) {
    let now = now_ms();
    state
        .recent_files
        .retain(|f| now - f.completed_at < RECENT_FILES_RETENTION_MS);
}

/// Register files from a file list into the session.
fn register_files(session: &mut SyncSession, file_list: &SessionFileList, label: &str) {
    let now = now_ms();

    let pairs: [(FileAction, &Option<Vec<String>>); 4] = [
        (FileAction::Upload, &file_list.upload_files),
        (FileAction::Download, &file_list.download_files),
        (FileAction::LocalDelete, &file_list.local_delete_files),
        (FileAction::RemoteDelete, &file_list.remote_delete_files),
    ];

    for (action, paths_opt) in &pairs {
        if let Some(paths) = paths_opt {
            for path in paths {
                if !session.files.contains_key(path.as_str()) {
                    let file = SyncFile {
                        id: generate_file_id(path),
                        path: path.clone(),
                        file_name: extract_file_name(path),
                        label: label.to_string(),
                        action: action.clone(),
                        status: FileStatus::Pending,
                        progress: 0,
                        bytes_transferred: 0,
                        total_bytes: 0,
                        started_at: now,
                        completed_at: None,
                        error: None,
                    };
                    session.files.insert(path.clone(), file);
                }
            }
        }
    }
}

/// Move completed files from a session to the recent files list.
/// Only adds files that are not already present in recent_files
/// (identified by path + session_id) to prevent duplicates when
/// this function is called multiple times for the same session.
fn move_completed_to_recent(state: &mut SyncProgressState) {
    let session = match &state.current_session {
        Some(s) => s,
        None => return,
    };
    let session_id = session.session_id.clone();
    let now = now_ms();

    // Build a set of (path, session_id) already in recent to avoid duplicates
    let existing: std::collections::HashSet<(&str, &str)> = state
        .recent_files
        .iter()
        .map(|r| (r.path.as_str(), r.session_id.as_str()))
        .collect();

    let new_completed: Vec<RecentFile> = session
        .files
        .values()
        .filter(|f| f.status == FileStatus::Completed)
        .filter(|f| !existing.contains(&(f.path.as_str(), session_id.as_str())))
        .map(|f| RecentFile {
            id: f.id.clone(),
            path: f.path.clone(),
            file_name: f.file_name.clone(),
            label: f.label.clone(),
            action: f.action.clone(),
            completed_at: f.completed_at.unwrap_or(now),
            size_bytes: f.total_bytes,
            session_id: session_id.clone(),
        })
        .collect();

    state.recent_files.extend(new_completed);
    clean_expired(state);
}

// ── Snapshot Builder ──────────────────────────────────────────────────

/// Build a sorted snapshot from the current state.
///
/// Pure function: no side effects, no Tauri dependency. Unit tests call this
/// directly with constructed state.
pub fn build_snapshot(state: &SyncProgressState) -> SyncSnapshot {
    let session = match &state.current_session {
        Some(s) => s,
        None => {
            return SyncSnapshot {
                is_active: false,
                overall_percent: 0,
                bytes_transferred: 0,
                bytes_expected: 0,
                total_files: 0,
                completed_files: 0,
                failed_files: 0,
                files: Vec::new(),
            };
        }
    };

    let mut files: Vec<FileProgress> = session
        .files
        .values()
        .map(|f| {
            let status = match f.status {
                FileStatus::Pending => FileProgressStatus::Pending,
                FileStatus::Uploading
                | FileStatus::Downloading
                | FileStatus::Deleting => FileProgressStatus::InProgress,
                FileStatus::Completed => FileProgressStatus::Completed,
                FileStatus::Error => FileProgressStatus::Error,
            };
            FileProgress {
                path: f.path.clone(),
                file_name: f.file_name.clone(),
                label: f.label.clone(),
                action: f.action.clone(),
                status,
                progress_percent: f.progress,
                bytes_transferred: f.bytes_transferred,
                total_bytes: f.total_bytes,
                error: f.error.clone(),
            }
        })
        .collect();

    // Sort: known sizes descending, then unknowns (total_bytes == 0) at bottom
    files.sort_by(|a, b| {
        let a_known = a.total_bytes > 0;
        let b_known = b.total_bytes > 0;
        match (a_known, b_known) {
            (true, false) => CmpOrdering::Less,
            (false, true) => CmpOrdering::Greater,
            _ => b.total_bytes.cmp(&a.total_bytes),
        }
    });

    // Single pass for stats
    let mut completed_files: usize = 0;
    let mut failed_files: usize = 0;
    let mut total_bytes_transferred: u64 = 0;
    let mut total_bytes_expected: u64 = 0;

    for f in &files {
        match f.status {
            FileProgressStatus::Completed => completed_files += 1,
            FileProgressStatus::Error => failed_files += 1,
            _ => {}
        }
        if f.total_bytes > 0 {
            total_bytes_transferred += f.bytes_transferred;
            total_bytes_expected += f.total_bytes;
        }
    }

    let total_files = files.len();
    let overall_percent = if total_files == 0 {
        0
    } else if completed_files + failed_files == total_files {
        100
    } else if total_bytes_expected > 0 {
        let pct = (total_bytes_transferred as f64
            / total_bytes_expected as f64)
            * 100.0;
        (pct.round() as u32).min(100)
    } else {
        let pct =
            (completed_files as f64 / total_files as f64) * 100.0;
        (pct.round() as u32).min(100)
    };

    SyncSnapshot {
        is_active: session.is_active,
        overall_percent,
        bytes_transferred: total_bytes_transferred,
        bytes_expected: total_bytes_expected,
        total_files,
        completed_files,
        failed_files,
        files,
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn sp_start_session(
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<SyncSession, String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_start_session");
        poisoned.into_inner()
    });

    // Always move completed files from any existing session to recent
    // before replacing it, regardless of whether it was active or inactive.
    if state.current_session.is_some() {
        move_completed_to_recent(&mut state);
    }

    let now = now_ms();
    let mut session = SyncSession {
        session_id: generate_session_id(),
        started_at: now,
        completed_at: None,
        is_active: true,
        expected_uploads,
        expected_downloads,
        expected_local_deletes,
        expected_remote_deletes,
        files: HashMap::new(),
    };

    let lbl = label.as_deref().unwrap_or("default");
    if let Some(fl) = &file_list {
        register_files(&mut session, fl, lbl);
    }

    let result = session.clone();
    state.current_session = Some(session);
    state.last_updated = now;

    drop(state);
    emit_snapshot_inner(true);
    Ok(result)
}

#[tauri::command]
pub fn sp_merge_into_session(
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_merge_into_session");
        poisoned.into_inner()
    });

    let now = now_ms();
    let lbl = label.as_deref().unwrap_or("default");

    if let Some(session) = state.current_session.as_mut().filter(|s| s.is_active) {
        // Merge into existing session
        session.expected_uploads += expected_uploads;
        session.expected_downloads += expected_downloads;
        session.expected_local_deletes += expected_local_deletes;
        session.expected_remote_deletes += expected_remote_deletes;

        if let Some(fl) = &file_list {
            register_files(session, fl, lbl);
        }
    } else {
        // No active session — start a new one
        let mut session = SyncSession {
            session_id: generate_session_id(),
            started_at: now,
            completed_at: None,
            is_active: true,
            expected_uploads,
            expected_downloads,
            expected_local_deletes,
            expected_remote_deletes,
            files: HashMap::new(),
            };

        if let Some(fl) = &file_list {
            register_files(&mut session, fl, lbl);
        }

        state.current_session = Some(session);
    }

    state.last_updated = now;
    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_complete_session(files_uploaded: u32, files_downloaded: u32) -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_complete_session");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        // Check if there's still pending work
        let pending_uploads = session
            .files
            .values()
            .filter(|f| {
                f.action == FileAction::Upload
                    && (f.status == FileStatus::Pending || f.status == FileStatus::Uploading)
            })
            .count() as u32;
        let pending_downloads = session
            .files
            .values()
            .filter(|f| {
                f.action == FileAction::Download
                    && (f.status == FileStatus::Pending || f.status == FileStatus::Downloading)
            })
            .count() as u32;

        // If actual counts exceed expected, complete all pending files
        if files_uploaded >= session.expected_uploads
            && files_downloaded >= session.expected_downloads
        {
            for file in session.files.values_mut() {
                if file.status == FileStatus::Pending
                    || file.status == FileStatus::Uploading
                    || file.status == FileStatus::Downloading
                {
                    file.status = FileStatus::Completed;
                    file.progress = 100;
                    file.completed_at = Some(now);
                    // Sync bytes so overall percent reaches 100%
                    if file.total_bytes > 0 {
                        file.bytes_transferred = file.total_bytes;
                    }
                }
            }
        }

        // If no more pending work, finalize
        if pending_uploads == 0 && pending_downloads == 0
            || (files_uploaded >= session.expected_uploads
                && files_downloaded >= session.expected_downloads)
        {
            session.completed_at = Some(now);
            session.is_active = false;
        }
    }

    // Move completed files to recent (duplicates are skipped automatically)
    move_completed_to_recent(&mut state);

    // Keep the session around (even when inactive with no pending files)
    // so the UI can display the completed state via overallProgress. The
    // session is replaced when the next sync cycle calls sp_start_session.

    state.last_updated = now;

    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_stop_session() -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_stop_session");
        poisoned.into_inner()
    });

    if let Some(session) = state.current_session.as_mut() {
        session.is_active = false;
        session.completed_at = Some(now_ms());
    }

    state.last_updated = now_ms();
    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_update_file_progress(
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<String>,
) -> Result<Option<SyncFile>, String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_update_file_progress");
        poisoned.into_inner()
    });

    let now = now_ms();

    let session = match state.current_session.as_mut() {
        Some(s) => s,
        None => return Ok(None),
    };

    let lbl = label.unwrap_or_else(|| "default".to_string());
    let file = session
        .files
        .entry(path.clone())
        .or_insert_with(|| SyncFile {
            id: generate_file_id(&path),
            path: path.clone(),
            file_name: extract_file_name(&path),
            label: lbl.clone(),
            action: action.clone(),
            status: FileStatus::Pending,
            progress: 0,
            bytes_transferred: 0,
            total_bytes: 0,
            started_at: now,
            completed_at: None,
            error: None,
        });

    file.bytes_transferred = bytes_transferred;
    file.total_bytes = total_bytes;

    if total_bytes > 0 {
        file.progress = ((bytes_transferred as f64 / total_bytes as f64) * 100.0).min(100.0) as u32;
    }

    // Update status based on progress
    if bytes_transferred >= total_bytes && total_bytes > 0 {
        file.status = FileStatus::Completed;
        file.progress = 100;
        file.completed_at = Some(now);
    } else {
        file.status = match action {
            FileAction::Upload => FileStatus::Uploading,
            FileAction::Download => FileStatus::Downloading,
            FileAction::LocalDelete | FileAction::RemoteDelete => FileStatus::Deleting,
        };
    }

    let result = file.clone();
    state.last_updated = now;

    drop(state);
    emit_snapshot_inner(false);
    Ok(Some(result))
}

#[tauri::command]
pub fn sp_complete_pending_files() -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_complete_pending_files");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        for file in session.files.values_mut() {
            if file.status == FileStatus::Pending
                || file.status == FileStatus::Uploading
                || file.status == FileStatus::Downloading
                || file.status == FileStatus::Deleting
            {
                // Files that never received any progress data (0 bytes
                // transferred) are stalled — mark them as errors so the
                // UI doesn't show them stuck at 0% forever.
                if file.bytes_transferred == 0 {
                    file.status = FileStatus::Error;
                    file.error = Some("Transfer stalled – no data received".to_string());
                    file.completed_at = Some(now);
                } else {
                    file.status = FileStatus::Completed;
                    file.progress = 100;
                    file.completed_at = Some(now);
                    if file.total_bytes > 0 {
                        file.bytes_transferred = file.total_bytes;
                    }
                }
            }
        }
    }

    state.last_updated = now;
    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_mark_pending_files_as_failed(
    actual_uploads: u32,
    actual_downloads: u32,
) -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_mark_pending_files_as_failed");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        // If we have more pending than actual, mark the excess as failed
        let excess_uploads = if actual_uploads < session.expected_uploads {
            session.expected_uploads - actual_uploads
        } else {
            0
        };
        let excess_downloads = if actual_downloads < session.expected_downloads {
            session.expected_downloads - actual_downloads
        } else {
            0
        };

        let mut failed_uploads = 0u32;
        let mut failed_downloads = 0u32;

        // Collect keys first to avoid borrow issues
        let keys: Vec<String> = session.files.keys().cloned().collect();
        for key in keys {
            if let Some(file) = session.files.get_mut(&key) {
                if file.action == FileAction::Upload
                    && (file.status == FileStatus::Pending || file.status == FileStatus::Uploading)
                    && failed_uploads < excess_uploads
                {
                    file.status = FileStatus::Error;
                    file.error = Some("Upload did not complete".to_string());
                    file.completed_at = Some(now);
                    failed_uploads += 1;
                } else if file.action == FileAction::Download
                    && (file.status == FileStatus::Pending
                        || file.status == FileStatus::Downloading)
                    && failed_downloads < excess_downloads
                {
                    file.status = FileStatus::Error;
                    file.error = Some("Download did not complete".to_string());
                    file.completed_at = Some(now);
                    failed_downloads += 1;
                }
            }
        }

        // Also complete remaining pending uploads/downloads that weren't marked failed
        // (these are the ones that actually succeeded)
        for file in session.files.values_mut() {
            if (file.action == FileAction::Upload
                && (file.status == FileStatus::Pending || file.status == FileStatus::Uploading))
                || (file.action == FileAction::Download
                    && (file.status == FileStatus::Pending
                        || file.status == FileStatus::Downloading))
            {
                file.status = FileStatus::Completed;
                file.progress = 100;
                file.completed_at = Some(now);
                if file.total_bytes > 0 {
                    file.bytes_transferred = file.total_bytes;
                }
            }
        }
    }

    state.last_updated = now;
    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_mark_all_pending_files_as_failed(error_message: String) -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_mark_all_pending_files_as_failed");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        for file in session.files.values_mut() {
            if file.status == FileStatus::Pending
                || file.status == FileStatus::Uploading
                || file.status == FileStatus::Downloading
                || file.status == FileStatus::Deleting
            {
                file.status = FileStatus::Error;
                file.error = Some(error_message.clone());
                file.completed_at = Some(now);
            }
        }
    }

    state.last_updated = now;
    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_mark_file_error(path: String, error: String) -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_mark_file_error");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        if let Some(file) = session.files.get_mut(&path) {
            file.status = FileStatus::Error;
            file.error = Some(error);
            file.completed_at = Some(now);
        }
    }

    state.last_updated = now;
    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}


#[tauri::command]
pub fn sp_get_overall_progress() -> Result<OverallProgress, String> {
    let state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_get_overall_progress");
        poisoned.into_inner()
    });

    let session = match state.current_session.as_ref() {
        Some(s) => s,
        None => {
            return Ok(OverallProgress {
                is_active: false,
                total_files: 0,
                completed_files: 0,
                in_progress_files: 0,
                failed_files: 0,
                overall_percent: 0,
                total_bytes_transferred: 0,
                total_bytes_expected: 0,
                current_file: None,
            });
        }
    };

    // Single pass over all files to collect counts, byte totals, and
    // the current in-progress file for display.
    let total_files = session.files.len();
    let mut completed_files: usize = 0;
    let mut in_progress_files: usize = 0;
    let mut failed_files: usize = 0;
    let mut total_bytes_transferred: u64 = 0;
    let mut total_bytes_expected: u64 = 0;
    let mut current_file: Option<SyncFile> = None;

    for f in session.files.values() {
        match f.status {
            FileStatus::Completed => completed_files += 1,
            FileStatus::Uploading | FileStatus::Downloading | FileStatus::Deleting => {
                in_progress_files += 1;
                if !should_hide_file(&f.path) {
                    let dominated = current_file
                        .as_ref()
                        .map_or(true, |cur| f.started_at > cur.started_at);
                    if dominated {
                        current_file = Some(f.clone());
                    }
                }
            }
            FileStatus::Error => failed_files += 1,
            _ => {}
        }
        if f.total_bytes > 0 {
            total_bytes_transferred += f.bytes_transferred;
            total_bytes_expected += f.total_bytes;
        }
    }

    // Byte-weighted progress so the percentage matches the "X MB / Y MB"
    // display.
    let overall_percent = if total_files == 0 {
        0u32
    } else if completed_files + failed_files == total_files {
        100
    } else if total_bytes_expected > 0 {
        let pct = (total_bytes_transferred as f64 / total_bytes_expected as f64) * 100.0;
        (pct.round() as u32).min(100)
    } else {
        let pct = (completed_files as f64 / total_files as f64) * 100.0;
        (pct.round() as u32).min(100)
    };

    Ok(OverallProgress {
        is_active: session.is_active,
        total_files,
        completed_files,
        in_progress_files,
        failed_files,
        overall_percent,
        total_bytes_transferred,
        total_bytes_expected,
        current_file,
    })
}


#[tauri::command]
pub fn sp_record_deleted_file(file_name: String, size_bytes: u64) -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_record_deleted_file");
        poisoned.into_inner()
    });

    let now = now_ms();
    let session_id = state
        .current_session
        .as_ref()
        .map(|s| s.session_id.clone())
        .unwrap_or_else(|| "no_session".to_string());

    let display_name = if is_encrypted_file_id(&file_name) {
        "Encrypted file".to_string()
    } else {
        file_name.clone()
    };

    let recent = RecentFile {
        id: generate_file_id(&file_name),
        path: file_name.clone(),
        file_name: display_name,
        label: String::new(),
        action: FileAction::LocalDelete,
        completed_at: now,
        size_bytes,
        session_id,
    };

    state.recent_files.push(recent);
    clean_expired(&mut state);
    state.last_updated = now;

    Ok(())
}

/// Remove all files for a given drive label from the current session.
/// Completed files are moved to recent; remaining files are dropped.
#[tauri::command]
pub fn sp_remove_files_for_label(label: String) -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_remove_files_for_label");
        poisoned.into_inner()
    });

    let now = now_ms();

    // Collect new recent files first, then mutate
    let new_recent: Vec<RecentFile> = if let Some(session) = &state.current_session {
        let session_id = &session.session_id;

        let existing: std::collections::HashSet<(&str, &str)> = state
            .recent_files
            .iter()
            .map(|r| (r.path.as_str(), r.session_id.as_str()))
            .collect();

        session
            .files
            .values()
            .filter(|f| f.label == label && f.status == FileStatus::Completed)
            .filter(|f| !existing.contains(&(f.path.as_str(), session_id.as_str())))
            .map(|f| RecentFile {
                id: f.id.clone(),
                path: f.path.clone(),
                file_name: f.file_name.clone(),
                label: f.label.clone(),
                action: f.action.clone(),
                completed_at: f.completed_at.unwrap_or(now),
                size_bytes: f.total_bytes,
                session_id: session_id.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };

    state.recent_files.extend(new_recent);

    // Remove all files with this label from the session
    if let Some(session) = state.current_session.as_mut() {
        session.files.retain(|_, f| f.label != label);
    }

    clean_expired(&mut state);
    state.last_updated = now;

    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_clear_all_data() -> Result<(), String> {
    let mut state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_clear_all_data");
        poisoned.into_inner()
    });

    state.current_session = None;
    state.recent_files.clear();
    state.last_updated = now_ms();

    drop(state);
    emit_snapshot_inner(true);
    Ok(())
}

#[tauri::command]
pub fn sp_get_snapshot() -> Result<SyncSnapshot, String> {
    let state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_get_snapshot");
        poisoned.into_inner()
    });
    Ok(build_snapshot(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: reset global state before each test.
    fn reset_state() {
        let mut state = SYNC_PROGRESS.lock().unwrap();
        state.current_session = None;
        state.recent_files.clear();
        state.last_updated = now_ms();
    }

    /// Create a SyncFile for testing with common defaults.
    fn make_file(
        path: &str,
        total_bytes: u64,
        action: FileAction,
        status: FileStatus,
        bytes_transferred: u64,
    ) -> SyncFile {
        SyncFile {
            id: generate_file_id(path),
            path: path.to_string(),
            file_name: extract_file_name(path),
            label: "default".to_string(),
            action,
            status: status.clone(),
            progress: if total_bytes > 0 {
                ((bytes_transferred as f64 / total_bytes as f64) * 100.0)
                    as u32
            } else {
                0
            },
            bytes_transferred,
            total_bytes,
            started_at: now_ms(),
            completed_at: if status == FileStatus::Completed {
                Some(now_ms())
            } else {
                None
            },
            error: None,
        }
    }

    /// Create a SyncProgressState with the given files in an active session.
    fn state_with_files(files: Vec<SyncFile>) -> SyncProgressState {
        let mut file_map = HashMap::new();
        for f in files {
            file_map.insert(f.path.clone(), f);
        }
        SyncProgressState {
            current_session: Some(SyncSession {
                session_id: "test_session".to_string(),
                started_at: now_ms(),
                completed_at: None,
                is_active: true,
                expected_uploads: 0,
                expected_downloads: 0,
                expected_local_deletes: 0,
                expected_remote_deletes: 0,
                files: file_map,
            }),
            recent_files: Vec::new(),
            last_updated: now_ms(),
        }
    }

    // ── build_snapshot tests ─────────────────────────────────────────

    #[test]
    fn snapshot_sorts_biggest_first() {
        let state = state_with_files(vec![
            make_file(
                "/small.txt",
                100,
                FileAction::Upload,
                FileStatus::Pending,
                0,
            ),
            make_file(
                "/big.zip",
                50_000,
                FileAction::Upload,
                FileStatus::Pending,
                0,
            ),
            make_file(
                "/medium.pdf",
                5_000,
                FileAction::Download,
                FileStatus::Pending,
                0,
            ),
        ]);
        let snapshot = build_snapshot(&state);
        assert_eq!(snapshot.files.len(), 3);
        assert_eq!(snapshot.files[0].file_name, "big.zip");
        assert_eq!(snapshot.files[1].file_name, "medium.pdf");
        assert_eq!(snapshot.files[2].file_name, "small.txt");
    }

    #[test]
    fn snapshot_unknown_size_files_last() {
        let state = state_with_files(vec![
            make_file(
                "/known.txt",
                500,
                FileAction::Upload,
                FileStatus::Pending,
                0,
            ),
            make_file(
                "/unknown.dat",
                0,
                FileAction::Download,
                FileStatus::Pending,
                0,
            ),
            make_file(
                "/also_known.pdf",
                200,
                FileAction::Upload,
                FileStatus::Pending,
                0,
            ),
        ]);
        let snapshot = build_snapshot(&state);
        assert_eq!(snapshot.files[0].file_name, "known.txt");
        assert_eq!(snapshot.files[1].file_name, "also_known.pdf");
        assert_eq!(snapshot.files[2].file_name, "unknown.dat");
    }

    #[test]
    fn snapshot_overall_percent_byte_weighted() {
        let state = state_with_files(vec![
            make_file(
                "/a.txt",
                1000,
                FileAction::Upload,
                FileStatus::Uploading,
                800,
            ),
            make_file(
                "/b.txt",
                4000,
                FileAction::Upload,
                FileStatus::Uploading,
                200,
            ),
        ]);
        let snapshot = build_snapshot(&state);
        assert_eq!(snapshot.bytes_transferred, 1000);
        assert_eq!(snapshot.bytes_expected, 5000);
        assert_eq!(snapshot.overall_percent, 20);
    }

    #[test]
    fn snapshot_100_when_all_completed() {
        let state = state_with_files(vec![
            make_file(
                "/a.txt",
                1000,
                FileAction::Upload,
                FileStatus::Completed,
                1000,
            ),
            make_file(
                "/b.txt",
                2000,
                FileAction::Download,
                FileStatus::Completed,
                2000,
            ),
        ]);
        let snapshot = build_snapshot(&state);
        assert_eq!(snapshot.overall_percent, 100);
        assert_eq!(snapshot.completed_files, 2);
        assert_eq!(snapshot.total_files, 2);
    }

    #[test]
    fn snapshot_100_when_all_completed_or_failed() {
        let state = state_with_files(vec![
            make_file(
                "/a.txt",
                1000,
                FileAction::Upload,
                FileStatus::Completed,
                1000,
            ),
            make_file(
                "/b.txt",
                2000,
                FileAction::Upload,
                FileStatus::Error,
                500,
            ),
        ]);
        let snapshot = build_snapshot(&state);
        assert_eq!(snapshot.overall_percent, 100);
        assert_eq!(snapshot.completed_files, 1);
        assert_eq!(snapshot.failed_files, 1);
    }

    #[test]
    fn snapshot_empty_when_no_session() {
        let state = SyncProgressState {
            current_session: None,
            recent_files: Vec::new(),
            last_updated: now_ms(),
        };
        let snapshot = build_snapshot(&state);
        assert!(!snapshot.is_active);
        assert_eq!(snapshot.total_files, 0);
        assert_eq!(snapshot.overall_percent, 0);
        assert!(snapshot.files.is_empty());
    }

    #[test]
    fn snapshot_maps_status_correctly() {
        let state = state_with_files(vec![
            make_file(
                "/pending.txt",
                100,
                FileAction::Upload,
                FileStatus::Pending,
                0,
            ),
            make_file(
                "/uploading.txt",
                100,
                FileAction::Upload,
                FileStatus::Uploading,
                50,
            ),
            make_file(
                "/downloading.txt",
                100,
                FileAction::Download,
                FileStatus::Downloading,
                50,
            ),
            make_file(
                "/deleting.txt",
                100,
                FileAction::LocalDelete,
                FileStatus::Deleting,
                0,
            ),
            make_file(
                "/completed.txt",
                100,
                FileAction::Upload,
                FileStatus::Completed,
                100,
            ),
            make_file(
                "/error.txt",
                100,
                FileAction::Upload,
                FileStatus::Error,
                0,
            ),
        ]);
        let snapshot = build_snapshot(&state);
        let find = |name: &str| {
            snapshot
                .files
                .iter()
                .find(|f| f.file_name == name)
                .unwrap()
        };
        assert_eq!(
            find("pending.txt").status,
            FileProgressStatus::Pending
        );
        assert_eq!(
            find("uploading.txt").status,
            FileProgressStatus::InProgress
        );
        assert_eq!(
            find("downloading.txt").status,
            FileProgressStatus::InProgress
        );
        assert_eq!(
            find("deleting.txt").status,
            FileProgressStatus::InProgress
        );
        assert_eq!(
            find("completed.txt").status,
            FileProgressStatus::Completed
        );
        assert_eq!(
            find("error.txt").status,
            FileProgressStatus::Error
        );
    }

    #[test]
    fn snapshot_encrypted_file_name_detected() {
        let state = state_with_files(vec![make_file(
            "file_a7339456c25845c2deadbeef0123",
            500,
            FileAction::Download,
            FileStatus::Downloading,
            100,
        )]);
        let snapshot = build_snapshot(&state);
        assert_eq!(snapshot.files[0].file_name, "Encrypted file");
    }

    #[test]
    fn complete_session_keeps_inactive_session() {
        reset_state();

        // Start a session with 1 upload
        let file_list = SessionFileList {
            upload_files: Some(vec!["/test/file.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(file_list), Some("drive1".to_string())).unwrap();

        // Complete the file
        sp_update_file_progress(
            "/test/file.txt".to_string(),
            100,
            100,
            FileAction::Upload,
            Some("drive1".to_string()),
        )
        .unwrap();

        // Complete the session
        sp_complete_session(1, 0).unwrap();

        // Session should still exist (inactive) so the UI can show
        // completed state via overallProgress. It gets replaced on
        // the next sp_start_session call.
        let state = SYNC_PROGRESS.lock().unwrap();
        let session = state.current_session.as_ref().expect("Session should be kept");
        assert!(!session.is_active, "Session should be inactive");
        assert!(
            session.files.values().all(|f| f.status == FileStatus::Completed),
            "All files should be completed"
        );
        // File should also be in recent
        assert!(!state.recent_files.is_empty());
    }

    #[test]
    fn start_session_replaces_completed_session() {
        reset_state();

        // Create and complete a session
        let file_list = SessionFileList {
            upload_files: Some(vec!["/test/old.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();
        sp_update_file_progress(
            "/test/old.txt".to_string(),
            50,
            50,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();
        sp_complete_session(1, 0).unwrap();

        // Start a new session — old completed files should move to recent
        let new_list = SessionFileList {
            upload_files: Some(vec!["/test/new.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(new_list), Some("d1".to_string())).unwrap();

        let state = SYNC_PROGRESS.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        assert!(session.is_active);
        assert!(session.files.contains_key("/test/new.txt"));
        assert!(!session.files.contains_key("/test/old.txt"));
        // Old file should be in recent
        assert!(state.recent_files.iter().any(|r| r.path == "/test/old.txt"));
    }

    #[test]
    fn completed_session_still_reports_files_in_snapshot() {
        reset_state();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/test/a.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();
        sp_update_file_progress(
            "/test/a.txt".to_string(),
            50,
            50,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();
        sp_complete_session(1, 0).unwrap();

        // Session is kept (inactive) so snapshot should still show files
        let snapshot = sp_get_snapshot().unwrap();
        assert!(snapshot.total_files > 0, "Completed session should still report files");

        // After clearing all data, snapshot should be empty
        sp_clear_all_data().unwrap();
        let snapshot = sp_get_snapshot().unwrap();
        assert_eq!(snapshot.total_files, 0, "No files after clear_all_data");
    }

    #[test]
    fn remove_files_for_label_only_removes_matching() {
        reset_state();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/drive1/a.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(file_list), Some("drive1".to_string())).unwrap();

        // Add files for a second drive
        let file_list2 = SessionFileList {
            upload_files: Some(vec!["/drive2/b.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_merge_into_session(1, 0, 0, 0, Some(file_list2), Some("drive2".to_string())).unwrap();

        // Complete drive1's file
        sp_update_file_progress(
            "/drive1/a.txt".to_string(),
            100,
            100,
            FileAction::Upload,
            Some("drive1".to_string()),
        )
        .unwrap();

        // Remove drive1 files
        sp_remove_files_for_label("drive1".to_string()).unwrap();

        let state = SYNC_PROGRESS.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();

        // drive2's file should still exist
        assert!(session.files.contains_key("/drive2/b.txt"));
        // drive1's file should be gone
        assert!(!session.files.contains_key("/drive1/a.txt"));
        // drive1's completed file should be in recent
        assert!(state.recent_files.iter().any(|r| r.path == "/drive1/a.txt"));
    }

    #[test]
    fn label_propagates_to_sync_file() {
        reset_state();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/myfile.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(file_list), Some("photos".to_string())).unwrap();

        let state = SYNC_PROGRESS.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        let file = session.files.get("/myfile.txt").unwrap();
        assert_eq!(file.label, "photos");
    }

    #[test]
    fn label_propagates_to_recent_file() {
        reset_state();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/myfile.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(file_list), Some("docs".to_string())).unwrap();
        sp_update_file_progress(
            "/myfile.txt".to_string(),
            100,
            100,
            FileAction::Upload,
            Some("docs".to_string()),
        )
        .unwrap();
        sp_complete_session(1, 0).unwrap();

        let state = SYNC_PROGRESS.lock().unwrap();
        let recent = state
            .recent_files
            .iter()
            .find(|r| r.path == "/myfile.txt")
            .unwrap();
        assert_eq!(recent.label, "docs");
    }

    #[test]
    fn overall_progress_counts_encrypted_downloads() {
        reset_state();

        // Start session with 1 upload and 1 download
        let file_list = SessionFileList {
            upload_files: Some(vec!["/photo.jpg".to_string()]),
            download_files: Some(vec![
                "file_a7339456c25845c2deadbeef0123".to_string(),
            ]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 1, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // Upload is 50% done
        sp_update_file_progress(
            "/photo.jpg".to_string(),
            500,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let progress = sp_get_overall_progress().unwrap();
        // Both files should be counted (including the encrypted download)
        assert_eq!(progress.total_files, 2);
        assert_eq!(progress.in_progress_files, 1);
        // Byte-weighted: 500/1000 bytes transferred = 50%.
        // The encrypted download has no size data yet, so only the
        // upload's bytes contribute to the ratio.
        assert_eq!(progress.overall_percent, 50);
    }

    #[test]
    fn snapshot_includes_encrypted_downloads_with_display_name() {
        reset_state();

        let file_list = SessionFileList {
            upload_files: None,
            download_files: Some(vec![
                "file_a7339456c25845c2deadbeef0123".to_string(),
            ]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(0, 1, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        let snapshot = sp_get_snapshot().unwrap();
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].file_name, "Encrypted file");
    }

    #[test]
    fn overall_percent_reaches_100_after_force_complete() {
        reset_state();

        // Register 2 files, both with progress data
        let file_list = SessionFileList {
            upload_files: Some(vec![
                "/a.txt".to_string(),
                "/b.txt".to_string(),
            ]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(2, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // File A reports partial progress
        sp_update_file_progress(
            "/a.txt".to_string(),
            500,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // File B reports partial progress too
        sp_update_file_progress(
            "/b.txt".to_string(),
            200,
            400,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // Force-complete all pending files
        sp_complete_pending_files().unwrap();

        let progress = sp_get_overall_progress().unwrap();
        assert_eq!(progress.completed_files, 2);
        // All files are completed, so overall_percent should be 100
        assert_eq!(progress.overall_percent, 100);
    }

    #[test]
    fn complete_pending_marks_stalled_files_as_error() {
        reset_state();

        // Register 3 files: one completes, one has partial progress,
        // one never receives any progress data (stalled).
        let file_list = SessionFileList {
            upload_files: Some(vec![
                "/completed.txt".to_string(),
                "/partial.txt".to_string(),
                "/stalled.txt".to_string(),
            ]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(3, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // File 1: fully transferred (auto-completes in update)
        sp_update_file_progress(
            "/completed.txt".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // File 2: partial progress (bytes_transferred > 0)
        sp_update_file_progress(
            "/partial.txt".to_string(),
            500,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // File 3 (/stalled.txt): never receives progress — stays Pending
        // with bytes_transferred == 0.

        // Force-complete all pending files
        sp_complete_pending_files().unwrap();

        let state = SYNC_PROGRESS.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();

        // Completed file stays Completed
        let completed = session.files.get("/completed.txt").unwrap();
        assert_eq!(completed.status, FileStatus::Completed);

        // Partial file gets Completed (had some progress)
        let partial = session.files.get("/partial.txt").unwrap();
        assert_eq!(partial.status, FileStatus::Completed);
        assert_eq!(partial.progress, 100);

        // Stalled file gets Error (0 bytes transferred)
        let stalled = session.files.get("/stalled.txt").unwrap();
        assert_eq!(stalled.status, FileStatus::Error);
        assert!(stalled.error.as_ref().unwrap().contains("stalled"));
    }

    // ── Encrypted file detection ──────────────────────────────────────

    #[test]
    fn file_hex_prefix_is_encrypted() {
        assert!(is_encrypted_file_id("file_abcdef0123456789"));
    }

    #[test]
    fn pure_hex_20_plus_chars_is_encrypted() {
        assert!(is_encrypted_file_id("abcdef0123456789abcd"));
    }

    #[test]
    fn hex_16_chars_no_dot_is_encrypted() {
        assert!(is_encrypted_file_id("abcdef0123456789"));
    }

    #[test]
    fn normal_filename_is_not_encrypted() {
        assert!(!is_encrypted_file_id("document.pdf"));
    }

    #[test]
    fn hex_with_dot_is_not_encrypted() {
        assert!(!is_encrypted_file_id("abcdef0123456789.txt"));
    }

    #[test]
    fn short_hex_is_not_encrypted() {
        assert!(!is_encrypted_file_id("abcdef"));
    }

    #[test]
    fn empty_string_is_not_encrypted() {
        assert!(!is_encrypted_file_id(""));
    }

    // ── File ID generation ────────────────────────────────────────────

    #[test]
    fn file_id_is_deterministic() {
        let id1 = generate_file_id("/home/user/photos/sunset.jpg");
        let id2 = generate_file_id("/home/user/photos/sunset.jpg");
        assert_eq!(id1, id2);
    }

    #[test]
    fn file_id_differs_for_different_paths() {
        let id1 = generate_file_id("/home/user/a.txt");
        let id2 = generate_file_id("/home/user/b.txt");
        assert_ne!(id1, id2);
    }

    // ── extract_file_name ─────────────────────────────────────────────

    #[test]
    fn extract_name_returns_encrypted_for_hex() {
        let name = extract_file_name("abcdef0123456789abcd");
        assert_eq!(name, "Encrypted file");
    }

    #[test]
    fn extract_name_returns_original_for_normal() {
        let name = extract_file_name("readme.md");
        assert_eq!(name, "readme.md");
    }

    // ── Monotonic progress (high-water mark) ─────────────────────────

    #[test]
    fn overall_percent_reflects_actual_byte_ratio() {
        reset_state();

        // Start with 1 file at 80% progress
        let file_list = SessionFileList {
            upload_files: Some(vec!["/a.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        sp_update_file_progress(
            "/a.txt".to_string(),
            800,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let p1 = sp_get_overall_progress().unwrap();
        assert_eq!(p1.overall_percent, 80);

        // Merge a large file — this dilutes byte progress:
        // 800 / (1000 + 10000) = 7%. The percent correctly reflects
        // the actual transfer state rather than staying frozen at 80.
        let merge_list = SessionFileList {
            upload_files: Some(vec!["/big.bin".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_merge_into_session(1, 0, 0, 0, Some(merge_list), Some("d1".to_string()))
            .unwrap();

        sp_update_file_progress(
            "/big.bin".to_string(),
            0,
            10000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let p2 = sp_get_overall_progress().unwrap();
        assert_eq!(p2.total_files, 2);
        // 800 / 11000 = 7.27% → rounds to 7
        assert_eq!(p2.overall_percent, 7);
        // Bytes display matches: 800 transferred, 11000 expected
        assert_eq!(p2.total_bytes_transferred, 800);
        assert_eq!(p2.total_bytes_expected, 11000);
    }

    #[test]
    fn overall_percent_reaches_100_when_all_finished() {
        reset_state();

        // 3 files: all completed → must be exactly 100, not 99
        let file_list = SessionFileList {
            upload_files: Some(vec![
                "/a.txt".to_string(),
                "/b.txt".to_string(),
                "/c.txt".to_string(),
            ]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(3, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        for path in ["/a.txt", "/b.txt", "/c.txt"] {
            sp_update_file_progress(
                path.to_string(),
                1000,
                1000,
                FileAction::Upload,
                Some("d1".to_string()),
            )
            .unwrap();
        }

        let p = sp_get_overall_progress().unwrap();
        assert_eq!(p.overall_percent, 100);
    }

    #[test]
    fn overall_percent_100_when_all_known_bytes_transferred() {
        reset_state();

        // 2 files: both in-progress at 100% bytes but not marked Completed
        // (simulating edge case where bytes match but status hasn't flipped)
        let file_list = SessionFileList {
            upload_files: Some(vec![
                "/a.txt".to_string(),
                "/b.txt".to_string(),
            ]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        sp_start_session(2, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // Only update one file — the other stays Pending
        sp_update_file_progress(
            "/a.txt".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let p = sp_get_overall_progress().unwrap();
        // /a.txt auto-completed (1000/1000), /b.txt still Pending (no bytes).
        // Byte-weighted: 1000/1000 = 100%. No artificial cap — when all
        // known bytes are transferred the bar reaches 100%.
        assert_eq!(p.overall_percent, 100);
    }
}
