"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useAtomValue } from "jotai";
import { listen } from "@tauri-apps/api/event";

import SyncStatusDialog from "./SyncStatusDialog";
import useSyncActivity from "../lib/hooks/useSyncActivity";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";
import {
  isSyncingAtom,
  uploadProgressAtom,
  downloadProgressAtom,
  completedFilesCountAtom,
  totalFilesToSyncAtom,
  currentSyncFileAtom,
  syncPercentAtom,
  syncActionCountsAtom,
  hasSyncErrorAtom,
} from "../lib/store/syncAtoms";

const SyncStatusHandler: React.FC = () => {
  const { data: syncFiles, isLoading, refetch } = useSyncActivity();
  const snapshot = useSyncSnapshot();
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isPermanentlyClosed, setIsPermanentlyClosed] = useState(false);
  
  // Local sync event state (from Tauri events)
  const isSyncingFromEvents = useAtomValue(isSyncingAtom);
  const uploadProgress = useAtomValue(uploadProgressAtom);
  const downloadProgress = useAtomValue(downloadProgressAtom);
  const completedFilesCount = useAtomValue(completedFilesCountAtom);
  const totalFilesToSync = useAtomValue(totalFilesToSyncAtom);
  const currentSyncFile = useAtomValue(currentSyncFileAtom);
  const syncPercentFromAtom = useAtomValue(syncPercentAtom);
  
  // Derive activity flag from snapshot
  const hasSyncActivity = snapshot.isActive || snapshot.files.length > 0;

  // Sync action counts to determine what type of sync is happening
  const syncActionCounts = useAtomValue(syncActionCountsAtom);
  
  // Track if sync ended with error (to keep widget visible)
  const hasSyncError = useAtomValue(hasSyncErrorAtom);
  
  // Display files now come from snapshot — no merging needed
  const displayFiles = snapshot.files;

  const syncMetrics = useMemo(() => {
    const hasActiveUpload = uploadProgress !== null && uploadProgress.bytes < uploadProgress.total;
    const hasActiveDownload = downloadProgress !== null && downloadProgress.bytes < downloadProgress.total;

    const inProgressFiles = snapshot.files.filter(
      (f) => f.status === "inProgress" || f.status === "pending"
    ).length;

    const isActivelySyncing = isSyncingFromEvents ||
      hasActiveUpload ||
      hasActiveDownload ||
      snapshot.isActive ||
      inProgressFiles > 0 ||
      (snapshot.totalFiles > 0 &&
       snapshot.completedFiles < snapshot.totalFiles &&
       snapshot.failedFiles === 0);

    if (snapshot.totalFiles > 0) {
      const activeFile = snapshot.files.find((f) => f.status === "inProgress");
      return {
        syncPercent: snapshot.overallPercent,
        totalFiles: snapshot.totalFiles,
        syncedFiles: snapshot.completedFiles,
        uploadingFiles: inProgressFiles,
        filesFailed: snapshot.failedFiles,
        isInProgress: isActivelySyncing,
        isCompleted: !isActivelySyncing && (snapshot.completedFiles > 0 || snapshot.failedFiles > 0),
        currentFile: activeFile?.fileName ?? null,
      };
    }

    if (isActivelySyncing) {
      return {
        syncPercent: null,
        totalFiles: totalFilesToSync > 0 ? totalFilesToSync : 0,
        syncedFiles: completedFilesCount,
        uploadingFiles: totalFilesToSync > completedFilesCount ? 1 : 0,
        filesFailed: 0,
        isInProgress: true,
        isCompleted: false,
        currentFile: currentSyncFile,
      };
    }

    if (syncPercentFromAtom === 100 && completedFilesCount > 0) {
      return {
        syncPercent: 100,
        totalFiles: completedFilesCount,
        syncedFiles: completedFilesCount,
        uploadingFiles: 0,
        filesFailed: 0,
        isInProgress: false,
        isCompleted: true,
        currentFile: null,
      };
    }

    if (!syncFiles || syncFiles.length === 0) {
      return {
        syncPercent: null,
        totalFiles: 0,
        syncedFiles: 0,
        uploadingFiles: 0,
        filesFailed: 0,
        isInProgress: false,
        isCompleted: false,
        currentFile: null,
      };
    }

    const totalFiles = syncFiles.length;
    const uploadingFilesCount = syncFiles.filter(
      (file) => file.status === "uploading"
    ).length;
    const syncedFilesCount = syncFiles.filter(
      (file) => file.status === "uploaded"
    ).length;
    const isInProgress = uploadingFilesCount > 0;
    const isCompleted = uploadingFilesCount === 0 && syncedFilesCount > 0;

    return {
      syncPercent: isCompleted ? 100 : null,
      totalFiles,
      syncedFiles: syncedFilesCount,
      uploadingFiles: uploadingFilesCount,
      filesFailed: 0,
      isInProgress,
      isCompleted,
      currentFile: null,
    };
  }, [snapshot, isSyncingFromEvents, totalFilesToSync, completedFilesCount, currentSyncFile, syncPercentFromAtom, syncFiles, uploadProgress, downloadProgress]);

  const { isInProgress, isCompleted, uploadingFiles, filesFailed } = syncMetrics;

  useEffect(() => {
    const hasSyncFiles = (syncFiles && syncFiles.length > 0) || displayFiles.length > 0;
    const hasUploadingFiles = uploadingFiles > 0;
    // Consider local sync activity including new localStorage-based tracking
    const hasLocalSyncActivity = (isSyncingFromEvents && totalFilesToSync > 0) ||
      hasSyncActivity ||
      uploadProgress !== null ||
      downloadProgress !== null;
    const hasAnyActivity = isInProgress || hasUploadingFiles || hasLocalSyncActivity;
    // Only consider sync completed if files were actually synced
    const hasSyncCompleted = isCompleted && syncMetrics.syncPercent === 100 &&
      (completedFilesCount > 0 || snapshot.completedFiles > 0);
    // Check if there are failed files that need to be shown
    const hasFailedFiles = filesFailed > 0 || snapshot.failedFiles > 0 || hasSyncError;

    // Don't reopen if user explicitly closed — only the hcfs_sync_started
    // event listener (which checks for totalExpected > 0) can reset this.
    if (isPermanentlyClosed) {
      // If new files appeared since dismissal, reopen automatically
      const dismissedCount = dismissedFileCountRef.current;
      const hasNewFiles = dismissedCount !== null && displayFiles.length > dismissedCount;

      if (hasNewFiles && hasAnyActivity) {
        dismissedFileCountRef.current = null;
        setIsPermanentlyClosed(false);
        setIsSyncOpen(true);
      }
      return;
    }

    // Show widget when there's activity, sync files, sync completed, OR failed files/errors
    if (hasAnyActivity || hasSyncFiles || hasSyncCompleted || hasFailedFiles) {
      refetch();
      setIsSyncOpen(true);
    }

    // Auto-close the dialog when sync is stopped (not completed)
    // Don't auto-close if sync completed successfully - KEEP IT OPEN for 1 hour to show recent files
    // Don't auto-close if there are failed files or sync errors - user needs to see the errors
    if (!hasAnyActivity && !isCompleted && !hasFailedFiles && isSyncOpen && !hasSyncFiles) {
      setIsSyncOpen(false);
    }
  }, [
    syncFiles,
    displayFiles,
    isInProgress,
    isCompleted,
    uploadingFiles,
    filesFailed,
    isSyncingFromEvents,
    totalFilesToSync,
    completedFilesCount,
    uploadProgress,
    downloadProgress,
    refetch,
    isPermanentlyClosed,
    isSyncOpen,
    syncMetrics.syncPercent,
    hasSyncActivity,
    snapshot.completedFiles,
    snapshot.failedFiles,
    hasSyncError,
  ]);

  // Auto-close is REMOVED - widget stays expanded to show recent files for 1 hour
  // The widget will auto-hide when recent files expire (1 hour cleanup)
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    // Clear any existing timer
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }

    // No longer auto-close the widget - it stays open showing recent files
    // The widget will hide when recent files expire (handled by cleanup interval)
    return () => {
      if (autoCloseTimerRef.current) {
        clearTimeout(autoCloseTimerRef.current);
      }
    };
  }, [isSyncOpen, isPermanentlyClosed]);

  // Track the session file count when user dismissed, so we can detect new files
  const dismissedFileCountRef = useRef<number | null>(null);

  // Listen for explicit sync stop event and immediately close the widget
  useEffect(() => {
    let cancelled = false;
    let unsubStop: (() => void) | null = null;
    let unsubStart: (() => void) | null = null;

    listen("hcfs_sync_stopped", () => {
      if (!cancelled) {
        setIsSyncOpen(false);
        // Don't set permanently closed - allow reopening if sync restarts
      }
    }).then((u) => {
      if (cancelled) { u(); } else { unsubStop = u; }
    }).catch(err => {
      console.warn("[SyncStatusHandler] Failed to listen for sync_stopped:", err);
    });

    // Listen for new sync starting — only reopen widget if there are actual files to sync
    listen<{ uploads?: number; downloads?: number; local_deletes?: number; remote_deletes?: number }>("hcfs_sync_started", (event) => {
      if (!cancelled) {
        const payload = event.payload || {};
        const totalExpected = (payload.uploads || 0) + (payload.downloads || 0) +
          (payload.local_deletes || 0) + (payload.remote_deletes || 0);

        // Only reopen if this sync cycle has actual files to sync
        if (totalExpected > 0) {
          dismissedFileCountRef.current = null;
          setIsPermanentlyClosed(false);
          setIsSyncOpen(true);
        }
      }
    }).then((u) => {
      if (cancelled) { u(); } else { unsubStart = u; }
    }).catch(err => {
      console.warn("[SyncStatusHandler] Failed to listen for sync_started:", err);
    });

    return () => {
      cancelled = true;
      unsubStop?.();
      unsubStart?.();
    };
  }, []);

  // Handle manual close
  const handleClose = () => {
    setIsSyncOpen(false);
    setIsPermanentlyClosed(true);
    // Remember how many files were shown when user dismissed
    dismissedFileCountRef.current = displayFiles.length;
  };

  // Don't render anything if there are no files to display, no active sync, and sync is not completed
  const hasSyncCompleted = syncMetrics.isCompleted && syncMetrics.syncPercent === 100;
  const hasFilesToDisplay = displayFiles.length > 0 || (syncFiles && syncFiles.length > 0);
  
  if (
    !hasFilesToDisplay &&
    !syncMetrics.isInProgress &&
    !hasSyncCompleted &&
    !hasSyncActivity &&
    !isSyncingFromEvents &&
    !uploadProgress &&
    !downloadProgress &&
    isPermanentlyClosed
  ) {
    return null;
  }

  // Also hide if permanently closed and no activity
  if (isPermanentlyClosed) {
    return null;
  }

  return (
    <SyncStatusDialog
      snapshot={snapshot}
      open={!isLoading && isSyncOpen}
      onClose={handleClose}
      actionCounts={syncActionCounts}
    />
  );
};

export default SyncStatusHandler;