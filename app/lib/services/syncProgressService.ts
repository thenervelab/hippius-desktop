"use client";

/**
 * Sync Progress Service
 * 
 * Manages local tracking of file sync progress, recent files, and sync sessions.
 * Uses localStorage for persistence across app restarts.
 * 
 * Key features:
 * - Track individual file upload/download progress
 * - Maintain recent files history (1 hour retention)
 * - Handle sync sessions (new session clears active files but keeps recent)
 * - Provide data for sync widget and tray menu
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FileStatus = 'pending' | 'uploading' | 'downloading' | 'deleting' | 'completed' | 'error';
export type FileAction = 'upload' | 'download' | 'local_delete' | 'remote_delete';

export interface SyncFile {
  id: string;              // Unique ID (path-based hash)
  path: string;            // Full file path
  fileName: string;        // Display name
  action: FileAction;      // Upload or download
  status: FileStatus;      // Current status
  progress: number;        // 0-100 percentage
  bytesTransferred: number;
  totalBytes: number;
  startedAt: number;       // Timestamp when file started syncing
  completedAt?: number;    // Timestamp when file completed
  error?: string;          // Error message if failed
}

export interface SyncSession {
  sessionId: string;       // Unique session ID
  startedAt: number;       // When session started
  completedAt?: number;    // When session completed (if finished)
  isActive: boolean;       // Whether sync is currently in progress
  expectedUploads: number; // Expected number of uploads (from sync_started)
  expectedDownloads: number; // Expected number of downloads
  expectedLocalDeletes: number;  // Expected local deletions (files to delete locally)
  expectedRemoteDeletes: number; // Expected remote deletions (files to delete from remote)
  files: Record<string, SyncFile>; // Active files in this session keyed by path
}

export interface RecentFile {
  id: string;              // Unique ID
  path: string;            // Full file path
  fileName: string;        // Display name
  action: FileAction;      // Was it uploaded or downloaded
  completedAt: number;     // When it was completed
  sizeBytes: number;       // File size
  sessionId: string;       // Which session it belonged to
}

export interface SyncProgressState {
  currentSession: SyncSession | null;
  recentFiles: RecentFile[];
  lastUpdated: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'hippius_sync_progress';
const RECENT_FILES_RETENTION_MS = 60 * 60 * 1000; // 1 hour
const TRAY_MENU_MAX_FILES = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a unique ID for a file based on its path
 */
function generateFileId(path: string): string {
  // Simple hash based on path and timestamp to ensure uniqueness
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `file_${Math.abs(hash).toString(36)}`;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Check if a filename looks like an encrypted file ID from the server
 * These have patterns like "file_b795e4f6669a9c22" or hex-only names
 */
export function isEncryptedFileId(fileName: string): boolean {
  // Pattern 1: Starts with "file_" followed by hex characters
  if (/^file_[a-f0-9]+$/i.test(fileName)) {
    return true;
  }
  // Pattern 2: Pure hex string (32+ chars, typical for file IDs)
  if (/^[a-f0-9]{20,}$/i.test(fileName)) {
    return true;
  }
  // Pattern 3: Looks like a content hash without extension (8+ hex chars, no dot)
  if (/^[a-f0-9]{8,}$/i.test(fileName) && fileName.length >= 16 && !fileName.includes('.')) {
    return true;
  }
  return false;
}

/**
 * Check if a file should be hidden from UI (has encrypted ID as name)
 */
export function shouldHideFile(path: string): boolean {
  const fileName = path.split('/').pop() || path.split('\\').pop() || path;
  return isEncryptedFileId(fileName);
}

/**
 * Extract file name from path, handling encrypted file IDs gracefully
 */
function extractFileName(path: string): string {
  const rawName = path.split('/').pop() || path.split('\\').pop() || path;
  
  // If this looks like an encrypted file ID, return a generic label
  if (isEncryptedFileId(rawName)) {
    return 'Encrypted file';
  }
  
  return rawName;
}

/**
 * Check if we're in a browser environment
 */
function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the current state from localStorage
 */
export function getState(): SyncProgressState {
  if (!isBrowser()) {
    return {
      currentSession: null,
      recentFiles: [],
      lastUpdated: Date.now(),
    };
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const state = JSON.parse(stored) as SyncProgressState;
      // Clean up expired recent files
      const now = Date.now();
      state.recentFiles = state.recentFiles.filter(
        f => now - f.completedAt < RECENT_FILES_RETENTION_MS
      );
      return state;
    }
  } catch (e) {
    console.error('[SyncProgressService] Failed to load state:', e);
  }

  return {
    currentSession: null,
    recentFiles: [],
    lastUpdated: Date.now(),
  };
}

/**
 * Save state to localStorage
 */
function saveState(state: SyncProgressState): void {
  if (!isBrowser()) return;
  
  try {
    state.lastUpdated = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[SyncProgressService] Failed to save state:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File lists for starting a session
 */
export interface SessionFileList {
  uploadFiles?: string[];
  downloadFiles?: string[];
  localDeleteFiles?: string[];
  remoteDeleteFiles?: string[];
}

/**
 * Start a new sync session with optional file lists
 * This clears active files but preserves recent files (within retention period)
 * 
 * @param expectedUploads - Number of expected uploads
 * @param expectedDownloads - Number of expected downloads
 * @param expectedLocalDeletes - Number of expected local deletions
 * @param expectedRemoteDeletes - Number of expected remote deletions
 * @param fileList - Optional list of file paths grouped by action
 */
export function startSession(
  expectedUploads: number,
  expectedDownloads: number,
  expectedLocalDeletes: number = 0,
  expectedRemoteDeletes: number = 0,
  fileList?: SessionFileList
): SyncSession {
  const state = getState();
  
  // Create new session
  const session: SyncSession = {
    sessionId: generateSessionId(),
    startedAt: Date.now(),
    isActive: true,
    expectedUploads,
    expectedDownloads,
    expectedLocalDeletes,
    expectedRemoteDeletes,
    files: {},
  };
  
  // Register expected files if provided
  if (fileList) {
    const now = Date.now();
    
    // Register upload files
    if (fileList.uploadFiles) {
      fileList.uploadFiles.forEach(path => {
        const id = generateFileId(path);
        session.files[path] = {
          id,
          path,
          fileName: extractFileName(path),
          action: 'upload',
          status: 'pending',
          progress: 0,
          bytesTransferred: 0,
          totalBytes: 0,
          startedAt: now,
        };
      });
    }
    
    // Register download files
    if (fileList.downloadFiles) {
      fileList.downloadFiles.forEach(path => {
        const id = generateFileId(path);
        session.files[path] = {
          id,
          path,
          fileName: extractFileName(path),
          action: 'download',
          status: 'pending',
          progress: 0,
          bytesTransferred: 0,
          totalBytes: 0,
          startedAt: now,
        };
      });
    }
    
    // Register local delete files (files to be deleted locally)
    if (fileList.localDeleteFiles) {
      fileList.localDeleteFiles.forEach(path => {
        const id = generateFileId(path);
        session.files[path] = {
          id,
          path,
          fileName: extractFileName(path),
          action: 'local_delete',
          status: 'pending',
          progress: 0,
          bytesTransferred: 0,
          totalBytes: 0,
          startedAt: now,
        };
      });
    }
    
    // Register remote delete files (files to be deleted from remote)
    if (fileList.remoteDeleteFiles) {
      fileList.remoteDeleteFiles.forEach(path => {
        const id = generateFileId(path);
        session.files[path] = {
          id,
          path,
          fileName: extractFileName(path),
          action: 'remote_delete',
          status: 'pending',
          progress: 0,
          bytesTransferred: 0,
          totalBytes: 0,
          startedAt: now,
        };
      });
    }
  }
  
  state.currentSession = session;
  saveState(state);
  
  const totalFiles = Object.keys(session.files).length;
  console.log('[SyncProgressService] Started session:', session.sessionId, 
    'expecting', expectedUploads, 'uploads,', expectedDownloads, 'downloads,',
    expectedLocalDeletes, 'local deletes,', expectedRemoteDeletes, 'remote deletes,',
    'registered', totalFiles, 'files');
  
  return session;
}

/**
 * Complete the current sync session
 */
export function completeSession(filesUploaded: number, filesDownloaded: number): void {
  const state = getState();
  
  if (state.currentSession) {
    state.currentSession.isActive = false;
    state.currentSession.completedAt = Date.now();
    
    // Move any completed files to recent files
    // Also mark any in-progress files as completed (they finished via backend)
    const now = Date.now();
    Object.values(state.currentSession.files).forEach(file => {
      // First, mark any still in-progress files as completed
      if (file.status === 'uploading' || file.status === 'downloading' || 
          file.status === 'pending' || file.status === 'deleting') {
        file.status = 'completed';
        file.completedAt = now;
        file.progress = 100;
      }
      
      // Then add completed files to recent files
      if (file.status === 'completed' && file.completedAt) {
        // Check if already in recent files
        const exists = state.recentFiles.some(r => r.id === file.id);
        if (!exists) {
          state.recentFiles.unshift({
            id: file.id,
            path: file.path,
            fileName: file.fileName,
            action: file.action,
            completedAt: file.completedAt,
            sizeBytes: file.totalBytes,
            sessionId: state.currentSession!.sessionId,
          });
        }
      }
    });
    
    // Clean up expired recent files
    state.recentFiles = state.recentFiles.filter(
      f => now - f.completedAt < RECENT_FILES_RETENTION_MS
    );
    
    console.log('[SyncProgressService] Session completed:', 
      filesUploaded, 'uploads,', filesDownloaded, 'downloads',
      'recent files:', state.recentFiles.length);
  }
  
  saveState(state);
}

/**
 * Cancel/stop the current sync session
 */
export function stopSession(): void {
  const state = getState();
  
  if (state.currentSession) {
    state.currentSession.isActive = false;
    state.currentSession.completedAt = Date.now();
  }
  
  saveState(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// File Progress Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update file progress (upload or download)
 */
export function updateFileProgress(
  path: string,
  bytesTransferred: number,
  totalBytes: number,
  action: FileAction
): SyncFile | null {
  const state = getState();
  
  if (!state.currentSession || !state.currentSession.isActive) {
    // Start a new session if none exists
    const isUpload = action === 'upload' || action === 'remote_delete';
    const isDownload = action === 'download' || action === 'local_delete';
    startSession(isUpload ? 1 : 0, isDownload ? 1 : 0);
    return updateFileProgress(path, bytesTransferred, totalBytes, action);
  }
  
  const fileId = generateFileId(path);
  const progress = totalBytes > 0 ? Math.round((bytesTransferred / totalBytes) * 100) : 0;
  const isComplete = bytesTransferred >= totalBytes && totalBytes > 0;
  
  // Get or create file entry
  let file = state.currentSession.files[path];
  
  if (!file) {
    file = {
      id: fileId,
      path,
      fileName: extractFileName(path),
      action,
      status: 'pending',
      progress: 0,
      bytesTransferred: 0,
      totalBytes,
      startedAt: Date.now(),
    };
    state.currentSession.files[path] = file;
  }
  
  // Update file state
  file.bytesTransferred = bytesTransferred;
  file.totalBytes = totalBytes;
  file.progress = progress;
  
  if (isComplete && file.status !== 'completed') {
    file.status = 'completed';
    file.completedAt = Date.now();
    file.progress = 100;
    
    // Add to recent files immediately
    const exists = state.recentFiles.some(r => r.id === file.id);
    if (!exists) {
      state.recentFiles.unshift({
        id: file.id,
        path: file.path,
        fileName: file.fileName,
        action: file.action,
        completedAt: file.completedAt,
        sizeBytes: file.totalBytes,
        sessionId: state.currentSession.sessionId,
      });
    }
    
    console.log('[SyncProgressService] File completed:', file.fileName, 'action:', file.action);
  } else if (!isComplete) {
    // Set status based on action type
    if (action === 'upload') {
      file.status = 'uploading';
    } else if (action === 'download') {
      file.status = 'downloading';
    } else if (action === 'local_delete' || action === 'remote_delete') {
      file.status = 'deleting';
    }
  }
  
  saveState(state);
  return file;
}

/**
 * Mark all pending files as completed (used when session completes)
 * This handles files that never received explicit progress events (e.g., deletes)
 * Also marks in-progress files as completed for clean state after sync.
 */
export function completePendingFiles(): void {
  const state = getState();
  
  if (!state.currentSession) return;
  
  const now = Date.now();
  let completedCount = 0;
  
  Object.values(state.currentSession.files).forEach(file => {
    // Mark ANY non-completed file as completed (pending, uploading, downloading, deleting)
    if (file.status === 'pending' || file.status === 'deleting' || 
        file.status === 'uploading' || file.status === 'downloading') {
      file.status = 'completed';
      file.completedAt = now;
      file.progress = 100;
      completedCount++;
      
      // Add to recent files
      const exists = state.recentFiles.some(r => r.id === file.id);
      if (!exists) {
        state.recentFiles.unshift({
          id: file.id,
          path: file.path,
          fileName: file.fileName,
          action: file.action,
          completedAt: file.completedAt,
          sizeBytes: file.totalBytes,
          sessionId: state.currentSession!.sessionId,
        });
      }
    }
  });
  
  if (completedCount > 0) {
    console.log('[SyncProgressService] Marked', completedCount, 'pending/in-progress files as completed');
    saveState(state);
  }
}

/**
 * Mark pending files as failed based on what actually completed.
 * Call this when sync completes with fewer files than expected.
 * @param actualUploads - Number of files actually uploaded
 * @param actualDownloads - Number of files actually downloaded
 */
export function markPendingFilesAsFailed(actualUploads: number, actualDownloads: number): void {
  const state = getState();
  
  if (!state.currentSession) return;
  
  const now = Date.now();
  let completedUploads = 0;
  let completedDownloads = 0;
  let failedCount = 0;
  
  // First count already completed files
  Object.values(state.currentSession.files).forEach(file => {
    if (file.status === 'completed') {
      if (file.action === 'upload' || file.action === 'remote_delete') {
        completedUploads++;
      } else if (file.action === 'download' || file.action === 'local_delete') {
        completedDownloads++;
      }
    }
  });
  
  // Mark remaining pending files as failed or completed based on actual counts
  Object.values(state.currentSession.files).forEach(file => {
    if (file.status === 'pending' || file.status === 'uploading' || file.status === 'downloading') {
      const isUploadAction = file.action === 'upload' || file.action === 'remote_delete';
      const isDownloadAction = file.action === 'download' || file.action === 'local_delete';
      
      // Check if we've exceeded the actual completion count
      if (isUploadAction && completedUploads < actualUploads) {
        // This file completed
        file.status = 'completed';
        file.completedAt = now;
        file.progress = 100;
        completedUploads++;
      } else if (isDownloadAction && completedDownloads < actualDownloads) {
        // This file completed
        file.status = 'completed';
        file.completedAt = now;
        file.progress = 100;
        completedDownloads++;
      } else {
        // This file failed
        file.status = 'error';
        file.error = 'Download failed - network error or file unavailable';
        failedCount++;
      }
    }
  });
  
  if (failedCount > 0) {
    console.log('[SyncProgressService] Marked', failedCount, 'files as failed');
    saveState(state);
  }
}

/**
 * Mark a file as errored
 */
export function markFileError(path: string, error: string): void {
  const state = getState();
  
  if (state.currentSession && state.currentSession.files[path]) {
    state.currentSession.files[path].status = 'error';
    state.currentSession.files[path].error = error;
    saveState(state);
  }
}

/**
 * Mark ALL pending/in-progress files as failed.
 * Call this when the entire sync operation fails with an error.
 * @param errorMessage - The error message to set on failed files
 */
export function markAllPendingFilesAsFailed(errorMessage: string): void {
  const state = getState();
  
  if (!state.currentSession) return;
  
  let failedCount = 0;
  
  // Mark all pending/in-progress files as failed
  Object.values(state.currentSession.files).forEach(file => {
    if (file.status === 'pending' || file.status === 'uploading' || file.status === 'downloading') {
      file.status = 'error';
      file.error = errorMessage;
      failedCount++;
    }
  });
  
  if (failedCount > 0) {
    console.log('[SyncProgressService] Marked ALL', failedCount, 'pending files as failed due to sync error');
    saveState(state);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get current session files (for sync widget)
 * Filters out files with encrypted IDs (shown as "Encrypted file")
 */
export function getCurrentSessionFiles(): SyncFile[] {
  const state = getState();
  
  if (!state.currentSession) {
    return [];
  }
  
  // Filter out files with encrypted IDs
  return Object.values(state.currentSession.files)
    .filter(f => !shouldHideFile(f.path));
}

/**
 * Get recent files within retention period (for sync widget and history)
 * Filters out files with encrypted IDs
 */
export function getRecentFiles(): RecentFile[] {
  const state = getState();
  const now = Date.now();
  
  // Filter to only files within retention period and without encrypted IDs
  return state.recentFiles.filter(
    f => now - f.completedAt < RECENT_FILES_RETENTION_MS && !shouldHideFile(f.path)
  );
}

/**
 * Get files for tray menu (limited to TRAY_MENU_MAX_FILES)
 * Filters out files with encrypted IDs
 * Includes: active, pending, failed, and completed files
 */
export function getTrayMenuFiles(): (SyncFile | RecentFile)[] {
  const state = getState();
  const now = Date.now();
  const result: (SyncFile | RecentFile)[] = [];
  
  // First, add active/in-progress files from current session (exclude encrypted)
  if (state.currentSession) {
    const activeFiles = Object.values(state.currentSession.files)
      .filter(f => (f.status === 'uploading' || f.status === 'downloading' || f.status === 'deleting') 
                   && !shouldHideFile(f.path))
      .sort((a, b) => b.startedAt - a.startedAt);
    result.push(...activeFiles);
  }
  
  // Add pending files (waiting to be processed)
  if (state.currentSession) {
    const pendingFiles = Object.values(state.currentSession.files)
      .filter(f => f.status === 'pending' && !shouldHideFile(f.path))
      .sort((a, b) => b.startedAt - a.startedAt);
    result.push(...pendingFiles);
  }
  
  // Add failed files (show at top so user sees them)
  if (state.currentSession) {
    const failedFiles = Object.values(state.currentSession.files)
      .filter(f => f.status === 'error' && !shouldHideFile(f.path))
      .sort((a, b) => b.startedAt - a.startedAt);
    // Add failed files at the beginning so they're visible
    result.unshift(...failedFiles);
  }
  
  // Then add completed files from current session (exclude encrypted)
  if (state.currentSession) {
    const completedFiles = Object.values(state.currentSession.files)
      .filter(f => f.status === 'completed' && !shouldHideFile(f.path))
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    result.push(...completedFiles);
  }
  
  // Finally add recent files (not already included, exclude encrypted)
  const sessionFilePaths = new Set(
    state.currentSession ? Object.keys(state.currentSession.files) : []
  );
  const recentNotInSession = state.recentFiles
    .filter(f => !sessionFilePaths.has(f.path) 
                 && now - f.completedAt < RECENT_FILES_RETENTION_MS 
                 && !shouldHideFile(f.path))
    .sort((a, b) => b.completedAt - a.completedAt);
  result.push(...recentNotInSession);
  
  // Limit to max files for tray
  return result.slice(0, TRAY_MENU_MAX_FILES);
}

/**
 * Get overall sync progress for current session
 */
export function getOverallProgress(): {
  isActive: boolean;
  totalFiles: number;
  completedFiles: number;
  inProgressFiles: number;
  failedFiles: number;
  overallPercent: number;
  currentFile: SyncFile | null;
} {
  const state = getState();
  
  if (!state.currentSession) {
    return {
      isActive: false,
      totalFiles: 0,
      completedFiles: 0,
      inProgressFiles: 0,
      failedFiles: 0,
      overallPercent: 0,
      currentFile: null,
    };
  }
  
  // Filter to only visible files (not encrypted IDs)
  const allFiles = Object.values(state.currentSession.files);
  const visibleFiles = allFiles.filter(f => !shouldHideFile(f.path));
  
  const completedFiles = visibleFiles.filter(f => f.status === 'completed').length;
  const visibleInProgressFiles = visibleFiles.filter(f => 
    f.status === 'uploading' || f.status === 'downloading' || f.status === 'deleting'
  );
  const pendingFiles = visibleFiles.filter(f => f.status === 'pending');
  
  // Count ALL in-progress files (including hidden encrypted downloads) for accurate activity detection
  const allInProgressFiles = allFiles.filter(f => 
    f.status === 'uploading' || f.status === 'downloading' || f.status === 'deleting'
  );
  const allPendingFiles = allFiles.filter(f => f.status === 'pending');
  
  // Count failed files from ALL files (including hidden encrypted downloads)
  // This is important because downloads often have encrypted paths that get hidden
  const allFailedFiles = allFiles.filter(f => f.status === 'error').length;
  const visibleFailedFiles = visibleFiles.filter(f => f.status === 'error').length;
  
  // Use all files for counts when there are hidden files (in-progress, pending, or failed)
  // This ensures the UI shows accurate counts even when all files are encrypted downloads
  const hasHiddenInProgress = allInProgressFiles.length > visibleInProgressFiles.length;
  const hasHiddenPending = allPendingFiles.length > pendingFiles.length;
  const hasHiddenFailures = allFailedFiles > visibleFailedFiles;
  const hasHiddenFiles = hasHiddenInProgress || hasHiddenPending || hasHiddenFailures;
  
  // Count total files - include hidden files when necessary for accurate counts
  const visibleTotalFiles = visibleFiles.length;
  const hiddenActiveCount = hasHiddenFiles 
    ? (allInProgressFiles.length - visibleInProgressFiles.length) + 
      (allPendingFiles.length - pendingFiles.length) +
      (allFailedFiles - visibleFailedFiles)
    : 0;
  const totalFiles = visibleTotalFiles + hiddenActiveCount;
  
  // Calculate overall percentage based on ALL files when there are hidden ones
  let overallPercent = 0;
  const effectiveTotalFiles = hasHiddenFiles ? allFiles.length : totalFiles;
  const effectiveInProgressFiles = hasHiddenFiles ? allInProgressFiles : visibleInProgressFiles;
  
  if (effectiveTotalFiles > 0) {
    // Each completed file contributes (100 / totalFiles) to overall progress
    // In-progress files contribute their partial progress
    const allCompletedCount = allFiles.filter(f => f.status === 'completed').length;
    const completedContribution = allCompletedCount * (100 / effectiveTotalFiles);
    const inProgressContribution = effectiveInProgressFiles.reduce((sum, f) => {
      return sum + (f.progress * (100 / effectiveTotalFiles) / 100);
    }, 0);
    overallPercent = Math.round(completedContribution + inProgressContribution);
  }
  
  // Get current file being processed (prioritize in-progress over pending)
  // Show visible files if available, otherwise show hidden file indicator
  const currentFile = visibleInProgressFiles.length > 0 
    ? visibleInProgressFiles.sort((a, b) => b.startedAt - a.startedAt)[0]
    : pendingFiles.length > 0
      ? pendingFiles[0]
      : allInProgressFiles.length > 0
        ? allInProgressFiles.sort((a, b) => b.startedAt - a.startedAt)[0]
        : null;
  
  // Determine if sync is truly active - session is active OR there are still pending/in-progress files
  const hasActiveWork = allInProgressFiles.length > 0 || allPendingFiles.length > 0;
  const isActive = state.currentSession.isActive || hasActiveWork;
  
  return {
    isActive,
    totalFiles: hasHiddenFiles ? allFiles.length : totalFiles,
    completedFiles,
    inProgressFiles: allInProgressFiles.length, // Use ALL in-progress files for accurate count
    failedFiles: allFailedFiles, // Use count from ALL files, not just visible
    overallPercent: Math.min(100, overallPercent),
    currentFile,
  };
}

/**
 * Check if there are any files being synced or recently synced
 */
export function hasAnySyncActivity(): boolean {
  const state = getState();
  const now = Date.now();
  
  // Check if session is active
  if (state.currentSession?.isActive) {
    return true;
  }
  
  // Check if there are recent files within retention period
  const hasRecentFiles = state.recentFiles.some(
    f => now - f.completedAt < RECENT_FILES_RETENTION_MS
  );
  
  return hasRecentFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean up expired files (called periodically)
 */
export function cleanupExpiredFiles(): number {
  const state = getState();
  const now = Date.now();
  const beforeCount = state.recentFiles.length;
  
  // Remove expired recent files
  state.recentFiles = state.recentFiles.filter(
    f => now - f.completedAt < RECENT_FILES_RETENTION_MS
  );
  
  // Clear completed session if all recent files have expired
  if (state.currentSession && 
      !state.currentSession.isActive && 
      state.recentFiles.length === 0) {
    state.currentSession = null;
  }
  
  const removedCount = beforeCount - state.recentFiles.length;
  if (removedCount > 0) {
    saveState(state);
    console.log('[SyncProgressService] Cleaned up', removedCount, 'expired files');
  }
  
  return removedCount;
}

/**
 * Clear all sync data (for testing/reset)
 */
export function clearAllData(): void {
  if (isBrowser()) {
    localStorage.removeItem(STORAGE_KEY);
  }
}
