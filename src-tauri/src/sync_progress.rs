//! In-memory sync progress tracking.
//!
//! Replaces the frontend's localStorage-based `syncProgressService.ts`.
//! All state is transient (not persisted to SQLite) — it only lives for the
//! duration of the app process. Uses a global `Mutex<SyncProgressState>`
//! following the same pattern as `sync_shared.rs`.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

// ── Constants ──────────────────────────────────────────────────────────

const RECENT_FILES_RETENTION_MS: i64 = 60 * 60 * 1000; // 1 hour
const TRAY_MENU_MAX_FILES: usize = 20;

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

// ── Global State ───────────────────────────────────────────────────────

pub static SYNC_PROGRESS: Lazy<Mutex<SyncProgressState>> = Lazy::new(|| {
    Mutex::new(SyncProgressState {
        current_session: None,
        recent_files: Vec::new(),
        last_updated: now_ms(),
    })
});

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
    if file_name.starts_with("file_") && file_name.len() > 5 && file_name[5..].chars().all(|c| c.is_ascii_hexdigit()) {
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
fn register_files(session: &mut SyncSession, file_list: &SessionFileList) {
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
            action: f.action.clone(),
            completed_at: f.completed_at.unwrap_or(now),
            size_bytes: f.total_bytes,
            session_id: session_id.clone(),
        })
        .collect();

    state.recent_files.extend(new_completed);
    clean_expired(state);
}

// ── Tauri Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn sp_start_session(
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
) -> Result<SyncSession, String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // If there's an existing active session, move its completed files to recent
    if state
        .current_session
        .as_ref()
        .is_some_and(|s| s.is_active)
    {
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

    if let Some(fl) = &file_list {
        register_files(&mut session, fl);
    }

    let result = session.clone();
    state.current_session = Some(session);
    state.last_updated = now;

    Ok(result)
}

#[tauri::command]
pub fn sp_merge_into_session(
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
) -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut().filter(|s| s.is_active) {
        // Merge into existing session
        session.expected_uploads += expected_uploads;
        session.expected_downloads += expected_downloads;
        session.expected_local_deletes += expected_local_deletes;
        session.expected_remote_deletes += expected_remote_deletes;

        if let Some(fl) = &file_list {
            register_files(session, fl);
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
            register_files(&mut session, fl);
        }

        state.current_session = Some(session);
    }

    state.last_updated = now;
    Ok(())
}

#[tauri::command]
pub fn sp_complete_session(files_uploaded: u32, files_downloaded: u32) -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

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
                }
            }
        }

        // If no more pending work, finalize
        if pending_uploads == 0
            && pending_downloads == 0
            || (files_uploaded >= session.expected_uploads
                && files_downloaded >= session.expected_downloads)
        {
            session.completed_at = Some(now);
            session.is_active = false;
        }
    }

    // Move completed files to recent
    move_completed_to_recent(&mut state);
    state.last_updated = now;

    Ok(())
}

#[tauri::command]
pub fn sp_stop_session() -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(session) = state.current_session.as_mut() {
        session.is_active = false;
        session.completed_at = Some(now_ms());
    }

    state.last_updated = now_ms();
    Ok(())
}

#[tauri::command]
pub fn sp_update_file_progress(
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
) -> Result<Option<SyncFile>, String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let now = now_ms();

    let session = match state.current_session.as_mut() {
        Some(s) => s,
        None => return Ok(None),
    };

    let file = session.files.entry(path.clone()).or_insert_with(|| SyncFile {
        id: generate_file_id(&path),
        path: path.clone(),
        file_name: extract_file_name(&path),
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

    Ok(Some(result))
}

#[tauri::command]
pub fn sp_complete_pending_files() -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        for file in session.files.values_mut() {
            if file.status == FileStatus::Pending
                || file.status == FileStatus::Uploading
                || file.status == FileStatus::Downloading
                || file.status == FileStatus::Deleting
            {
                file.status = FileStatus::Completed;
                file.progress = 100;
                file.completed_at = Some(now);
            }
        }
    }

    state.last_updated = now;
    Ok(())
}

#[tauri::command]
pub fn sp_mark_pending_files_as_failed(
    actual_uploads: u32,
    actual_downloads: u32,
) -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

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
            }
        }
    }

    state.last_updated = now;
    Ok(())
}

#[tauri::command]
pub fn sp_mark_all_pending_files_as_failed(error_message: String) -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

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
    Ok(())
}

#[tauri::command]
pub fn sp_mark_file_error(path: String, error: String) -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        if let Some(file) = session.files.get_mut(&path) {
            file.status = FileStatus::Error;
            file.error = Some(error);
            file.completed_at = Some(now);
        }
    }

    state.last_updated = now;
    Ok(())
}

#[tauri::command]
pub fn sp_get_session_files() -> Result<Vec<SyncFile>, String> {
    let state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let files = match &state.current_session {
        Some(session) => session
            .files
            .values()
            .filter(|f| !should_hide_file(&f.path))
            .cloned()
            .collect(),
        None => Vec::new(),
    };

    Ok(files)
}

#[tauri::command]
pub fn sp_get_recent_files() -> Result<Vec<RecentFile>, String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    clean_expired(&mut state);

    let files: Vec<RecentFile> = state
        .recent_files
        .iter()
        .filter(|f| !should_hide_file(&f.path))
        .cloned()
        .collect();

    Ok(files)
}

#[tauri::command]
pub fn sp_get_tray_menu_files() -> Result<Vec<serde_json::Value>, String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    clean_expired(&mut state);

    let mut items: Vec<serde_json::Value> = Vec::new();

    // Add active session files first (in-progress ones prioritized)
    if let Some(session) = &state.current_session {
        let mut session_files: Vec<&SyncFile> = session
            .files
            .values()
            .filter(|f| !should_hide_file(&f.path))
            .collect();

        // Sort: in-progress first, then by started_at descending
        session_files.sort_by(|a, b| {
            let a_active = matches!(
                a.status,
                FileStatus::Uploading | FileStatus::Downloading | FileStatus::Deleting
            );
            let b_active = matches!(
                b.status,
                FileStatus::Uploading | FileStatus::Downloading | FileStatus::Deleting
            );
            b_active.cmp(&a_active).then(b.started_at.cmp(&a.started_at))
        });

        for file in session_files.iter().take(TRAY_MENU_MAX_FILES) {
            if let Ok(val) = serde_json::to_value(file) {
                items.push(val);
            }
        }
    }

    // Fill remaining slots with recent files
    let remaining = TRAY_MENU_MAX_FILES.saturating_sub(items.len());
    if remaining > 0 {
        let mut recent: Vec<&RecentFile> = state
            .recent_files
            .iter()
            .filter(|f| !should_hide_file(&f.path))
            .collect();
        recent.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));

        for file in recent.iter().take(remaining) {
            if let Ok(val) = serde_json::to_value(file) {
                items.push(val);
            }
        }
    }

    Ok(items)
}

#[tauri::command]
pub fn sp_get_overall_progress() -> Result<OverallProgress, String> {
    let state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let session = match &state.current_session {
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

    // Only consider visible (non-hidden) files
    let visible_files: Vec<&SyncFile> = session
        .files
        .values()
        .filter(|f| !should_hide_file(&f.path))
        .collect();

    let total_files = visible_files.len();

    let completed_files = visible_files
        .iter()
        .filter(|f| f.status == FileStatus::Completed)
        .count();

    let in_progress_files = visible_files
        .iter()
        .filter(|f| {
            matches!(
                f.status,
                FileStatus::Uploading | FileStatus::Downloading | FileStatus::Deleting
            )
        })
        .count();

    let failed_files = visible_files
        .iter()
        .filter(|f| f.status == FileStatus::Error)
        .count();

    let total_bytes_transferred: u64 = visible_files.iter().map(|f| f.bytes_transferred).sum();
    let total_bytes_expected: u64 = visible_files.iter().map(|f| f.total_bytes).sum();

    // Calculate overall percent
    let overall_percent = if total_files == 0 {
        0
    } else if total_bytes_expected > 0 {
        // Use byte-based progress when we have byte info
        ((total_bytes_transferred as f64 / total_bytes_expected as f64) * 100.0).min(100.0) as u32
    } else {
        // Fall back to file-count-based progress
        ((completed_files as f64 / total_files as f64) * 100.0) as u32
    };

    // Find the current in-progress file (most recently started)
    let current_file = visible_files
        .iter()
        .filter(|f| {
            matches!(
                f.status,
                FileStatus::Uploading | FileStatus::Downloading | FileStatus::Deleting
            )
        })
        .max_by_key(|f| f.started_at)
        .cloned()
        .cloned();

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
pub fn sp_has_any_sync_activity() -> Result<bool, String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    clean_expired(&mut state);

    let has_session = state
        .current_session
        .as_ref()
        .is_some_and(|s| s.is_active || !s.files.is_empty());

    let has_recent = !state.recent_files.is_empty();

    Ok(has_session || has_recent)
}

#[tauri::command]
pub fn sp_cleanup_expired_files() -> Result<u32, String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let before = state.recent_files.len();
    clean_expired(&mut state);
    let removed = before - state.recent_files.len();

    Ok(removed as u32)
}

#[tauri::command]
pub fn sp_record_deleted_file(file_name: String, size_bytes: u64) -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

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

#[tauri::command]
pub fn sp_clear_all_data() -> Result<(), String> {
    let mut state = SYNC_PROGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    state.current_session = None;
    state.recent_files.clear();
    state.last_updated = now_ms();

    Ok(())
}

#[tauri::command]
pub fn sp_is_encrypted_file_id(file_name: String) -> Result<bool, String> {
    Ok(is_encrypted_file_id(&file_name))
}

#[tauri::command]
pub fn sp_should_hide_file(path: String) -> Result<bool, String> {
    Ok(should_hide_file(&path))
}
