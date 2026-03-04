"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useRef, useCallback } from "react";
import { useSetAtom } from "jotai";
import {
  isSyncingAtom,
  uploadProgressAtom,
  downloadProgressAtom,
  lastSyncErrorAtom,
  hasSyncErrorAtom,
  syncPercentAtom,
  completedFilesCountAtom,
  totalFilesToSyncAtom,
  syncActionCountsAtom,
  type SyncProgressPayload,
} from "../store/syncAtoms";
import {
  startSession,
  completeSession,
  stopSession,
  updateFileProgress,
  getOverallProgress,
  cleanupExpiredFiles,
  completePendingFiles,
  markPendingFilesAsFailed,
  markAllPendingFilesAsFailed,
  type SessionFileList,
} from "../services/syncProgressService";
import {
  sessionFilesAtom,
  recentFilesAtom,
  trayMenuFilesAtom,
  overallProgressAtom,
  hasSyncActivityAtom,
  lastProgressUpdateAtom,
} from "./useSyncProgress";
import {
  getCurrentSessionFiles,
  getRecentFiles,
  getTrayMenuFiles,
  hasAnySyncActivity,
} from "../services/syncProgressService";
import { isSyncConfiguredAtom } from "../global-atoms/unpinAtoms";

interface SyncOutcome {
  files_uploaded: number;
  files_downloaded: number;
  files_deleted_locally: number;
  files_deleted_remotely: number;
  conflicts_resolved: number;
  conflicts_skipped: number;
}

interface SyncError {
  error: string;
}

interface ProgressPayload {
  bytes: number;
  total: number;
  path?: string;
}

// Payload from hcfs_sync_started event (enhanced with file lists)
interface SyncStartedPayload {
  uploads?: number;
  downloads?: number;
  local_deletes?: number;
  remote_deletes?: number;
  // File paths for each action type (new in enhanced payload)
  upload_files?: string[];
  download_files?: string[];
  local_delete_files?: string[];
  remote_delete_files?: string[];
}

export function useSyncEvents() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [uploadProgress, setUploadProgress] =
    useState<ProgressPayload | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<ProgressPayload | null>(null);
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null);
  const [lastError, setLastError] = useState<SyncError | null>(null);

  // Track completed files using a Set to avoid counting duplicates
  const completedFilesRef = useRef<Set<string>>(new Set());
  
  // Track expected counts from sync_started to detect failures in sync_completed
  const expectedCountsRef = useRef<{ uploads: number; downloads: number }>({ uploads: 0, downloads: 0 });

  // Also update global atoms so other components can access sync state
  const setIsSyncingAtom = useSetAtom(isSyncingAtom);
  const setUploadProgressAtom = useSetAtom(uploadProgressAtom);
  const setDownloadProgressAtom = useSetAtom(downloadProgressAtom);
  const setLastSyncErrorAtom = useSetAtom(lastSyncErrorAtom);
  const setHasSyncErrorAtom = useSetAtom(hasSyncErrorAtom);
  const setSyncPercentAtom = useSetAtom(syncPercentAtom);
  const setCompletedFilesCountAtom = useSetAtom(completedFilesCountAtom);
  const setTotalFilesToSyncAtom = useSetAtom(totalFilesToSyncAtom);
  const setSyncActionCountsAtom = useSetAtom(syncActionCountsAtom);
  
  // New atoms for localStorage-based sync progress
  const setSessionFilesAtom = useSetAtom(sessionFilesAtom);
  const setRecentFilesAtom = useSetAtom(recentFilesAtom);
  const setTrayMenuFilesAtom = useSetAtom(trayMenuFilesAtom);
  const setOverallProgressAtom = useSetAtom(overallProgressAtom);
  const setHasSyncActivityAtom = useSetAtom(hasSyncActivityAtom);
  const setLastProgressUpdateAtom = useSetAtom(lastProgressUpdateAtom);
  
  // Atom to track that sync is configured (so SyncStoppedAlert knows to show)
  const setIsSyncConfiguredAtom = useSetAtom(isSyncConfiguredAtom);

  /**
   * Refresh atoms from localStorage service
   */
  const refreshProgressState = useCallback(() => {
    setSessionFilesAtom(getCurrentSessionFiles());
    setRecentFilesAtom(getRecentFiles());
    setTrayMenuFilesAtom(getTrayMenuFiles());
    setOverallProgressAtom(getOverallProgress());
    setHasSyncActivityAtom(hasAnySyncActivity());
    setLastProgressUpdateAtom(Date.now());
  }, [setSessionFilesAtom, setRecentFilesAtom, setTrayMenuFilesAtom, setOverallProgressAtom, setHasSyncActivityAtom, setLastProgressUpdateAtom]);

  // Cleanup interval ref
  const cleanupIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];
    
    // Initial state refresh
    refreshProgressState();
    
    // Setup periodic cleanup for expired files (every minute)
    cleanupIntervalRef.current = setInterval(() => {
      const removed = cleanupExpiredFiles();
      if (removed > 0) {
        refreshProgressState();
      }
    }, 60 * 1000);

    (async () => {
      try {
        const results = await Promise.all([
          listen<SyncStartedPayload>("hcfs_sync_started", (e) => {
            const payload = e.payload || {};
            const uploads = payload.uploads || 0;
            const downloads = payload.downloads || 0;
            const localDeletes = payload.local_deletes || 0;
            const remoteDeletes = payload.remote_deletes || 0;
            const totalExpected = uploads + downloads + localDeletes + remoteDeletes;
            console.log("[SyncEvents] Sync started, expecting", totalExpected, "files. Payload:", payload);
            
            // Mark sync as configured - this enables SyncStoppedAlert to show when user stops sync
            setIsSyncConfiguredAtom(true);
            
            // Store expected counts for failure detection in sync_completed
            expectedCountsRef.current = { uploads, downloads };
            
            // Store sync action counts so UI can show appropriate text
            // e.g., "Downloading X of Y files" vs "Uploading X of Y files"
            setSyncActionCountsAtom({
              uploads,
              downloads,
              localDeletes: localDeletes,
              remoteDeletes: remoteDeletes,
            });
            
            // Build file lists from payload
            const fileList: SessionFileList = {
              uploadFiles: payload.upload_files,
              downloadFiles: payload.download_files,
              localDeleteFiles: payload.local_delete_files,
              remoteDeleteFiles: payload.remote_delete_files,
            };
            
            // Start new session in localStorage service (only if there are files)
            if (totalExpected > 0) {
              startSession(uploads, downloads, localDeletes, remoteDeletes, fileList);
              refreshProgressState();
            }
            
            // Reset completed files tracking
            completedFilesRef.current.clear();
            setCompletedFilesCountAtom(0);
            setTotalFilesToSyncAtom(totalExpected);
            setIsSyncing(true);
            setIsSyncingAtom(true);
            setHasSyncErrorAtom(false); // Clear any previous error state
            setSyncPercentAtom(0);
            setLastError(null);
            setLastSyncErrorAtom(null);
          }),
          listen<SyncOutcome>("hcfs_sync_completed", (e) => {
            console.log("[SyncEvents] Sync completed:", e.payload);
            const totalCompleted = e.payload.files_uploaded + e.payload.files_downloaded + 
                                   e.payload.files_deleted_locally + e.payload.files_deleted_remotely;
            
            // Check if we have fewer completions than expected (failures occurred)
            const expected = expectedCountsRef.current;
            const hasFailed = e.payload.files_uploaded < expected.uploads || 
                             e.payload.files_downloaded < expected.downloads;
            
            if (hasFailed) {
              // Mark pending files as failed based on actual completion counts
              console.log("[SyncEvents] Some files failed:", 
                `expected ${expected.uploads} uploads got ${e.payload.files_uploaded},`,
                `expected ${expected.downloads} downloads got ${e.payload.files_downloaded}`);
              markPendingFilesAsFailed(e.payload.files_uploaded, e.payload.files_downloaded);
            } else {
              // All files completed - mark any remaining pending as completed (e.g., deletes)
              completePendingFiles();
            }
            
            // Complete session in localStorage service
            completeSession(e.payload.files_uploaded, e.payload.files_downloaded);
            refreshProgressState();
            
            // Dispatch event to trigger recent files refetch immediately
            // This ensures the home page shows recently synced files right after sync completes
            if (totalCompleted > 0) {
              window.dispatchEvent(new CustomEvent("sync_files_completed_changed", {
                detail: { filesCompleted: totalCompleted }
              }));
            }
            
            // Set final completed files count from outcome
            setCompletedFilesCountAtom(totalCompleted);
            // Also set total to match completed (sync is done)
            setTotalFilesToSyncAtom(totalCompleted);
            setIsSyncing(false);
            setIsSyncingAtom(false);
            // Only set 100% if files were actually synced, otherwise reset to null
            setSyncPercentAtom(totalCompleted > 0 ? 100 : null);
            setLastOutcome(e.payload);
            setUploadProgress(null);
            setUploadProgressAtom(null);
            setDownloadProgress(null);
            setDownloadProgressAtom(null);
            // Keep showing 100% completed state - only reset when sync is stopped or new sync starts
          }),
          listen<SyncError>("hcfs_sync_error", (e) => {
            console.error("[SyncEvents] Sync error:", e.payload);
            setIsSyncing(false);
            setIsSyncingAtom(false);
            setSyncPercentAtom(null);
            setLastError(e.payload);
            setLastSyncErrorAtom(e.payload.error);
            // Set error flag to keep widget visible
            setHasSyncErrorAtom(true);
            // Mark ALL pending files as failed
            markAllPendingFilesAsFailed(e.payload.error || 'Sync failed');
            // Refresh progress state to update atoms with failed files
            refreshProgressState();
            // Clear progress on error
            setUploadProgress(null);
            setUploadProgressAtom(null);
            setDownloadProgress(null);
            setDownloadProgressAtom(null);
          }),
          listen<ProgressPayload>("hcfs_upload_progress", (e) => {
            console.log("[SyncEvents] Upload progress:", e.payload);
            const percent = e.payload.total > 0 
              ? Math.round((e.payload.bytes / e.payload.total) * 100) 
              : 0;
            console.log("[SyncEvents] Setting sync percent:", percent, "path:", e.payload.path);
            
            // Update localStorage service with progress
            if (e.payload.path) {
              updateFileProgress(e.payload.path, e.payload.bytes, e.payload.total, 'upload');
              refreshProgressState();
            }
            
            // When a file reaches 100%, track it as completed
            if (percent >= 100 && e.payload.path) {
              // Only count if we haven't already counted this file
              if (!completedFilesRef.current.has(e.payload.path)) {
                completedFilesRef.current.add(e.payload.path);
                setCompletedFilesCountAtom(completedFilesRef.current.size);
                console.log("[SyncEvents] File completed:", e.payload.path, "total:", completedFilesRef.current.size);
              }
              setUploadProgress(e.payload);
              setUploadProgressAtom(e.payload as SyncProgressPayload);
              // Clear after 500ms to show completion briefly
              setTimeout(() => {
                setUploadProgress(null);
                setUploadProgressAtom(null);
              }, 500);
            } else {
              setUploadProgress(e.payload);
              setUploadProgressAtom(e.payload as SyncProgressPayload);
            }
            // Don't set sync percent from individual file progress - it causes flickering
            // setSyncPercentAtom(percent);
          }),
          listen<ProgressPayload>("hcfs_download_progress", (e) => {
            console.log("[SyncEvents] Download progress:", e.payload);
            const percent = e.payload.total > 0 
              ? Math.round((e.payload.bytes / e.payload.total) * 100) 
              : 0;
            
            // Update localStorage service with progress
            if (e.payload.path) {
              updateFileProgress(e.payload.path, e.payload.bytes, e.payload.total, 'download');
              refreshProgressState();
            }
            
            // When a file reaches 100%, track it as completed
            if (percent >= 100 && e.payload.path) {
              if (!completedFilesRef.current.has(e.payload.path)) {
                completedFilesRef.current.add(e.payload.path);
                setCompletedFilesCountAtom(completedFilesRef.current.size);
                console.log("[SyncEvents] File downloaded:", e.payload.path, "total:", completedFilesRef.current.size);
              }
              setDownloadProgress(e.payload);
              setDownloadProgressAtom(e.payload as SyncProgressPayload);
              setTimeout(() => {
                setDownloadProgress(null);
                setDownloadProgressAtom(null);
              }, 500);
            } else {
              setDownloadProgress(e.payload);
              setDownloadProgressAtom(e.payload as SyncProgressPayload);
            }
            // Don't set sync percent from individual file progress - it causes flickering
            // setSyncPercentAtom(percent);
          }),
          listen("hcfs_sync_stopped", () => {
            console.log("[SyncEvents] Sync stopped - resetting all state");
            
            // Stop session in localStorage service
            stopSession();
            refreshProgressState();
            
            // Reset completed files tracking
            completedFilesRef.current.clear();
            setCompletedFilesCountAtom(0);
            setTotalFilesToSyncAtom(0);
            // Reset all local state
            setIsSyncing(false);
            setUploadProgress(null);
            setDownloadProgress(null);
            setLastOutcome(null);
            setLastError(null);
            // Reset all global atoms to clear UI (tray icon, sync widget)
            setIsSyncingAtom(false);
            setUploadProgressAtom(null);
            setDownloadProgressAtom(null);
            setLastSyncErrorAtom(null);
            setSyncPercentAtom(null);
          }),
        ]);
        if (cancelled) {
          results.forEach((u) => u());
        } else {
          unsubs.push(...results);
        }
      } catch (err) {
        console.warn("[SyncEvents] Failed to register event listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      // Cleanup the periodic interval
      if (cleanupIntervalRef.current) {
        clearInterval(cleanupIntervalRef.current);
        cleanupIntervalRef.current = null;
      }
    };
  }, [setIsSyncingAtom, setUploadProgressAtom, setDownloadProgressAtom, setLastSyncErrorAtom, setSyncPercentAtom, setCompletedFilesCountAtom, setTotalFilesToSyncAtom, refreshProgressState]);

  return {
    isSyncing,
    uploadProgress,
    downloadProgress,
    lastOutcome,
    lastError,
  };
}
