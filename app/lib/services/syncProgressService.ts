"use client";

/**
 * Sync Progress Service
 *
 * Thin wrapper around Rust backend invoke() commands for sync progress tracking.
 * All state lives in Rust (in-memory); this module just provides the same API
 * surface that consumers previously used when state lived in localStorage.
 */

import { invoke } from "@tauri-apps/api/core";

// ─────────────────────────────────────────────────────────────────────────────
// Types (unchanged — imported by many consumers)
// ─────────────────────────────────────────────────────────────────────────────

export type FileStatus = 'pending' | 'uploading' | 'downloading' | 'deleting' | 'completed' | 'error';
export type FileAction = 'upload' | 'download' | 'local_delete' | 'remote_delete';

export interface SyncFile {
  id: string;
  path: string;
  fileName: string;
  action: FileAction;
  status: FileStatus;
  progress: number;
  bytesTransferred: number;
  totalBytes: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface SyncSession {
  sessionId: string;
  startedAt: number;
  completedAt?: number;
  isActive: boolean;
  expectedUploads: number;
  expectedDownloads: number;
  expectedLocalDeletes: number;
  expectedRemoteDeletes: number;
  files: Record<string, SyncFile>;
}

export interface RecentFile {
  id: string;
  path: string;
  fileName: string;
  action: FileAction;
  completedAt: number;
  sizeBytes: number;
  sessionId: string;
}

export interface SyncProgressState {
  currentSession: SyncSession | null;
  recentFiles: RecentFile[];
  lastUpdated: number;
}

export interface SessionFileList {
  uploadFiles?: string[];
  downloadFiles?: string[];
  localDeleteFiles?: string[];
  remoteDeleteFiles?: string[];
}

export interface OverallProgress {
  isActive: boolean;
  totalFiles: number;
  completedFiles: number;
  inProgressFiles: number;
  failedFiles: number;
  overallPercent: number;
  totalBytesTransferred: number;
  totalBytesExpected: number;
  currentFile: SyncFile | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────────────────────────────────────

export async function startSession(
  expectedUploads: number,
  expectedDownloads: number,
  expectedLocalDeletes: number = 0,
  expectedRemoteDeletes: number = 0,
  fileList?: SessionFileList
): Promise<SyncSession> {
  return invoke<SyncSession>("sp_start_session", {
    expectedUploads,
    expectedDownloads,
    expectedLocalDeletes,
    expectedRemoteDeletes,
    fileList: fileList ?? null,
  });
}

export async function mergeIntoSession(
  expectedUploads: number,
  expectedDownloads: number,
  expectedLocalDeletes: number = 0,
  expectedRemoteDeletes: number = 0,
  fileList?: SessionFileList
): Promise<void> {
  return invoke("sp_merge_into_session", {
    expectedUploads,
    expectedDownloads,
    expectedLocalDeletes,
    expectedRemoteDeletes,
    fileList: fileList ?? null,
  });
}

export async function completeSession(filesUploaded: number, filesDownloaded: number): Promise<void> {
  return invoke("sp_complete_session", { filesUploaded, filesDownloaded });
}

export async function stopSession(): Promise<void> {
  return invoke("sp_stop_session");
}

// ─────────────────────────────────────────────────────────────────────────────
// File Progress Management
// ─────────────────────────────────────────────────────────────────────────────

export async function updateFileProgress(
  path: string,
  bytesTransferred: number,
  totalBytes: number,
  action: FileAction
): Promise<SyncFile | null> {
  return invoke<SyncFile | null>("sp_update_file_progress", {
    path,
    bytesTransferred,
    totalBytes,
    action,
  });
}

export async function completePendingFiles(): Promise<void> {
  return invoke("sp_complete_pending_files");
}

export async function markPendingFilesAsFailed(actualUploads: number, actualDownloads: number): Promise<void> {
  return invoke("sp_mark_pending_files_as_failed", { actualUploads, actualDownloads });
}

export async function markAllPendingFilesAsFailed(errorMessage: string): Promise<void> {
  return invoke("sp_mark_all_pending_files_as_failed", { errorMessage });
}

export async function markFileError(path: string, error: string): Promise<void> {
  return invoke("sp_mark_file_error", { path, error });
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function getCurrentSessionFiles(): Promise<SyncFile[]> {
  return invoke<SyncFile[]>("sp_get_session_files");
}

export async function getRecentFiles(): Promise<RecentFile[]> {
  return invoke<RecentFile[]>("sp_get_recent_files");
}

export async function getTrayMenuFiles(): Promise<(SyncFile | RecentFile)[]> {
  return invoke<(SyncFile | RecentFile)[]>("sp_get_tray_menu_files");
}

export async function getOverallProgress(): Promise<OverallProgress> {
  return invoke<OverallProgress>("sp_get_overall_progress");
}

export async function hasAnySyncActivity(): Promise<boolean> {
  return invoke<boolean>("sp_has_any_sync_activity");
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup & Utility
// ─────────────────────────────────────────────────────────────────────────────

export async function cleanupExpiredFiles(): Promise<number> {
  return invoke<number>("sp_cleanup_expired_files");
}

export async function recordDeletedFile(fileName: string, sizeBytes: number = 0): Promise<void> {
  return invoke("sp_record_deleted_file", { fileName, sizeBytes: sizeBytes || 0 });
}

export async function clearAllData(): Promise<void> {
  return invoke("sp_clear_all_data");
}

export async function isEncryptedFileId(fileName: string): Promise<boolean> {
  return invoke<boolean>("sp_is_encrypted_file_id", { fileName });
}

export async function shouldHideFile(path: string): Promise<boolean> {
  return invoke<boolean>("sp_should_hide_file", { path });
}
