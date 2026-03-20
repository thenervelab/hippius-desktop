"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useRef } from "react";
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
  getOverallProgress,
  completePendingFiles,
  markPendingFilesAsFailed,
  markAllPendingFilesAsFailed,
  type SessionFileList,
} from "../services/syncProgressService";
import { isSyncConfiguredAtom } from "../global-atoms/unpinAtoms";
import { queryClientAtom } from "jotai-tanstack-query";
import { useAtomValue } from "jotai";
import { REMOTE_STORAGE_STATS_QUERY_KEY } from "./api/useRemoteStorageStats";

interface SyncOutcome {
  label?: string;
  files_uploaded: number;
  files_downloaded: number;
  files_deleted_locally: number;
  files_deleted_remotely: number;
  conflicts_resolved: number;
  conflicts_skipped: number;
}

interface SyncError {
  error: string;
  retry_in_secs?: number;
  consecutive_failures?: number;
}

interface ProgressPayload {
  bytes: number;
  total: number;
  path?: string;
}

// Payload from hcfs_sync_started event (enhanced with file lists)
interface SyncStartedPayload {
  label?: string;
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

  // Track expected counts per drive label to detect failures in sync_completed
  const expectedCountsRef = useRef<Map<string, { uploads: number; downloads: number }>>(new Map());

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

  // Atom to track that sync is configured (so SyncStoppedAlert knows to show)
  const setIsSyncConfiguredAtom = useSetAtom(isSyncConfiguredAtom);

  // Connectivity health atom
  const setSyncEngineHealthAtom = useSetAtom(syncEngineHealthAtom);

  // Debounce timer for completion across drives (prevents 100% flash between drives)
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

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

    // Track whether we've already created an ad-hoc session for
    // progress events that arrive without a prior startSession call
    // (happens when staging shows 0 changes but real sync discovers files).
    let adHocSessionCreated = false;
    // Prevent concurrent ensureSession() calls from racing
    let ensureSessionInFlight = false;

    async function ensureSession(action: 'upload' | 'download') {
      if (adHocSessionCreated || ensureSessionInFlight) return;
      ensureSessionInFlight = true;
      try {
        const progress = await getOverallProgress();
        if (!progress.isActive) {
          const uploads = action === 'upload' ? 1 : 0;
          const downloads = action === 'download' ? 1 : 0;
          await startSession(uploads, downloads, 0, 0);
          adHocSessionCreated = true;

          // Cancel completion timer — real files are being transferred
          if (completionTimerRef.current) {
            clearTimeout(completionTimerRef.current);
            completionTimerRef.current = null;
          }

          completedFilesRef.current.clear();
          setCompletedFilesCountAtom(0);
          setIsSyncing(true);
          setIsSyncingAtom(true);
          setHasSyncErrorAtom(false);
          // null = indeterminate progress until backend accumulates data
          setSyncPercentAtom(null);
          setIsSyncConfiguredAtom(true);
          setSyncActionCountsAtom({
            uploads,
            downloads,
            localDeletes: 0,
            remoteDeletes: 0,
          });
        }
      } catch (err) {
        console.error("[SyncEvents] ensureSession failed:", err);
      } finally {
        ensureSessionInFlight = false;
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
              //
              // IMPORTANT: Do NOT cancel the completion timer here. No-op sync
              // cycles fire immediately after the previous sync completes, and
              // cancelling the timer would prevent isSyncingAtom from ever being
              // set to false — leaving the spinner stuck indefinitely.

              // Reset ad-hoc flag so ensureSession() can create a new session
              // if progress events arrive during this cycle.
              adHocSessionCreated = false;
              setIsSyncConfiguredAtom(true);
              return;
            }

            // Cancel any pending completion timer — a real sync cycle (with files)
            // is starting, so the previous completion should not finalize.
            if (completionTimerRef.current) {
              clearTimeout(completionTimerRef.current);
              completionTimerRef.current = null;
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

            const label = payload.label || "default";

            if (hasActiveSession) {
              // Another drive is already syncing — merge into the existing session
              const prev = expectedCountsRef.current.get(label) ?? { uploads: 0, downloads: 0 };
              expectedCountsRef.current.set(label, {
                uploads: prev.uploads + uploads,
                downloads: prev.downloads + downloads,
              });
              setSyncActionCountsAtom((prev) => ({
                uploads: prev.uploads + uploads,
                downloads: prev.downloads + downloads,
                localDeletes: prev.localDeletes + localDeletes,
                remoteDeletes: prev.remoteDeletes + remoteDeletes,
              }));
              setTotalFilesToSyncAtom((prev) => prev + totalExpected);
              await mergeIntoSession(uploads, downloads, localDeletes, remoteDeletes, fileList, label);
            } else {
              // First drive in this round — start a fresh session
              expectedCountsRef.current.clear();
              expectedCountsRef.current.set(label, { uploads, downloads });
              completedFilesRef.current.clear();
              setCompletedFilesCountAtom(0);
              setTotalFilesToSyncAtom(totalExpected);
              setSyncActionCountsAtom({
                uploads,
                downloads,
                localDeletes: localDeletes,
                remoteDeletes: remoteDeletes,
              });
              await startSession(uploads, downloads, localDeletes, remoteDeletes, fileList, label);
            }

            setIsSyncing(true);
            setIsSyncingAtom(true);
            setHasSyncErrorAtom(false);
            setSyncPercentAtom(0);
            setLastError(null);
            setLastSyncErrorAtom(null);
          }),
          listen<SyncStartedPayload>("hcfs_sync_plan_ready", async (e) => {
            // Fired by hcfs-client after the real sync plan is computed
            // (after scanning + fetching remote state). Contains the exact
            // file lists that will be synced — not stale cached counts.
            const payload = e.payload || {};
            const uploads = payload.uploads || 0;
            const downloads = payload.downloads || 0;
            const localDeletes = payload.local_deletes || 0;
            const remoteDeletes = payload.remote_deletes || 0;
            const totalExpected = uploads + downloads + localDeletes + remoteDeletes;

            if (totalExpected === 0) return;

            const label = payload.label || "default";

            // Cancel any pending completion timer — real work is about to start
            if (completionTimerRef.current) {
              clearTimeout(completionTimerRef.current);
              completionTimerRef.current = null;
            }

            // Build file lists from payload
            const fileList: SessionFileList = {
              uploadFiles: payload.upload_files,
              downloadFiles: payload.download_files,
              localDeleteFiles: payload.local_delete_files,
              remoteDeleteFiles: payload.remote_delete_files,
            };

            // Check if there's already an active session
            const currentProgress = await getOverallProgress();
            const hasActiveSession = currentProgress.isActive;

            adHocSessionCreated = false;

            if (hasActiveSession) {
              // Merge into existing session (multi-drive)
              const prev = expectedCountsRef.current.get(label) ?? { uploads: 0, downloads: 0 };
              expectedCountsRef.current.set(label, {
                uploads: prev.uploads + uploads,
                downloads: prev.downloads + downloads,
              });
              setSyncActionCountsAtom((prev) => ({
                uploads: prev.uploads + uploads,
                downloads: prev.downloads + downloads,
                localDeletes: prev.localDeletes + localDeletes,
                remoteDeletes: prev.remoteDeletes + remoteDeletes,
              }));
              setTotalFilesToSyncAtom((prev) => prev + totalExpected);
              await mergeIntoSession(uploads, downloads, localDeletes, remoteDeletes, fileList, label);
            } else {
              // First drive — start fresh session with real file list
              expectedCountsRef.current.clear();
              expectedCountsRef.current.set(label, { uploads, downloads });
              completedFilesRef.current.clear();
              setCompletedFilesCountAtom(0);
              setTotalFilesToSyncAtom(totalExpected);
              setSyncActionCountsAtom({
                uploads,
                downloads,
                localDeletes,
                remoteDeletes,
              });
              await startSession(uploads, downloads, localDeletes, remoteDeletes, fileList, label);
            }

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
            const label = e.payload.label || "default";
            const expected = expectedCountsRef.current.get(label) ?? { uploads: 0, downloads: 0 };
            const hasExpectedWork = expected.uploads > 0 || expected.downloads > 0;

            // Skip processing for no-op sync cycles (no work expected or completed)
            // UNLESS an ad-hoc session is active (files were registered via
            // progress events but never completed — they need to be marked failed).
            if (totalCompleted === 0 && !hasExpectedWork && !adHocSessionCreated) {
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

            // Remove completed label from expected counts
            expectedCountsRef.current.delete(label);

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
              // All drives done — debounce finalization to avoid a brief
              // 100%→0%→syncing flash when the next drive starts immediately.
              const outcomeCopy = e.payload;
              completionTimerRef.current = setTimeout(async () => {
                completionTimerRef.current = null;
                // Clear remaining expected counts so stale values don't leak.
                expectedCountsRef.current.clear();
                // Only update completion atoms when files were actually synced.
                if (totalCompleted > 0) {
                  setCompletedFilesCountAtom(totalCompleted);
                  setTotalFilesToSyncAtom(totalCompleted);
                  setSyncPercentAtom(100);
                  // Update action counts from the real sync outcome
                  setSyncActionCountsAtom({
                    uploads: outcomeCopy.files_uploaded,
                    downloads: outcomeCopy.files_downloaded,
                    localDeletes: outcomeCopy.files_deleted_locally,
                    remoteDeletes: outcomeCopy.files_deleted_remotely,
                  });
                }
                setIsSyncing(false);
                setIsSyncingAtom(false);
                setLastOutcome(outcomeCopy);
                setUploadProgress(null);
                setUploadProgressAtom(null);
                setDownloadProgress(null);
                setDownloadProgressAtom(null);
              }, 200);
            }
          }),
          listen<SyncError>("hcfs_sync_error", async (e) => {
            const willRetry = (e.payload.retry_in_secs ?? 0) > 0;
            console.error(
              "[SyncEvents] Sync error:",
              e.payload.error,
              willRetry ? `(retrying in ${e.payload.retry_in_secs}s)` : "(no retry)"
            );
            setIsSyncing(false);
            setIsSyncingAtom(false);
            setSyncPercentAtom(null);
            setLastError(e.payload);
            setLastSyncErrorAtom(e.payload.error);
            // Set error flag to keep widget visible
            setHasSyncErrorAtom(true);
            // Mark ALL pending files as failed with the real error message
            await markAllPendingFilesAsFailed(e.payload.error || 'Sync failed');
            // Clear byte-level progress — the snapshot's retry_in_secs
            // drives the UI state from here.
            setUploadProgress(null);
            setUploadProgressAtom(null);
            setDownloadProgress(null);
            setDownloadProgressAtom(null);
          }),
          listen<ProgressPayload>("hcfs_upload_progress", (e) => {
            const percent = e.payload.total > 0
              ? Math.round((e.payload.bytes / e.payload.total) * 100)
              : 0;

            // Ensure an ad-hoc session exists when staging reported 0 changes
            // but the sync engine discovers files to transfer.
            // NOTE: We do NOT call updateFileProgress here — the Rust upload
            // callback already updates progress inline and emits the snapshot.
            // Calling it again via async IPC would introduce stale writes that
            // cause the progress bar to bounce on large files.
            if (e.payload.path) {
              ensureSession('upload')
                .catch((err) => console.error("[SyncEvents] ensureSession failed:", err));
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

            // Ensure an ad-hoc session exists (see upload handler comment above).
            if (e.payload.path) {
              ensureSession('download')
                .catch((err) => console.error("[SyncEvents] ensureSession failed:", err));
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
          listen("hcfs_sync_reset", async () => {
            // Full reset — clear all progress data and show setup UI
            await invoke("sp_clear_all_data").catch(() => {});

            // Reset completed files tracking
            completedFilesRef.current.clear();
            expectedCountsRef.current.clear();
            setCompletedFilesCountAtom(0);
            setTotalFilesToSyncAtom(0);
            // Reset all local state
            setIsSyncing(false);
            setUploadProgress(null);
            setDownloadProgress(null);
            setLastOutcome(null);
            setLastError(null);
            // Reset all global atoms
            setIsSyncingAtom(false);
            setUploadProgressAtom(null);
            setDownloadProgressAtom(null);
            setLastSyncErrorAtom(null);
            setSyncPercentAtom(null);
            setHasSyncErrorAtom(false);
            setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
            // Show setup UI since sync data was reset
            setIsSyncConfiguredAtom(false);
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
      // Cleanup completion debounce timer
      if (completionTimerRef.current) {
        clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }
    };
  }, [setIsSyncingAtom, setUploadProgressAtom, setDownloadProgressAtom, setLastSyncErrorAtom, setHasSyncErrorAtom, setSyncPercentAtom, setCompletedFilesCountAtom, setTotalFilesToSyncAtom, setSyncActionCountsAtom, setIsSyncConfiguredAtom, setSyncEngineHealthAtom, queryClient]);

  return {
    isSyncing,
    uploadProgress,
    downloadProgress,
    lastOutcome,
    lastError,
  };
}
