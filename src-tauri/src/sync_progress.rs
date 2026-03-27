//! In-memory sync progress tracking.
//!
//! Replaces the frontend's localStorage-based `syncProgressService.ts`.
//! All state is transient (not persisted to SQLite) — it only lives for the
//! duration of the app process. State is stored in `SyncEngine::progress`
//! (see `sync_engine.rs`) and accessed via `AppState::sync`.
//!
//! Each public function has two forms:
//! - An inner function (e.g. `start_session`) that takes `&SyncEngine` and
//!   contains the business logic. Called from both Tauri wrappers and Rust code.
//! - A `#[tauri::command]` wrapper (e.g. `sp_start_session`) that extracts the
//!   `SyncEngine` from `tauri::State<AppState>` and delegates to the inner fn.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
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
    Encrypting,
    Decrypting,
    Deleting,
    Completed,
    Error,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FileAction {
    Upload,
    Download,
    Encrypt,
    Decrypt,
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
    pub bytes_encrypted: u64,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub resumed_from_bytes: Option<u64>,
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
    pub progress_bytes: u64,
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
    Encrypting,
    Decrypting,
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
    pub bytes_encrypted: u64,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub resumed_from_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub is_active: bool,
    pub overall_percent: u32,
    /// Best progress bytes across all files (encrypt or transfer, whichever is
    /// further along per file). Always consistent with `overall_percent`.
    pub progress_bytes: u64,
    pub bytes_expected: u64,
    pub total_files: usize,
    pub completed_files: usize,
    pub failed_files: usize,
    /// When > 0, the sync engine is waiting to retry after a failure.
    /// Value is the number of seconds until the next retry attempt.
    pub retry_in_secs: u64,
    /// The error message from the last failed sync cycle, if any.
    pub last_error: Option<String>,
    /// Expected action counts from the session — drives UI text
    /// ("Uploading X of Y" vs "Downloading X of Y").
    pub expected_uploads: u32,
    pub expected_downloads: u32,
    pub expected_local_deletes: u32,
    pub expected_remote_deletes: u32,
    /// Epoch-ms when the session started.
    pub started_at: Option<i64>,
    /// Epoch-ms when the session completed (None if still active or no session).
    /// Frontend uses this for auto-dismiss timing.
    pub completed_at: Option<i64>,
    pub files: Vec<FileProgress>,
}

// Global state is stored in `SyncEngine` (see `sync_engine.rs`).
// Tauri commands access it via `AppState::sync`; Rust callers pass `&SyncEngine` directly.

// ── Helper Functions ───────────────────────────────────────────────────

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn generate_file_id(path: &str) -> String {
    let mut hash: i32 = 0;
    for ch in path.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as i32);
    }
    format!("file_{:x}", hash.unsigned_abs())
}

fn generate_session_id(sync: &crate::sync_engine::SyncEngine) -> String {
    format!(
        "session_{}_{}",
        now_ms(),
        sync.session_counter.fetch_add(1, Ordering::Relaxed)
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
/// For upload files (local paths), reads the file size from the filesystem
/// so the overall byte total is accurate from the start.
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
                    // Try to read file size from the local filesystem.
                    // Works for uploads (local files) and local deletes;
                    // returns 0 for downloads (remote identifiers) which
                    // gets filled in by the first progress callback.
                    let total_bytes = std::fs::metadata(path)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    let file = SyncFile {
                        id: generate_file_id(path),
                        path: path.clone(),
                        file_name: extract_file_name(path),
                        label: label.to_string(),
                        action: action.clone(),
                        status: FileStatus::Pending,
                        progress: 0,
                        bytes_encrypted: 0,
                        bytes_transferred: 0,
                        total_bytes,
                        resumed_from_bytes: None,
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
                progress_bytes: 0,
                bytes_expected: 0,
                total_files: 0,
                completed_files: 0,
                failed_files: 0,
                retry_in_secs: 0,
                last_error: None,
                expected_uploads: 0,
                expected_downloads: 0,
                expected_local_deletes: 0,
                expected_remote_deletes: 0,
                started_at: None,
                completed_at: None,
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
                FileStatus::Uploading | FileStatus::Downloading | FileStatus::Deleting => {
                    FileProgressStatus::InProgress
                }
                FileStatus::Encrypting => FileProgressStatus::Encrypting,
                FileStatus::Decrypting => FileProgressStatus::Decrypting,
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
                bytes_encrypted: f.bytes_encrypted,
                bytes_transferred: f.bytes_transferred,
                total_bytes: f.total_bytes,
                resumed_from_bytes: f.resumed_from_bytes,
                error: f.error.clone(),
            }
        })
        .collect();

    // Sort by status group (errors first, then in-progress, pending, completed)
    // then by size descending within each group.
    let status_rank = |s: &FileProgressStatus| -> u8 {
        match s {
            FileProgressStatus::Error => 0,
            FileProgressStatus::InProgress
            | FileProgressStatus::Encrypting
            | FileProgressStatus::Decrypting => 1,
            FileProgressStatus::Pending => 2,
            FileProgressStatus::Completed => 3,
        }
    };
    files.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then(b.total_bytes.cmp(&a.total_bytes))
    });

    // Single pass: collect file counts, byte totals, and per-file progress
    // contributions for the file-count weighted overall percent.
    let mut completed_files: usize = 0;
    let mut failed_files: usize = 0;
    let mut total_bytes_expected: u64 = 0;
    let mut total_progress_bytes: u64 = 0;
    let mut progress_sum: f64 = 0.0;

    for f in &files {
        match f.status {
            FileProgressStatus::Completed => {
                completed_files += 1;
                progress_sum += 1.0;
                if f.total_bytes > 0 {
                    total_bytes_expected += f.total_bytes;
                    total_progress_bytes += f.total_bytes;
                }
            }
            FileProgressStatus::Error => {
                failed_files += 1;
                // Error files don't contribute to progress_sum
                if f.total_bytes > 0 {
                    total_bytes_expected += f.total_bytes;
                }
            }
            _ => {
                // In-progress / pending / encrypting / decrypting:
                // contribute proportionally based on per-file progress.
                progress_sum += f.progress_percent as f64 / 100.0;
                if f.total_bytes > 0 {
                    total_bytes_expected += f.total_bytes;
                }
                // Only count actual transfer bytes (not encrypt/decrypt)
                // so the display shows real network progress.
                total_progress_bytes += f.bytes_transferred;
            }
        }
    }

    let total_files = files.len();

    // Byte-weighted progress when total bytes are known (consistent with
    // the "X MB / Y GB" display).  Falls back to file-count weighted when
    // file sizes are unavailable.
    let overall_percent = if total_files == 0 {
        0
    } else if failed_files == 0 && completed_files == total_files {
        100
    } else if total_bytes_expected > 0 {
        let pct = (total_progress_bytes as f64 / total_bytes_expected as f64) * 100.0;
        (pct.round() as u32).min(100)
    } else {
        let pct = (progress_sum / total_files as f64) * 100.0;
        (pct.round() as u32).min(100)
    };

    SyncSnapshot {
        is_active: session.is_active,
        overall_percent,
        progress_bytes: total_progress_bytes,
        bytes_expected: total_bytes_expected,
        total_files,
        completed_files,
        failed_files,
        retry_in_secs: 0,
        last_error: None,
        expected_uploads: session.expected_uploads,
        expected_downloads: session.expected_downloads,
        expected_local_deletes: session.expected_local_deletes,
        expected_remote_deletes: session.expected_remote_deletes,
        started_at: Some(session.started_at),
        completed_at: session.completed_at,
        files,
    }
}

// ── Inner Functions (business logic, callable from Rust and tests) ─────

/// Count the expected uploads and downloads for a specific drive label.
///
/// Used by `hcfs_drive.rs` to compare a single drive's actual sync counts
/// against only that drive's expected files, rather than the merged session
/// total across all drives.
pub fn count_expected_for_label(session: &SyncSession, label: &str) -> (u32, u32) {
    let uploads = session
        .files
        .values()
        .filter(|f| f.label == label && f.action == FileAction::Upload)
        .count() as u32;
    let downloads = session
        .files
        .values()
        .filter(|f| f.label == label && f.action == FileAction::Download)
        .count() as u32;
    (uploads, downloads)
}

/// Start a new sync session, moving any existing completed files to recent.
pub fn start_session(
    sync: &crate::sync_engine::SyncEngine,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<SyncSession, String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in start_session");
        poisoned.into_inner()
    });

    // Always move completed files from any existing session to recent
    // before replacing it, regardless of whether it was active or inactive.
    if state.current_session.is_some() {
        move_completed_to_recent(&mut state);
    }

    let now = now_ms();
    let mut session = SyncSession {
        session_id: generate_session_id(sync),
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
    sync.emit_snapshot(true);
    Ok(result)
}

// ── Tauri Commands (thin wrappers delegating to inner functions) ───────

#[tauri::command]
pub fn sp_start_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<SyncSession, String> {
    start_session(
        &state.sync,
        expected_uploads,
        expected_downloads,
        expected_local_deletes,
        expected_remote_deletes,
        file_list,
        label,
    )
}

/// Merge file expectations into the current active session, or start a new one.
pub fn merge_into_session(
    sync: &crate::sync_engine::SyncEngine,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in merge_into_session");
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
            session_id: generate_session_id(sync),
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
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_merge_into_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    expected_uploads: u32,
    expected_downloads: u32,
    expected_local_deletes: u32,
    expected_remote_deletes: u32,
    file_list: Option<SessionFileList>,
    label: Option<String>,
) -> Result<(), String> {
    merge_into_session(
        &state.sync,
        expected_uploads,
        expected_downloads,
        expected_local_deletes,
        expected_remote_deletes,
        file_list,
        label,
    )
}

/// Complete the current session, marking remaining files as done if counts match.
pub fn complete_session(
    sync: &crate::sync_engine::SyncEngine,
    files_uploaded: u32,
    files_downloaded: u32,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in complete_session");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        // Skip if the session is already inactive (e.g. no-op cycle where
        // on_sync_plan_ready returned total == 0, so no session was ever
        // created — the previous completed session is still here).  Don't
        // re-finalize or emit a snapshot, which would cause UI flicker.
        if !session.is_active {
            return Ok(());
        }

        // Check if there's still pending work
        let pending_uploads = session
            .files
            .values()
            .filter(|f| {
                f.action == FileAction::Upload
                    && (f.status == FileStatus::Pending
                        || f.status == FileStatus::Uploading
                        || f.status == FileStatus::Encrypting)
            })
            .count() as u32;
        let pending_downloads = session
            .files
            .values()
            .filter(|f| {
                f.action == FileAction::Download
                    && (f.status == FileStatus::Pending
                        || f.status == FileStatus::Downloading
                        || f.status == FileStatus::Decrypting)
            })
            .count() as u32;
        let pending_deletes = session
            .files
            .values()
            .filter(|f| {
                (f.action == FileAction::LocalDelete || f.action == FileAction::RemoteDelete)
                    && (f.status == FileStatus::Pending || f.status == FileStatus::Deleting)
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
                    || file.status == FileStatus::Encrypting
                    || file.status == FileStatus::Decrypting
                    || file.status == FileStatus::Deleting
                {
                    file.status = FileStatus::Completed;
                    file.progress = 100;
                    file.completed_at = Some(now);
                    // Sync bytes so overall percent reaches 100%
                    if file.total_bytes > 0 {
                        file.bytes_encrypted = file.total_bytes;
                        file.bytes_transferred = file.total_bytes;
                    }
                }
            }
        }

        // If no more pending work (including deletes), finalize
        if (pending_uploads == 0 && pending_downloads == 0 && pending_deletes == 0)
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
    // session is replaced when the next sync cycle calls start_session.

    state.last_updated = now;

    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_complete_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    files_uploaded: u32,
    files_downloaded: u32,
) -> Result<(), String> {
    complete_session(&state.sync, files_uploaded, files_downloaded)
}

/// Stop the current session, marking it as inactive.
pub fn stop_session(sync: &crate::sync_engine::SyncEngine) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in stop_session");
        poisoned.into_inner()
    });

    if let Some(session) = state.current_session.as_mut() {
        session.is_active = false;
        session.completed_at = Some(now_ms());
    }

    state.last_updated = now_ms();
    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_stop_session(state: tauri::State<'_, crate::app_state::AppState>) -> Result<(), String> {
    stop_session(&state.sync)
}

/// Update progress for a single file within the current session.
pub fn update_file_progress(
    sync: &crate::sync_engine::SyncEngine,
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<String>,
) -> Result<Option<SyncFile>, String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in update_file_progress");
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
            bytes_encrypted: 0,
            bytes_transferred: 0,
            total_bytes,
            resumed_from_bytes: None,
            started_at: now,
            completed_at: None,
            error: None,
        });

    // Set total_bytes once — file size doesn't change.
    if file.total_bytes == 0 && total_bytes > 0 {
        file.total_bytes = total_bytes;
    }

    // Update action so the UI knows the current phase.
    file.action = action.clone();

    // Detect resumed transfers: if the first upload/download progress
    // callback reports bytes > 0, the transfer is resuming from a
    // previous interruption (hcfs-client resumes from disk chunks or
    // HTTP Range offset).
    if file.resumed_from_bytes.is_none()
        && file.bytes_transferred == 0
        && bytes_transferred > 0
        && matches!(action, FileAction::Upload | FileAction::Download)
    {
        file.resumed_from_bytes = Some(bytes_transferred);
    }

    match action {
        FileAction::Encrypt | FileAction::Decrypt => {
            // Encrypt/decrypt: update bytes_encrypted (monotonic), don't touch bytes_transferred.
            file.bytes_encrypted = file.bytes_encrypted.max(bytes_transferred);
            if bytes_transferred >= total_bytes && total_bytes > 0 {
                file.bytes_encrypted = total_bytes;
            }
            // Don't overwrite Completed status — for downloads, the file is
            // already "done" once the transfer finishes.  Decrypt is local
            // post-processing and shouldn't reset the completed count.
            if file.status != FileStatus::Completed {
                file.status = match action {
                    FileAction::Encrypt => FileStatus::Encrypting,
                    _ => FileStatus::Decrypting,
                };
            }
        }
        _ => {
            // Upload/Download/Delete: update bytes_transferred (monotonic).
            file.bytes_transferred = file.bytes_transferred.max(bytes_transferred);
            if file.bytes_transferred >= file.total_bytes && file.total_bytes > 0 {
                file.status = FileStatus::Completed;
                file.progress = 100;
                file.completed_at = Some(now);
            } else {
                file.status = match action {
                    FileAction::Upload => FileStatus::Uploading,
                    FileAction::Download => FileStatus::Downloading,
                    _ => FileStatus::Deleting,
                };
            }
        }
    }

    // Progress is based on transfer bytes only — encrypt/decrypt phases
    // are invisible to the user.  During encryption the file shows 0%
    // (transfer hasn't started); during decryption it shows ~100%
    // (download already finished).  No backward drops.
    if file.status != FileStatus::Completed && file.total_bytes > 0 {
        file.progress = ((file.bytes_transferred as f64 / file.total_bytes as f64) * 100.0)
            .round()
            .min(100.0) as u32;
    }

    let result = file.clone();
    state.last_updated = now;

    drop(state);
    sync.emit_snapshot(false);
    Ok(Some(result))
}

#[tauri::command]
pub fn sp_update_file_progress(
    state: tauri::State<'_, crate::app_state::AppState>,
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<String>,
) -> Result<Option<SyncFile>, String> {
    update_file_progress(
        &state.sync,
        path,
        bytes_transferred,
        total_bytes,
        action,
        label,
    )
}

/// Force-complete all pending files. Stalled files (0 bytes) become errors,
/// except delete actions which never transfer bytes.
pub fn complete_pending_files(
    sync: &crate::sync_engine::SyncEngine,
    label: &str,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in complete_pending_files");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        for file in session.files.values_mut() {
            if file.label != label {
                continue;
            }
            if file.status == FileStatus::Pending
                || file.status == FileStatus::Uploading
                || file.status == FileStatus::Downloading
                || file.status == FileStatus::Encrypting
                || file.status == FileStatus::Decrypting
                || file.status == FileStatus::Deleting
            {
                let is_delete = file.action == FileAction::LocalDelete
                    || file.action == FileAction::RemoteDelete;

                // Files that never received any progress data (0 bytes
                // encrypted or transferred) are stalled — mark them as
                // errors so the UI doesn't show them stuck at 0% forever.
                // Delete actions never transfer bytes, so 0 is expected.
                if !is_delete && file.bytes_transferred == 0 && file.bytes_encrypted == 0 {
                    file.status = FileStatus::Error;
                    file.error = Some("Transfer stalled – no data received".to_string());
                    file.completed_at = Some(now);
                } else {
                    file.status = FileStatus::Completed;
                    file.progress = 100;
                    file.completed_at = Some(now);
                    if file.total_bytes > 0 {
                        file.bytes_encrypted = file.total_bytes;
                        file.bytes_transferred = file.total_bytes;
                    }
                }
            }
        }
    }

    state.last_updated = now;
    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_complete_pending_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    label: Option<String>,
) -> Result<(), String> {
    complete_pending_files(&state.sync, label.as_deref().unwrap_or("default"))
}

/// Mark excess pending files as failed based on actual vs expected counts.
pub fn mark_pending_files_as_failed(
    sync: &crate::sync_engine::SyncEngine,
    actual_uploads: u32,
    actual_downloads: u32,
    label: &str,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in mark_pending_files_as_failed");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        // Count expected uploads/downloads for THIS drive only
        let label_expected_uploads = session
            .files
            .values()
            .filter(|f| f.label == label && f.action == FileAction::Upload)
            .count() as u32;
        let label_expected_downloads = session
            .files
            .values()
            .filter(|f| f.label == label && f.action == FileAction::Download)
            .count() as u32;

        // If we have more pending than actual, mark the excess as failed
        let excess_uploads = if actual_uploads < label_expected_uploads {
            label_expected_uploads - actual_uploads
        } else {
            0
        };
        let excess_downloads = if actual_downloads < label_expected_downloads {
            label_expected_downloads - actual_downloads
        } else {
            0
        };

        let mut failed_uploads = 0u32;
        let mut failed_downloads = 0u32;

        // Collect keys first to avoid borrow issues
        let keys: Vec<String> = session.files.keys().cloned().collect();
        for key in keys {
            if let Some(file) = session.files.get_mut(&key) {
                if file.label != label {
                    continue;
                }
                if file.action == FileAction::Upload
                    && (file.status == FileStatus::Pending
                        || file.status == FileStatus::Uploading
                        || file.status == FileStatus::Encrypting)
                    && failed_uploads < excess_uploads
                {
                    file.status = FileStatus::Error;
                    file.error = Some("Upload did not complete".to_string());
                    file.completed_at = Some(now);
                    failed_uploads += 1;
                } else if file.action == FileAction::Download
                    && (file.status == FileStatus::Pending
                        || file.status == FileStatus::Downloading
                        || file.status == FileStatus::Decrypting)
                    && failed_downloads < excess_downloads
                {
                    file.status = FileStatus::Error;
                    file.error = Some("Download did not complete".to_string());
                    file.completed_at = Some(now);
                    failed_downloads += 1;
                }
            }
        }

        // Also complete remaining pending uploads/downloads for THIS drive
        // that weren't marked failed (these are the ones that actually succeeded).
        // Delete actions are always completed — they don't have partial progress.
        for file in session.files.values_mut() {
            if file.label != label {
                continue;
            }
            let is_pending_transfer = (file.action == FileAction::Upload
                && (file.status == FileStatus::Pending
                    || file.status == FileStatus::Uploading
                    || file.status == FileStatus::Encrypting))
                || (file.action == FileAction::Download
                    && (file.status == FileStatus::Pending
                        || file.status == FileStatus::Downloading
                        || file.status == FileStatus::Decrypting));
            let is_pending_delete = (file.action == FileAction::LocalDelete
                || file.action == FileAction::RemoteDelete)
                && (file.status == FileStatus::Pending
                    || file.status == FileStatus::Deleting);

            if is_pending_transfer || is_pending_delete {
                file.status = FileStatus::Completed;
                file.progress = 100;
                file.completed_at = Some(now);
                if file.total_bytes > 0 {
                    file.bytes_encrypted = file.total_bytes;
                    file.bytes_transferred = file.total_bytes;
                }
            }
        }
    }

    state.last_updated = now;
    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_mark_pending_files_as_failed(
    state: tauri::State<'_, crate::app_state::AppState>,
    actual_uploads: u32,
    actual_downloads: u32,
    label: Option<String>,
) -> Result<(), String> {
    mark_pending_files_as_failed(
        &state.sync,
        actual_uploads,
        actual_downloads,
        label.as_deref().unwrap_or("default"),
    )
}

/// Mark every pending/in-progress file as failed with the given error message.
pub fn mark_all_pending_files_as_failed(
    sync: &crate::sync_engine::SyncEngine,
    error_message: String,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in mark_all_pending_files_as_failed");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        for file in session.files.values_mut() {
            if file.status == FileStatus::Pending
                || file.status == FileStatus::Uploading
                || file.status == FileStatus::Downloading
                || file.status == FileStatus::Encrypting
                || file.status == FileStatus::Decrypting
                || file.status == FileStatus::Deleting
            {
                file.status = FileStatus::Error;
                file.error = Some(error_message.clone());
                file.completed_at = Some(now);
                // Reset transfer progress so that when this file is retried,
                // the progress bar starts from 0 instead of continuing from
                // the stale value (update_file_progress uses max() which
                // would otherwise prevent progress from going backwards).
                file.bytes_transferred = 0;
                file.progress = 0;
            }
        }
    }

    state.last_updated = now;
    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_mark_all_pending_files_as_failed(
    state: tauri::State<'_, crate::app_state::AppState>,
    error_message: String,
) -> Result<(), String> {
    mark_all_pending_files_as_failed(&state.sync, error_message)
}

/// Mark a specific file as having encountered an error.
pub fn mark_file_error(
    sync: &crate::sync_engine::SyncEngine,
    path: String,
    error: String,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in mark_file_error");
        poisoned.into_inner()
    });

    let now = now_ms();

    if let Some(session) = state.current_session.as_mut() {
        if let Some(file) = session.files.get_mut(&path) {
            file.status = FileStatus::Error;
            file.error = Some(error);
            file.completed_at = Some(now);
            file.bytes_transferred = 0;
            file.progress = 0;
        }
    }

    state.last_updated = now;
    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_mark_file_error(
    state: tauri::State<'_, crate::app_state::AppState>,
    path: String,
    error: String,
) -> Result<(), String> {
    mark_file_error(&state.sync, path, error)
}

/// Compute overall progress from the current session.
pub fn get_overall_progress(
    sync: &crate::sync_engine::SyncEngine,
) -> Result<OverallProgress, String> {
    let state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in get_overall_progress");
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
                progress_bytes: 0,
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
    let mut total_bytes_expected: u64 = 0;
    let mut total_progress_bytes: u64 = 0;
    let mut current_file: Option<SyncFile> = None;

    for f in session.files.values() {
        match f.status {
            FileStatus::Completed => {
                completed_files += 1;
                if f.total_bytes > 0 {
                    total_bytes_expected += f.total_bytes;
                    total_progress_bytes += f.total_bytes;
                }
            }
            FileStatus::Encrypting
            | FileStatus::Decrypting
            | FileStatus::Uploading
            | FileStatus::Downloading
            | FileStatus::Deleting => {
                in_progress_files += 1;
                if !should_hide_file(&f.path) {
                    let dominated = current_file
                        .as_ref()
                        .map_or(true, |cur| f.started_at > cur.started_at);
                    if dominated {
                        current_file = Some(f.clone());
                    }
                }
                if f.total_bytes > 0 {
                    total_bytes_expected += f.total_bytes;
                    let file_progress = if f.bytes_transferred > 0 {
                        f.bytes_transferred
                    } else {
                        f.bytes_encrypted
                    };
                    total_progress_bytes += file_progress;
                }
            }
            FileStatus::Error => {
                failed_files += 1;
                // Failed files count toward expected but NOT progress bytes.
                if f.total_bytes > 0 {
                    total_bytes_expected += f.total_bytes;
                }
            }
            _ => {
                if f.total_bytes > 0 {
                    total_bytes_expected += f.total_bytes;
                }
            }
        }
    }

    let overall_percent = if total_files == 0 {
        0u32
    } else if failed_files == 0 && completed_files == total_files {
        100
    } else if total_bytes_expected > 0 {
        let pct = (total_progress_bytes as f64 / total_bytes_expected as f64) * 100.0;
        (pct.round() as u32).min(100)
    } else if total_files > 0 {
        let pct = (completed_files as f64 / total_files as f64) * 100.0;
        (pct.round() as u32).min(100)
    } else {
        0
    };

    Ok(OverallProgress {
        is_active: session.is_active,
        total_files,
        completed_files,
        in_progress_files,
        failed_files,
        overall_percent,
        progress_bytes: total_progress_bytes,
        total_bytes_expected,
        current_file,
    })
}

#[tauri::command]
pub fn sp_get_overall_progress(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<OverallProgress, String> {
    get_overall_progress(&state.sync)
}

/// Record a deleted file in the recent files list.
pub fn record_deleted_file(
    sync: &crate::sync_engine::SyncEngine,
    file_name: String,
    size_bytes: u64,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in record_deleted_file");
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

    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_record_deleted_file(
    state: tauri::State<'_, crate::app_state::AppState>,
    file_name: String,
    size_bytes: u64,
) -> Result<(), String> {
    record_deleted_file(&state.sync, file_name, size_bytes)
}

/// Remove all files for a given drive label from the current session.
/// Completed files are moved to recent; remaining files are dropped.
pub fn remove_files_for_label(
    sync: &crate::sync_engine::SyncEngine,
    label: String,
) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in remove_files_for_label");
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
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_remove_files_for_label(
    state: tauri::State<'_, crate::app_state::AppState>,
    label: String,
) -> Result<(), String> {
    remove_files_for_label(&state.sync, label)
}

/// Clear all sync progress data (session + recent files).
pub fn clear_all_data(sync: &crate::sync_engine::SyncEngine) -> Result<(), String> {
    let mut state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in clear_all_data");
        poisoned.into_inner()
    });

    state.current_session = None;
    state.recent_files.clear();
    state.last_updated = now_ms();

    drop(state);
    sync.emit_snapshot(true);
    Ok(())
}

#[tauri::command]
pub fn sp_clear_all_data(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<(), String> {
    clear_all_data(&state.sync)
}

/// Get a full snapshot of the current sync progress state.
pub fn get_snapshot(sync: &crate::sync_engine::SyncEngine) -> Result<SyncSnapshot, String> {
    let state = sync.progress.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in get_snapshot");
        poisoned.into_inner()
    });
    let mut snapshot = build_snapshot(&state);

    // Inject retry state from SyncEngine
    let retry_at = sync.retry_at.load(std::sync::atomic::Ordering::Relaxed);
    if retry_at > 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        snapshot.retry_in_secs = (retry_at - now).max(0) as u64;
    }
    snapshot.last_error = sync.last_error.lock().ok().and_then(|g| g.clone());

    Ok(snapshot)
}

#[tauri::command]
pub fn sp_get_snapshot(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<SyncSnapshot, String> {
    get_snapshot(&state.sync)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    /// Test-only shared `SyncEngine` instance. Not used in production code.
    /// Tests share a single engine because the Rust test runner may run tests
    /// in the same process; `reset_state()` clears the progress between tests.
    fn test_sync() -> &'static crate::sync_engine::SyncEngine {
        static ENG: OnceLock<crate::sync_engine::SyncEngine> = OnceLock::new();
        ENG.get_or_init(crate::sync_engine::SyncEngine::new)
    }

    /// Helper: reset shared engine state before each test.
    fn reset_state() {
        let eng = test_sync();
        let mut state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
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
                ((bytes_transferred as f64 / total_bytes as f64) * 100.0) as u32
            } else {
                0
            },
            bytes_encrypted: 0,
            bytes_transferred,
            total_bytes,
            resumed_from_bytes: None,
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
        assert_eq!(snapshot.progress_bytes, 1000);
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
    fn snapshot_with_completed_and_failed() {
        let state = state_with_files(vec![
            make_file(
                "/a.txt",
                1000,
                FileAction::Upload,
                FileStatus::Completed,
                1000,
            ),
            make_file("/b.txt", 2000, FileAction::Upload, FileStatus::Error, 500),
        ]);
        let snapshot = build_snapshot(&state);
        // Byte-weighted: 1000 completed / 3000 expected = 33%.
        // Failed files count toward expected bytes but NOT progress,
        // so percent reflects the reality that not everything synced.
        assert_eq!(snapshot.overall_percent, 33);
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
            make_file("/error.txt", 100, FileAction::Upload, FileStatus::Error, 0),
        ]);
        let snapshot = build_snapshot(&state);
        let find = |name: &str| snapshot.files.iter().find(|f| f.file_name == name).unwrap();
        assert_eq!(find("pending.txt").status, FileProgressStatus::Pending);
        assert_eq!(find("uploading.txt").status, FileProgressStatus::InProgress);
        assert_eq!(
            find("downloading.txt").status,
            FileProgressStatus::InProgress
        );
        assert_eq!(find("deleting.txt").status, FileProgressStatus::InProgress);
        assert_eq!(find("completed.txt").status, FileProgressStatus::Completed);
        assert_eq!(find("error.txt").status, FileProgressStatus::Error);
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
        let eng = test_sync();

        // Start a session with 1 upload
        let file_list = SessionFileList {
            upload_files: Some(vec!["/test/file.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("drive1".to_string())).unwrap();

        // Complete the file
        update_file_progress(
            eng,
            "/test/file.txt".to_string(),
            100,
            100,
            FileAction::Upload,
            Some("drive1".to_string()),
        )
        .unwrap();

        // Complete the session
        complete_session(eng, 1, 0).unwrap();

        // Session should still exist (inactive) so the UI can show
        // completed state via overallProgress. It gets replaced on
        // the next start_session call.
        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        let session = state
            .current_session
            .as_ref()
            .expect("Session should be kept");
        assert!(!session.is_active, "Session should be inactive");
        assert!(
            session
                .files
                .values()
                .all(|f| f.status == FileStatus::Completed),
            "All files should be completed"
        );
        // File should also be in recent
        assert!(!state.recent_files.is_empty());
    }

    #[test]
    fn start_session_replaces_completed_session() {
        reset_state();
        let eng = test_sync();

        // Create and complete a session
        let file_list = SessionFileList {
            upload_files: Some(vec!["/test/old.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();
        update_file_progress(
            eng,
            "/test/old.txt".to_string(),
            50,
            50,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();
        complete_session(eng, 1, 0).unwrap();

        // Start a new session — old completed files should move to recent
        let new_list = SessionFileList {
            upload_files: Some(vec!["/test/new.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(new_list), Some("d1".to_string())).unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
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
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/test/a.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();
        update_file_progress(
            eng,
            "/test/a.txt".to_string(),
            50,
            50,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();
        complete_session(eng, 1, 0).unwrap();

        // Session is kept (inactive) so snapshot should still show files
        let snapshot = get_snapshot(eng).unwrap();
        assert!(
            snapshot.total_files > 0,
            "Completed session should still report files"
        );

        // After clearing all data, snapshot should be empty
        clear_all_data(eng).unwrap();
        let snapshot = get_snapshot(eng).unwrap();
        assert_eq!(snapshot.total_files, 0, "No files after clear_all_data");
    }

    #[test]
    fn remove_files_for_label_only_removes_matching() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/drive1/a.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("drive1".to_string())).unwrap();

        // Add files for a second drive
        let file_list2 = SessionFileList {
            upload_files: Some(vec!["/drive2/b.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(
            eng,
            1,
            0,
            0,
            0,
            Some(file_list2),
            Some("drive2".to_string()),
        )
        .unwrap();

        // Complete drive1's file
        update_file_progress(
            eng,
            "/drive1/a.txt".to_string(),
            100,
            100,
            FileAction::Upload,
            Some("drive1".to_string()),
        )
        .unwrap();

        // Remove drive1 files
        remove_files_for_label(eng, "drive1".to_string()).unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
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
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/myfile.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("photos".to_string())).unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        let session = state.current_session.as_ref().unwrap();
        let file = session.files.get("/myfile.txt").unwrap();
        assert_eq!(file.label, "photos");
    }

    #[test]
    fn label_propagates_to_recent_file() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/myfile.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("docs".to_string())).unwrap();
        update_file_progress(
            eng,
            "/myfile.txt".to_string(),
            100,
            100,
            FileAction::Upload,
            Some("docs".to_string()),
        )
        .unwrap();
        complete_session(eng, 1, 0).unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
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
        let eng = test_sync();

        // Start session with 1 upload and 1 download
        let file_list = SessionFileList {
            upload_files: Some(vec!["/photo.jpg".to_string()]),
            download_files: Some(vec!["file_a7339456c25845c2deadbeef0123".to_string()]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 1, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // Upload is 50% done
        update_file_progress(
            eng,
            "/photo.jpg".to_string(),
            500,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let progress = get_overall_progress(eng).unwrap();
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
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: None,
            download_files: Some(vec!["file_a7339456c25845c2deadbeef0123".to_string()]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 0, 1, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        let snapshot = get_snapshot(eng).unwrap();
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].file_name, "Encrypted file");
    }

    #[test]
    fn overall_percent_reaches_100_after_force_complete() {
        reset_state();
        let eng = test_sync();

        // Register 2 files, both with progress data
        let file_list = SessionFileList {
            upload_files: Some(vec!["/a.txt".to_string(), "/b.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 2, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // File A reports partial progress
        update_file_progress(
            eng,
            "/a.txt".to_string(),
            500,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // File B reports partial progress too
        update_file_progress(
            eng,
            "/b.txt".to_string(),
            200,
            400,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // Force-complete all pending files
        complete_pending_files(eng, "d1").unwrap();

        let progress = get_overall_progress(eng).unwrap();
        assert_eq!(progress.completed_files, 2);
        // All files are completed, so overall_percent should be 100
        assert_eq!(progress.overall_percent, 100);
    }

    #[test]
    fn complete_pending_marks_stalled_files_as_error() {
        reset_state();
        let eng = test_sync();

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
        start_session(eng, 3, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // File 1: fully transferred (auto-completes in update)
        update_file_progress(
            eng,
            "/completed.txt".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // File 2: partial progress (bytes_transferred > 0)
        update_file_progress(
            eng,
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
        complete_pending_files(eng, "d1").unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
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
        let eng = test_sync();

        // Start with 1 file at 80% progress
        let file_list = SessionFileList {
            upload_files: Some(vec!["/a.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        update_file_progress(
            eng,
            "/a.txt".to_string(),
            800,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let p1 = get_overall_progress(eng).unwrap();
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
        merge_into_session(eng, 1, 0, 0, 0, Some(merge_list), Some("d1".to_string())).unwrap();

        update_file_progress(
            eng,
            "/big.bin".to_string(),
            0,
            10000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let p2 = get_overall_progress(eng).unwrap();
        assert_eq!(p2.total_files, 2);
        // 800 / 11000 = 7.27% → rounds to 7
        assert_eq!(p2.overall_percent, 7);
        // Bytes display matches: 800 transferred, 11000 expected
        assert_eq!(p2.progress_bytes, 800);
        assert_eq!(p2.total_bytes_expected, 11000);
    }

    #[test]
    fn overall_percent_reaches_100_when_all_finished() {
        reset_state();
        let eng = test_sync();

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
        start_session(eng, 3, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        for path in ["/a.txt", "/b.txt", "/c.txt"] {
            update_file_progress(
                eng,
                path.to_string(),
                1000,
                1000,
                FileAction::Upload,
                Some("d1".to_string()),
            )
            .unwrap();
        }

        let p = get_overall_progress(eng).unwrap();
        assert_eq!(p.overall_percent, 100);
    }

    #[test]
    fn overall_percent_100_when_all_known_bytes_transferred() {
        reset_state();
        let eng = test_sync();

        // 2 files: both in-progress at 100% bytes but not marked Completed
        // (simulating edge case where bytes match but status hasn't flipped)
        let file_list = SessionFileList {
            upload_files: Some(vec!["/a.txt".to_string(), "/b.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 2, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // Only update one file — the other stays Pending
        update_file_progress(
            eng,
            "/a.txt".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let p = get_overall_progress(eng).unwrap();
        // /a.txt auto-completed (1000/1000), /b.txt still Pending (no bytes).
        // Byte-weighted: 1000/1000 = 100%. No artificial cap — when all
        // known bytes are transferred the bar reaches 100%.
        assert_eq!(p.overall_percent, 100);
    }

    /// Out-of-order upload callbacks must not regress bytes_transferred.
    #[test]
    fn upload_progress_is_monotonic() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/big.bin".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        let total: u64 = 7_000_000_000;
        let mut prev_bytes: u64 = 0;

        for step in 1..=20 {
            let bytes = (total / 20) * step;
            let result = update_file_progress(
                eng,
                "/big.bin".to_string(),
                bytes,
                total,
                FileAction::Upload,
                Some("d1".to_string()),
            )
            .unwrap()
            .expect("file should exist");

            assert!(
                result.bytes_transferred >= prev_bytes,
                "bytes_transferred regressed: {} -> {} at step {}",
                prev_bytes,
                result.bytes_transferred,
                step
            );
            prev_bytes = result.bytes_transferred;
        }

        assert_eq!(prev_bytes, total);

        // Simulate an out-of-order callback with a lower value — must not regress
        let stale = update_file_progress(
            eng,
            "/big.bin".to_string(),
            1_000_000, // 1MB — way below the 7GB already reported
            total,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap()
        .expect("file should exist");
        assert_eq!(
            stale.bytes_transferred, total,
            "stale callback must not regress bytes"
        );
    }

    /// Encrypt→Upload transition: bytes_encrypted tracks encrypt phase,
    /// bytes_transferred tracks upload phase independently.
    #[test]
    fn encrypt_then_upload_no_regression() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/doc.pdf".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        let total: u64 = 6_000_000_000;

        // Encrypt phase: bytes_encrypted climbs, bytes_transferred stays 0
        for pct in &[25, 50, 75, 100] {
            let bytes = total * pct / 100;
            let r = update_file_progress(
                eng,
                "/doc.pdf".to_string(),
                bytes,
                total,
                FileAction::Encrypt,
                Some("d1".to_string()),
            )
            .unwrap()
            .expect("file should exist");

            assert_eq!(
                r.bytes_transferred, 0,
                "encrypt must not touch bytes_transferred"
            );
            assert_eq!(r.bytes_encrypted, bytes);
            assert!(
                matches!(r.status, FileStatus::Encrypting),
                "status should be Encrypting during encrypt phase"
            );
        }

        // Upload phase starts: bytes_transferred climbs, bytes_encrypted stays at total
        for pct in &[10, 50, 100] {
            let bytes = total * pct / 100;
            let r = update_file_progress(
                eng,
                "/doc.pdf".to_string(),
                bytes,
                total,
                FileAction::Upload,
                Some("d1".to_string()),
            )
            .unwrap()
            .expect("file should exist");

            assert_eq!(
                r.bytes_encrypted, total,
                "encrypt bytes must not change during upload"
            );
            assert_eq!(r.bytes_transferred, bytes);
        }

        // File should be completed after upload reaches 100%
        let state = eng.progress.lock().unwrap();
        let file = state
            .current_session
            .as_ref()
            .unwrap()
            .files
            .get("/doc.pdf")
            .unwrap();
        assert_eq!(file.status, FileStatus::Completed);
        assert_eq!(file.progress, 100);
    }

    /// total_bytes is set once from the first callback and never changes.
    #[test]
    fn total_bytes_set_once() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/f.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // First callback sets total_bytes
        update_file_progress(
            eng,
            "/f.txt".to_string(),
            0,
            5000,
            FileAction::Encrypt,
            Some("d1".to_string()),
        )
        .unwrap();
        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(
            state
                .current_session
                .as_ref()
                .unwrap()
                .files
                .get("/f.txt")
                .unwrap()
                .total_bytes,
            5000
        );
        drop(state);

        // Subsequent callback with different total must not overwrite
        update_file_progress(
            eng,
            "/f.txt".to_string(),
            100,
            9999,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();
        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(
            state
                .current_session
                .as_ref()
                .unwrap()
                .files
                .get("/f.txt")
                .unwrap()
                .total_bytes,
            5000,
            "total_bytes must not change after initial set"
        );
    }

    // ── Resume detection ──────────────────────────────────────────────

    #[test]
    fn resumed_download_detected() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: None,
            download_files: Some(vec!["/photo.jpg".to_string()]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 0, 1, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // First callback: resume from 50MB of 200MB
        let result = update_file_progress(
            eng,
            "/photo.jpg".to_string(),
            50_000_000,
            200_000_000,
            FileAction::Download,
            Some("d1".to_string()),
        )
        .unwrap()
        .expect("file should exist");

        assert_eq!(result.resumed_from_bytes, Some(50_000_000));
        assert_eq!(result.bytes_transferred, 50_000_000);
    }

    #[test]
    fn resumed_upload_detected() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/backup.zip".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // First upload callback skips already-uploaded chunks (24MB of 100MB)
        let result = update_file_progress(
            eng,
            "/backup.zip".to_string(),
            24_000_000,
            100_000_000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap()
        .expect("file should exist");

        assert_eq!(result.resumed_from_bytes, Some(24_000_000));
        assert_eq!(result.bytes_transferred, 24_000_000);
    }

    #[test]
    fn fresh_download_not_marked_as_resumed() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: None,
            download_files: Some(vec!["/new_file.txt".to_string()]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 0, 1, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // First callback starts from 0
        let result = update_file_progress(
            eng,
            "/new_file.txt".to_string(),
            0,
            500_000,
            FileAction::Download,
            Some("d1".to_string()),
        )
        .unwrap()
        .expect("file should exist");

        assert_eq!(result.resumed_from_bytes, None);
    }

    #[test]
    fn resumed_from_bytes_set_only_once() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: None,
            download_files: Some(vec!["/large.bin".to_string()]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 0, 1, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // First callback at resume offset
        update_file_progress(
            eng,
            "/large.bin".to_string(),
            100_000,
            1_000_000,
            FileAction::Download,
            Some("d1".to_string()),
        )
        .unwrap();

        // Second callback at higher offset — resumed_from_bytes must not change
        let result = update_file_progress(
            eng,
            "/large.bin".to_string(),
            500_000,
            1_000_000,
            FileAction::Download,
            Some("d1".to_string()),
        )
        .unwrap()
        .expect("file should exist");

        assert_eq!(
            result.resumed_from_bytes,
            Some(100_000),
            "resumed_from_bytes must not change after initial set"
        );
    }

    #[test]
    fn skipped_encrypt_phase_upload_completes() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/cached.pdf".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // No encrypt callbacks — upload starts directly (cache hit)
        update_file_progress(
            eng,
            "/cached.pdf".to_string(),
            500,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        let file = state
            .current_session
            .as_ref()
            .unwrap()
            .files
            .get("/cached.pdf")
            .unwrap();

        assert_eq!(file.status, FileStatus::Uploading);
        assert_eq!(file.bytes_encrypted, 0, "no encrypt callbacks fired");
        assert_eq!(file.bytes_transferred, 500);
        assert_eq!(file.progress, 50);
        drop(state);

        // Complete the upload
        let result = update_file_progress(
            eng,
            "/cached.pdf".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap()
        .expect("file should exist");

        assert_eq!(result.status, FileStatus::Completed);
        assert_eq!(result.progress, 100);
    }

    #[test]
    fn encrypt_action_does_not_trigger_resume_detection() {
        reset_state();
        let eng = test_sync();

        let file_list = SessionFileList {
            upload_files: Some(vec!["/doc.pdf".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 0, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // Encrypt callback with bytes > 0 should NOT set resumed_from_bytes
        let result = update_file_progress(
            eng,
            "/doc.pdf".to_string(),
            500_000,
            1_000_000,
            FileAction::Encrypt,
            Some("d1".to_string()),
        )
        .unwrap()
        .expect("file should exist");

        assert_eq!(
            result.resumed_from_bytes, None,
            "encrypt progress must not trigger resume detection"
        );
    }

    #[test]
    fn resumed_from_bytes_in_snapshot() {
        let mut file = make_file(
            "/resumed.bin",
            1_000_000,
            FileAction::Download,
            FileStatus::Downloading,
            500_000,
        );
        file.resumed_from_bytes = Some(200_000);
        let state = state_with_files(vec![file]);

        let snapshot = build_snapshot(&state);
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].resumed_from_bytes, Some(200_000));
    }

    #[test]
    fn multi_drive_first_completing_drive_does_not_mark_other_drive_files_as_failed() {
        reset_state();
        let eng = test_sync();

        // Drive A: 3 downloads
        let drive_a_files = SessionFileList {
            upload_files: None,
            download_files: Some(vec![
                "file_a1.mp3".to_string(),
                "file_a2.mp3".to_string(),
                "file_a3.json".to_string(),
            ]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(eng, 0, 3, 0, 0, Some(drive_a_files), Some("drive-a".to_string()))
            .unwrap();

        // Drive B: 4 downloads
        let drive_b_files = SessionFileList {
            upload_files: None,
            download_files: Some(vec![
                "file_b1.mp3".to_string(),
                "file_b2.zip".to_string(),
                "file_b3.dmg".to_string(),
                "file_b4.mp3".to_string(),
            ]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(eng, 0, 4, 0, 0, Some(drive_b_files), Some("drive-b".to_string()))
            .unwrap();

        // Verify merged session has 7 files total
        {
            let state = eng.progress.lock().unwrap();
            let session = state.current_session.as_ref().unwrap();
            assert_eq!(session.files.len(), 7);
            assert_eq!(session.expected_downloads, 7);
        }

        // Simulate drive-a files having received progress data (non-zero bytes)
        // so complete_pending_files marks them Completed instead of Error (stalled).
        {
            let mut state = eng.progress.lock().unwrap();
            let session = state.current_session.as_mut().unwrap();
            for file in session.files.values_mut() {
                if file.label == "drive-a" {
                    file.bytes_transferred = 1000;
                    file.total_bytes = 1000;
                }
            }
        }

        // Drive A completes all 3 of its downloads
        complete_pending_files(eng, "drive-a").unwrap();

        // Drive B's files should still be pending (not marked as failed/completed)
        {
            let state = eng.progress.lock().unwrap();
            let session = state.current_session.as_ref().unwrap();

            // Drive A files: all completed
            let drive_a_completed = session
                .files
                .values()
                .filter(|f| f.label == "drive-a" && f.status == FileStatus::Completed)
                .count();
            assert_eq!(drive_a_completed, 3, "All drive-a files should be completed");

            // Drive B files: all still pending (untouched)
            let drive_b_pending = session
                .files
                .values()
                .filter(|f| f.label == "drive-b" && f.status == FileStatus::Pending)
                .count();
            assert_eq!(
                drive_b_pending, 4,
                "Drive-b files should remain pending, not be marked as failed"
            );

            // Session should still be active
            assert!(session.is_active, "Session should still be active");
        }
    }

    #[test]
    fn multi_drive_mark_failures_scoped_to_label() {
        reset_state();
        let eng = test_sync();

        // Drive A: 2 downloads
        let drive_a_files = SessionFileList {
            upload_files: None,
            download_files: Some(vec![
                "file_a1.mp3".to_string(),
                "file_a2.mp3".to_string(),
            ]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(eng, 0, 2, 0, 0, Some(drive_a_files), Some("drive-a".to_string()))
            .unwrap();

        // Drive B: 3 downloads
        let drive_b_files = SessionFileList {
            upload_files: None,
            download_files: Some(vec![
                "file_b1.mp3".to_string(),
                "file_b2.zip".to_string(),
                "file_b3.dmg".to_string(),
            ]),
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(eng, 0, 3, 0, 0, Some(drive_b_files), Some("drive-b".to_string()))
            .unwrap();

        // Drive A: only 1 out of 2 downloaded (1 failed)
        mark_pending_files_as_failed(eng, 0, 1, "drive-a").unwrap();

        {
            let state = eng.progress.lock().unwrap();
            let session = state.current_session.as_ref().unwrap();

            // Drive A: 1 failed, 1 completed
            let drive_a_errors = session
                .files
                .values()
                .filter(|f| f.label == "drive-a" && f.status == FileStatus::Error)
                .count();
            let drive_a_completed = session
                .files
                .values()
                .filter(|f| f.label == "drive-a" && f.status == FileStatus::Completed)
                .count();
            assert_eq!(drive_a_errors, 1, "Drive-a should have 1 failed file");
            assert_eq!(drive_a_completed, 1, "Drive-a should have 1 completed file");

            // Drive B: all 3 still pending (untouched)
            let drive_b_pending = session
                .files
                .values()
                .filter(|f| f.label == "drive-b" && f.status == FileStatus::Pending)
                .count();
            assert_eq!(
                drive_b_pending, 3,
                "Drive-b files should remain pending when drive-a has failures"
            );
        }
    }

    // ── Delete action handling tests ────────────────────────────────

    #[test]
    fn complete_pending_marks_delete_files_as_completed() {
        reset_state();
        let eng = test_sync();

        // Register a session with only delete files (0 uploads, 0 downloads)
        let file_list = SessionFileList {
            upload_files: None,
            download_files: None,
            local_delete_files: Some(vec!["/local_del.txt".to_string()]),
            remote_delete_files: Some(vec!["/remote_del.txt".to_string()]),
        };
        start_session(eng, 0, 0, 1, 1, Some(file_list), Some("d1".to_string())).unwrap();

        // Delete files never receive progress callbacks, so bytes stay 0.
        // complete_pending_files should still mark them Completed (not Error).
        complete_pending_files(eng, "d1").unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        let session = state.current_session.as_ref().unwrap();

        let local_del = session.files.get("/local_del.txt").unwrap();
        assert_eq!(
            local_del.status,
            FileStatus::Completed,
            "LocalDelete with 0 bytes should be Completed, not Error"
        );

        let remote_del = session.files.get("/remote_del.txt").unwrap();
        assert_eq!(
            remote_del.status,
            FileStatus::Completed,
            "RemoteDelete with 0 bytes should be Completed, not Error"
        );
    }

    #[test]
    fn complete_session_finalizes_delete_only_cycle() {
        reset_state();
        let eng = test_sync();

        // Delete-only session: 0 uploads, 0 downloads, 2 deletes
        let file_list = SessionFileList {
            upload_files: None,
            download_files: None,
            local_delete_files: Some(vec!["/del1.txt".to_string()]),
            remote_delete_files: Some(vec!["/del2.txt".to_string()]),
        };
        start_session(eng, 0, 0, 1, 1, Some(file_list), Some("d1".to_string())).unwrap();

        // Mark deletes as completed (simulating complete_pending_files)
        {
            let mut state = eng.progress.lock().unwrap();
            let session = state.current_session.as_mut().unwrap();
            for file in session.files.values_mut() {
                file.status = FileStatus::Completed;
                file.completed_at = Some(now_ms());
            }
        }

        // complete_session with 0 uploads, 0 downloads
        complete_session(eng, 0, 0).unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        let session = state.current_session.as_ref().unwrap();
        assert!(
            !session.is_active,
            "Session should be finalized (inactive) after delete-only cycle"
        );
        assert!(
            session.completed_at.is_some(),
            "Session should have completed_at set"
        );
    }

    #[test]
    fn mark_pending_files_as_failed_completes_delete_files() {
        reset_state();
        let eng = test_sync();

        // Mixed session: 1 upload + 1 local delete
        let file_list = SessionFileList {
            upload_files: Some(vec!["/upload.txt".to_string()]),
            download_files: None,
            local_delete_files: Some(vec!["/del.txt".to_string()]),
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 1, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // Upload fails (0 actual vs 1 expected)
        mark_pending_files_as_failed(eng, 0, 0, "d1").unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        let session = state.current_session.as_ref().unwrap();

        // Upload should be marked as failed
        let upload = session.files.get("/upload.txt").unwrap();
        assert_eq!(upload.status, FileStatus::Error);

        // Delete should be marked as Completed (not left Pending)
        let del = session.files.get("/del.txt").unwrap();
        assert_eq!(
            del.status,
            FileStatus::Completed,
            "Delete file should be Completed even when uploads fail"
        );
    }

    #[test]
    fn mixed_upload_and_delete_session_completes() {
        reset_state();
        let eng = test_sync();

        // Session with uploads and deletes
        let file_list = SessionFileList {
            upload_files: Some(vec!["/upload.txt".to_string()]),
            download_files: None,
            local_delete_files: Some(vec!["/del.txt".to_string()]),
            remote_delete_files: None,
        };
        start_session(eng, 1, 0, 1, 0, Some(file_list), Some("d1".to_string())).unwrap();

        // Simulate upload progress
        update_file_progress(
            eng,
            "/upload.txt".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("d1".to_string()),
        )
        .unwrap();

        // complete_pending_files marks remaining (delete) as completed
        complete_pending_files(eng, "d1").unwrap();

        // complete_session should finalize
        complete_session(eng, 1, 0).unwrap();

        let state = eng.progress.lock().unwrap_or_else(|p| p.into_inner());
        let session = state.current_session.as_ref().unwrap();

        assert!(!session.is_active, "Session should be finalized");

        let del = session.files.get("/del.txt").unwrap();
        assert_eq!(del.status, FileStatus::Completed);

        let upload = session.files.get("/upload.txt").unwrap();
        assert_eq!(upload.status, FileStatus::Completed);
    }

    #[test]
    fn complete_session_skips_already_inactive_session() {
        reset_state();
        let eng = test_sync();

        // Create a real session and complete it (simulates a previous sync cycle)
        let file_list = SessionFileList {
            upload_files: Some(vec!["/doc.txt".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(eng, 1, 0, 0, 0, Some(file_list), Some("drive1".to_string())).unwrap();
        update_file_progress(
            eng,
            "/doc.txt".to_string(),
            500,
            500,
            FileAction::Upload,
            Some("drive1".to_string()),
        )
        .unwrap();
        complete_session(eng, 1, 0).unwrap();

        // Capture the completed session's timestamp
        let completed_at = {
            let state = eng.progress.lock().unwrap();
            let session = state.current_session.as_ref().expect("Should exist");
            assert!(!session.is_active, "Session should be inactive after completion");
            session.completed_at
        };

        // Now simulate the next no-op sync cycle calling complete_session
        // again (on_sync_plan_ready returned total=0, so no new session was
        // created — the old completed session is still here).
        complete_session(eng, 0, 0).unwrap();

        // The session should be unchanged — no re-finalization, same timestamp
        let state = eng.progress.lock().unwrap();
        let session = state.current_session.as_ref().expect("Session should still exist");
        assert!(!session.is_active, "Should remain inactive");
        assert_eq!(session.completed_at, completed_at, "completed_at should be unchanged");
        assert!(session.files.contains_key("/doc.txt"), "Files should be preserved");
    }

    /// Verify that running mark_pending_files_as_failed against an inactive
    /// session with already-completed files produces no state changes. This
    /// scenario occurs on every no-op heartbeat cycle: the old completed
    /// session is still present, count_expected_for_label returns stale
    /// counts, and has_failures is incorrectly true. The guard in
    /// hcfs_drive.rs (should_finalize_session) prevents this call, but
    /// even if it fires, it should be harmless.
    #[test]
    fn mark_pending_noop_on_inactive_session_with_completed_files() {
        reset_state();
        let eng = test_sync();

        // Create and complete a real session
        let file_list = SessionFileList {
            upload_files: Some(vec!["/photo.jpg".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(eng, 1, 0, 0, 0, Some(file_list), Some("cam".to_string())).unwrap();
        update_file_progress(
            eng,
            "/photo.jpg".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("cam".to_string()),
        )
        .unwrap();
        complete_session(eng, 1, 0).unwrap();

        // Session is now inactive with 1 completed file
        {
            let state = eng.progress.lock().unwrap();
            let session = state.current_session.as_ref().unwrap();
            assert!(!session.is_active);
            let f = session.files.get("/photo.jpg").unwrap();
            assert_eq!(f.status, FileStatus::Completed);
        }

        // Simulate no-op cycle: mark_pending_files_as_failed(0, 0, label)
        // Should not change any file status (all are already Completed)
        mark_pending_files_as_failed(eng, 0, 0, "cam").unwrap();

        let state = eng.progress.lock().unwrap();
        let session = state.current_session.as_ref().unwrap();
        let f = session.files.get("/photo.jpg").unwrap();
        assert_eq!(
            f.status,
            FileStatus::Completed,
            "Completed file must remain Completed after no-op mark_pending_files_as_failed"
        );
        assert!(
            f.error.is_none(),
            "No error should be set on already-completed file"
        );
    }

    #[test]
    fn complete_session_preserves_real_session() {
        reset_state();
        let eng = test_sync();

        // Create a session with real files
        let file_list = SessionFileList {
            upload_files: Some(vec!["/video.mkv".to_string()]),
            download_files: None,
            local_delete_files: None,
            remote_delete_files: None,
        };
        merge_into_session(eng, 1, 0, 0, 0, Some(file_list), Some("drive1".to_string())).unwrap();

        // Simulate upload completing
        update_file_progress(
            eng,
            "/video.mkv".to_string(),
            1000,
            1000,
            FileAction::Upload,
            Some("drive1".to_string()),
        )
        .unwrap();

        // Complete session
        complete_session(eng, 1, 0).unwrap();

        // Session SHOULD be kept (has real files) — NOT discarded
        let state = eng.progress.lock().unwrap();
        let session = state.current_session.as_ref().expect("Real session should be kept");
        assert!(!session.is_active);
        assert!(session.files.contains_key("/video.mkv"));
    }
}
