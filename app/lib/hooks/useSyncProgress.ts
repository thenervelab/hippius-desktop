"use client";

import { useEffect, useCallback } from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  startSession,
  completeSession,
  stopSession,
  updateFileProgress,
  getCurrentSessionFiles,
  getRecentFiles,
  getTrayMenuFiles,
  getOverallProgress,
  hasAnySyncActivity,
  type SyncFile,
  type RecentFile,
  type FileAction,
} from "../services/syncProgressService";

// ─────────────────────────────────────────────────────────────────────────────
// Atoms for reactive state
// ─────────────────────────────────────────────────────────────────────────────

// Current session files (files being synced in current session)
export const sessionFilesAtom = atom<SyncFile[]>([]);

// Recent files (completed within 1 hour)
export const recentFilesAtom = atom<RecentFile[]>([]);

// Files for tray menu (limited to 20)
export const trayMenuFilesAtom = atom<(SyncFile | RecentFile)[]>([]);

// Overall progress info
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

export const overallProgressAtom = atom<OverallProgress>({
  isActive: false,
  totalFiles: 0,
  completedFiles: 0,
  inProgressFiles: 0,
  failedFiles: 0,
  overallPercent: 0,
  totalBytesTransferred: 0,
  totalBytesExpected: 0,
  currentFile: null,
});

// Whether there's any sync activity (active session or recent files)
export const hasSyncActivityAtom = atom<boolean>(false);

// Last update timestamp to trigger re-renders
export const lastProgressUpdateAtom = atom<number>(0);

// ─────────────────────────────────────────────────────────────────────────────
// Hook for managing sync progress
// ─────────────────────────────────────────────────────────────────────────────

export function useSyncProgress() {
  const [sessionFiles, setSessionFiles] = useAtom(sessionFilesAtom);
  const [recentFiles, setRecentFiles] = useAtom(recentFilesAtom);
  const [trayMenuFiles, setTrayMenuFiles] = useAtom(trayMenuFilesAtom);
  const [overallProgress, setOverallProgress] = useAtom(overallProgressAtom);
  const [hasSyncActivity, setHasSyncActivity] = useAtom(hasSyncActivityAtom);
  const setLastUpdate = useSetAtom(lastProgressUpdateAtom);

  /**
   * Refresh all state from Rust backend
   */
  const refreshState = useCallback(async () => {
    try {
      const [sf, rf, tmf, op, act] = await Promise.all([
        getCurrentSessionFiles(),
        getRecentFiles(),
        getTrayMenuFiles(),
        getOverallProgress(),
        hasAnySyncActivity(),
      ]);
      setSessionFiles(sf);
      setRecentFiles(rf);
      setTrayMenuFiles(tmf);
      setOverallProgress(op);
      setHasSyncActivity(act);
      setLastUpdate(Date.now());
    } catch (err) {
      console.error("[useSyncProgress] Failed to refresh state:", err);
    }
  }, [setSessionFiles, setRecentFiles, setTrayMenuFiles, setOverallProgress, setHasSyncActivity, setLastUpdate]);

  /**
   * Start a new sync session
   */
  const handleStartSession = useCallback(async (expectedUploads: number, expectedDownloads: number) => {
    console.log('[useSyncProgress] Starting session with', expectedUploads, 'uploads,', expectedDownloads, 'downloads');
    await startSession(expectedUploads, expectedDownloads);
    await refreshState();
  }, [refreshState]);

  /**
   * Complete the current sync session
   */
  const handleCompleteSession = useCallback(async (filesUploaded: number, filesDownloaded: number) => {
    console.log('[useSyncProgress] Completing session with', filesUploaded, 'uploads,', filesDownloaded, 'downloads');
    await completeSession(filesUploaded, filesDownloaded);
    await refreshState();
  }, [refreshState]);

  /**
   * Stop/cancel the current sync session
   */
  const handleStopSession = useCallback(async () => {
    console.log('[useSyncProgress] Stopping session');
    await stopSession();
    await refreshState();
  }, [refreshState]);

  /**
   * Update file progress
   */
  const handleFileProgress = useCallback(async (
    path: string,
    bytesTransferred: number,
    totalBytes: number,
    action: FileAction
  ) => {
    await updateFileProgress(path, bytesTransferred, totalBytes, action);
    await refreshState();
  }, [refreshState]);

  // Initial refresh on mount (cleanup interval lives in useSyncEvents)
  useEffect(() => {
    refreshState();
  }, [refreshState]);

  return {
    // State
    sessionFiles,
    recentFiles,
    trayMenuFiles,
    overallProgress,
    hasSyncActivity,

    // Actions
    startSession: handleStartSession,
    completeSession: handleCompleteSession,
    stopSession: handleStopSession,
    updateFileProgress: handleFileProgress,
    refreshState,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only hooks for components that just need to display data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to get session files (files currently being synced)
 */
export function useSessionFiles() {
  return useAtomValue(sessionFilesAtom);
}

/**
 * Hook to get recent files (completed within 1 hour)
 */
export function useRecentFiles() {
  return useAtomValue(recentFilesAtom);
}

/**
 * Hook to get tray menu files (limited to 20)
 */
export function useTrayMenuFiles() {
  return useAtomValue(trayMenuFilesAtom);
}

/**
 * Hook to get overall progress
 */
export function useOverallProgress() {
  return useAtomValue(overallProgressAtom);
}

/**
 * Hook to check if there's any sync activity
 */
export function useHasSyncActivity() {
  return useAtomValue(hasSyncActivityAtom);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper to check if an item is a SyncFile or RecentFile
// ─────────────────────────────────────────────────────────────────────────────

export function isSyncFile(item: SyncFile | RecentFile): item is SyncFile {
  return 'status' in item && 'progress' in item;
}

export function isRecentFile(item: SyncFile | RecentFile): item is RecentFile {
  return 'sizeBytes' in item && !('status' in item);
}
