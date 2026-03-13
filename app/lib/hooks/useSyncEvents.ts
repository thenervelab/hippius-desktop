"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useRef, useCallback } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
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
  syncEngineHealthAtom,
  DEFAULT_SYNC_ENGINE_HEALTH,
  type SyncProgressPayload,
  type SyncEngineHealthState,
} from "../store/syncAtoms";
import {
  startSession,
  mergeIntoSession,
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
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { REMOTE_STORAGE_STATS_QUERY_KEY } from "./api/useRemoteStorageStats";

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

  const queryClient = useAtomValue(queryClientAtom);

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

  // New atoms for sync progress
  const setSessionFilesAtom = useSetAtom(sessionFilesAtom);
  const setRecentFilesAtom = useSetAtom(recentFilesAtom);
  const setTrayMenuFilesAtom = useSetAtom(trayMenuFilesAtom);
  const setOverallProgressAtom = useSetAtom(overallProgressAtom);
  const setHasSyncActivityAtom = useSetAtom(hasSyncActivityAtom);
  const setLastProgressUpdateAtom = useSetAtom(lastProgressUpdateAtom);

  // Atom to track that sync is configured (so SyncStoppedAlert knows to show)
  const setIsSyncConfiguredAtom = useSetAtom(isSyncConfiguredAtom);

  // Connectivity health atom
  const setSyncEngineHealthAtom = useSetAtom(syncEngineHealthAtom);

  /**
   * Refresh atoms from Rust backend service
   */
  const refreshProgressState = useCallback(async () => {
    try {
      const [sessionFiles, recentFiles, trayFiles, overall, activity] = await Promise.all([
        getCurrentSessionFiles(),
        getRecentFiles(),
        getTrayMenuFiles(),
        getOverallProgress(),
        hasAnySyncActivity(),
      ]);
      setSessionFilesAtom(sessionFiles);
      setRecentFilesAtom(recentFiles);
      setTrayMenuFilesAtom(trayFiles);
      setOverallProgressAtom(overall);
      setHasSyncActivityAtom(activity);
      setLastProgressUpdateAtom(Date.now());
    } catch (err) {
      console.error("[SyncEvents] Failed to refresh progress state:", err);
    }
  }, [setSessionFilesAtom, setRecentFilesAtom, setTrayMenuFilesAtom, setOverallProgressAtom, setHasSyncActivityAtom, setLastProgressUpdateAtom]);

  // Throttle refreshProgressState so it fires at most once per 500ms
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshPendingRef = useRef(false);

  const throttledRefreshProgressState = useCallback(() => {
    if (refreshTimerRef.current) {
      // A refresh is already scheduled — just mark that another was requested
      refreshPendingRef.current = true;
      return;
    }
    refreshProgressState();
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        refreshProgressState();
      }
    }, 500);
  }, [refreshProgressState]);

  // Cleanup interval ref
  const cleanupIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

    // Initial state refresh
    refreshProgressState();

    // Query current health state on mount (backend may already be running)
    invoke<SyncEngineHealthState>("get_sync_engine_health")
      .then((health) => {
        if (!cancelled) {
          setSyncEngineHealthAtom(health);
        }
      })
      .catch((err) => {
        console.warn("[SyncEvents] Failed to get initial health state:", err);
      });

    // Setup periodic cleanup for expired files (every minute)
    cleanupIntervalRef.current = setInterval(() => {
      cleanupExpiredFiles().then((removed) => {
        if (removed > 0) {
          refreshProgressState();
        }
      }).catch((err) => {
        console.error("[SyncEvents] Cleanup failed:", err);
      });
    }, 60 * 1000);

    // Listen for manual sync progress updates (e.g. file deletions from UI)
    const handleSyncProgressUpdate = () => { refreshProgressState(); };
    window.addEventListener("sync_progress_update", handleSyncProgressUpdate);

    // Track whether we've already created an ad-hoc session for
    // progress events that arrive without a prior startSession call
    // (happens when staging shows 0 changes but real sync discovers files).
    let adHocSessionCreated = false;

    async function ensureSession(action: 'upload' | 'download') {
      if (adHocSessionCreated) return;
      const progress = await getOverallProgress();
      if (!progress.isActive) {
        const uploads = action === 'upload' ? 1 : 0;
        const downloads = action === 'download' ? 1 : 0;
        await startSession(uploads, downloads, 0, 0);
        adHocSessionCreated = true;
        setIsSyncing(true);
        setIsSyncingAtom(true);
        setHasSyncErrorAtom(false);
        setSyncPercentAtom(0);
      }
    }

    (async () => {
      try {
        const results = await Promise.all([
          listen<SyncStartedPayload>("hcfs_sync_started", async (e) => {
            const payload = e.payload || {};
            const uploads = payload.uploads || 0;
            const downloads = payload.downloads || 0;
            const localDeletes = payload.local_deletes || 0;
            const remoteDeletes = payload.remote_deletes || 0;
            const totalExpected = uploads + downloads + localDeletes + remoteDeletes;

            // Mark sync as configured - this enables SyncStoppedAlert to show when user stops sync
            setIsSyncConfiguredAtom(true);

            if (totalExpected === 0) {
              // No staged changes detected upfront, but the real sync may
              // still discover remote files to download. Don't mark as syncing
              // for 0-file cycles — this prevents the tray icon from flashing
              // red during idle no-op sync rounds. If the real sync later
              // discovers files, ensureSession() will create an ad-hoc session
              // when progress events arrive.
              return;
            }

            // Build file lists from payload
            const fileList: SessionFileList = {
              uploadFiles: payload.upload_files,
              downloadFiles: payload.download_files,
              localDeleteFiles: payload.local_delete_files,
              remoteDeleteFiles: payload.remote_delete_files,
            };

            // Check if there's already an active session (from another drive in the same round)
            const currentProgress = await getOverallProgress();
            const hasActiveSession = currentProgress.isActive;

            adHocSessionCreated = false; // Reset — proper session being created

            if (hasActiveSession) {
              // Another drive is already syncing — merge into the existing session
              expectedCountsRef.current.uploads += uploads;
              expectedCountsRef.current.downloads += downloads;
              setSyncActionCountsAtom((prev) => ({
                uploads: prev.uploads + uploads,
                downloads: prev.downloads + downloads,
                localDeletes: prev.localDeletes + localDeletes,
                remoteDeletes: prev.remoteDeletes + remoteDeletes,
              }));
              setTotalFilesToSyncAtom((prev) => prev + totalExpected);
              await mergeIntoSession(uploads, downloads, localDeletes, remoteDeletes, fileList);
            } else {
              // First drive in this round — start a fresh session
              expectedCountsRef.current = { uploads, downloads };
              completedFilesRef.current.clear();
              setCompletedFilesCountAtom(0);
              setTotalFilesToSyncAtom(totalExpected);
              setSyncActionCountsAtom({
                uploads,
                downloads,
                localDeletes: localDeletes,
                remoteDeletes: remoteDeletes,
              });
              await startSession(uploads, downloads, localDeletes, remoteDeletes, fileList);
            }

            await refreshProgressState();
            setIsSyncing(true);
            setIsSyncingAtom(true);
            setHasSyncErrorAtom(false);
            setSyncPercentAtom(0);
            setLastError(null);
            setLastSyncErrorAtom(null);
          }),
          listen<SyncOutcome>("hcfs_sync_completed", async (e) => {
            const totalCompleted = e.payload.files_uploaded + e.payload.files_downloaded +
                                   e.payload.files_deleted_locally + e.payload.files_deleted_remotely;

            // Check if we have fewer completions than expected (failures occurred).
            const expected = expectedCountsRef.current;
            const hasExpectedWork = expected.uploads > 0 || expected.downloads > 0;

            // Skip processing for no-op sync cycles (no work expected or completed).
            // This avoids unnecessary backend calls that can duplicate recent files
            // and disrupt the completed state display.
            if (totalCompleted === 0 && !hasExpectedWork) {
              return;
            }

            const hasFailed = hasExpectedWork &&
              (e.payload.files_uploaded < expected.uploads ||
               e.payload.files_downloaded < expected.downloads);

            if (hasFailed) {
              await markPendingFilesAsFailed(e.payload.files_uploaded, e.payload.files_downloaded);
            } else {
              await completePendingFiles();
            }

            // Try to complete session — if other drives still have pending
            // files the session will stay active automatically.
            await completeSession(e.payload.files_uploaded, e.payload.files_downloaded);
            await refreshProgressState();

            // Dispatch event to trigger recent files refetch immediately
            if (totalCompleted > 0) {
              window.dispatchEvent(new CustomEvent("sync_files_completed_changed", {
                detail: { filesCompleted: totalCompleted }
              }));

              // Refresh storage stats (Total Files / Total Storage) on Home page
              queryClient.invalidateQueries({
                queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY],
              });
            }

            // Check if session is still active (other drives pending)
            const progress = await getOverallProgress();
            if (progress.isActive) {
              // Other drives still syncing — update counts but keep syncing state
              setCompletedFilesCountAtom((prev) => prev + totalCompleted);
              setLastOutcome(e.payload);
              setUploadProgress(null);
              setUploadProgressAtom(null);
              setDownloadProgress(null);
              setDownloadProgressAtom(null);
            } else {
              // All drives done — finalize UI state and reset expected
              // counts so stale values don't leak into the next round.
              expectedCountsRef.current = { uploads: 0, downloads: 0 };
              // Only update completion atoms when files were actually synced.
              if (totalCompleted > 0) {
                setCompletedFilesCountAtom(totalCompleted);
                setTotalFilesToSyncAtom(totalCompleted);
                setSyncPercentAtom(100);
              }
              setIsSyncing(false);
              setIsSyncingAtom(false);
              setLastOutcome(e.payload);
              setUploadProgress(null);
              setUploadProgressAtom(null);
              setDownloadProgress(null);
              setDownloadProgressAtom(null);
            }
          }),
          listen<SyncError>("hcfs_sync_error", async (e) => {
            console.error("[SyncEvents] Sync error:", e.payload);
            setIsSyncing(false);
            setIsSyncingAtom(false);
            setSyncPercentAtom(null);
            setLastError(e.payload);
            setLastSyncErrorAtom(e.payload.error);
            // Set error flag to keep widget visible
            setHasSyncErrorAtom(true);
            // Mark ALL pending files as failed
            await markAllPendingFilesAsFailed(e.payload.error || 'Sync failed');
            // Refresh progress state to update atoms with failed files
            await refreshProgressState();
            // Clear progress on error
            setUploadProgress(null);
            setUploadProgressAtom(null);
            setDownloadProgress(null);
            setDownloadProgressAtom(null);
          }),
          listen<ProgressPayload>("hcfs_upload_progress", (e) => {
            const percent = e.payload.total > 0
              ? Math.round((e.payload.bytes / e.payload.total) * 100)
              : 0;

            // Update Rust backend with progress (fire-and-forget for high-frequency calls)
            if (e.payload.path) {
              ensureSession('upload')
                .then(() => updateFileProgress(e.payload.path!, e.payload.bytes, e.payload.total, 'upload'))
                .then(() => throttledRefreshProgressState())
                .catch((err) => console.error("[SyncEvents] updateFileProgress failed:", err));
            }

            // When a file reaches 100%, track it as completed
            if (percent >= 100 && e.payload.path) {
              if (!completedFilesRef.current.has(e.payload.path)) {
                completedFilesRef.current.add(e.payload.path);
                setCompletedFilesCountAtom(completedFilesRef.current.size);
              }
              setUploadProgress(e.payload);
              setUploadProgressAtom(e.payload as SyncProgressPayload);
              setTimeout(() => {
                setUploadProgress(null);
                setUploadProgressAtom(null);
              }, 500);
            } else {
              setUploadProgress(e.payload);
              setUploadProgressAtom(e.payload as SyncProgressPayload);
            }
          }),
          listen<ProgressPayload>("hcfs_download_progress", (e) => {
            const percent = e.payload.total > 0
              ? Math.round((e.payload.bytes / e.payload.total) * 100)
              : 0;

            // Update Rust backend with progress (fire-and-forget for high-frequency calls)
            if (e.payload.path) {
              ensureSession('download')
                .then(() => updateFileProgress(e.payload.path!, e.payload.bytes, e.payload.total, 'download'))
                .then(() => throttledRefreshProgressState())
                .catch((err) => console.error("[SyncEvents] updateFileProgress failed:", err));
            }

            // When a file reaches 100%, track it as completed
            if (percent >= 100 && e.payload.path) {
              if (!completedFilesRef.current.has(e.payload.path)) {
                completedFilesRef.current.add(e.payload.path);
                setCompletedFilesCountAtom(completedFilesRef.current.size);
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
          }),
          listen<SyncEngineHealthState>("hcfs_connectivity_changed", (e) => {
            setSyncEngineHealthAtom(e.payload);
          }),
          listen("hcfs_sync_stopped", async () => {

            // Stop session in Rust backend
            await stopSession().catch((err) =>
              console.error("[SyncEvents] stopSession failed:", err)
            );
            await refreshProgressState();

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
            // Reset connectivity health to connected (sync is stopped, not offline)
            setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
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
      window.removeEventListener("sync_progress_update", handleSyncProgressUpdate);
      // Cleanup the periodic interval
      if (cleanupIntervalRef.current) {
        clearInterval(cleanupIntervalRef.current);
        cleanupIntervalRef.current = null;
      }
      // Cleanup throttle timer
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [setIsSyncingAtom, setUploadProgressAtom, setDownloadProgressAtom, setLastSyncErrorAtom, setHasSyncErrorAtom, setSyncPercentAtom, setCompletedFilesCountAtom, setTotalFilesToSyncAtom, setSyncActionCountsAtom, setIsSyncConfiguredAtom, setSyncEngineHealthAtom, refreshProgressState, throttledRefreshProgressState, queryClient]);

  return {
    isSyncing,
    uploadProgress,
    downloadProgress,
    lastOutcome,
    lastError,
  };
}
