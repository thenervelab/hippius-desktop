"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useAtomValue } from "jotai";
import { listen } from "@tauri-apps/api/event";

import SyncStatusDialog from "./SyncStatusDialog";
import useSyncActivity, { SyncActivityRow } from "../lib/hooks/useSyncActivity";
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
import {
  sessionFilesAtom,
  recentFilesAtom,
  overallProgressAtom,
  hasSyncActivityAtom,
} from "../lib/hooks/useSyncProgress";
import {
  type SyncFile,
  type RecentFile,
} from "../lib/services/syncProgressService";

/**
 * Convert SyncFile (from localStorage service) to SyncActivityRow (for display)
 */
function syncFileToActivityRow(file: SyncFile): SyncActivityRow {
  // Determine status for display
  let status: SyncActivityRow['status'] = 'uploading';
  if (file.status === 'completed') {
    status = file.action === 'local_delete' || file.action === 'remote_delete' ? 'deleted' : 'uploaded';
  } else if (file.status === 'error') {
    status = 'failed';
  } else if (file.status === 'pending') {
    status = 'pending';
  } else if (file.status === 'deleting') {
    status = 'uploading'; // Show as in-progress
  }
  
  // Check if this is a delete operation
  const isDelete = file.action === 'local_delete' || file.action === 'remote_delete';
  
  return {
    id: file.id,
    fileName: file.fileName,
    rawName: file.fileName,
    scope: file.action === 'upload' || file.action === 'remote_delete' ? 'private' : 'private',
    status,
    fileType: getFileTypeFromName(file.fileName),
    timestamp: file.completedAt || file.startedAt,
    rawPath: file.path,
    size: file.totalBytes,
    deleted: isDelete,
    error: file.error, // Pass through error message for failed files
    // Extra fields for progress display and stable sorting
    progress: file.progress,
    bytesTransferred: file.bytesTransferred,
    totalBytes: file.totalBytes,
    startedAt: file.startedAt,
    isActive: file.status === 'uploading' || file.status === 'downloading' || file.status === 'deleting',
  } as SyncActivityRow & { progress?: number; bytesTransferred?: number; totalBytes?: number; startedAt?: number; isActive?: boolean; error?: string };
}

/**
 * Convert RecentFile to SyncActivityRow
 */
function recentFileToActivityRow(file: RecentFile): SyncActivityRow {
  const isDelete = file.action === 'local_delete' || file.action === 'remote_delete';
  return {
    id: file.id,
    fileName: file.fileName,
    rawName: file.fileName,
    scope: 'private',
    status: isDelete ? 'deleted' : 'uploaded',
    fileType: getFileTypeFromName(file.fileName),
    timestamp: file.completedAt,
    rawPath: file.path,
    size: file.sizeBytes,
    deleted: isDelete,
  };
}

/**
 * Simple file type detection from file name
 */
function getFileTypeFromName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const typeMap: Record<string, string> = {
    jpg: 'Image', jpeg: 'Image', png: 'Image', gif: 'Image', webp: 'Image', svg: 'Image',
    pdf: 'PDF',
    doc: 'Document', docx: 'Document', txt: 'Document', rtf: 'Document',
    xls: 'Spreadsheet', xlsx: 'Spreadsheet', csv: 'Spreadsheet',
    mp4: 'Video', mov: 'Video', avi: 'Video', mkv: 'Video',
    mp3: 'Audio', wav: 'Audio', flac: 'Audio', aac: 'Audio',
    zip: 'Archive', rar: 'Archive', '7z': 'Archive', tar: 'Archive', gz: 'Archive',
  };
  return typeMap[ext] || 'File';
}

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
  
  // New localStorage-based sync tracking
  const sessionFiles = useAtomValue(sessionFilesAtom);
  const recentFiles = useAtomValue(recentFilesAtom);
  const overallProgress = useAtomValue(overallProgressAtom);
  const hasSyncActivity = useAtomValue(hasSyncActivityAtom);
  
  // Sync action counts to determine what type of sync is happening
  const syncActionCounts = useAtomValue(syncActionCountsAtom);
  
  // Track if sync ended with error (to keep widget visible)
  const hasSyncError = useAtomValue(hasSyncErrorAtom);
  
  // Merge session files and recent files for display
  // Recent deletes take priority over session entries (user just deleted from UI),
  // then session files, then remaining recent files.
  const displayFiles = useMemo(() => {
    const files: SyncActivityRow[] = [];
    const addedPaths = new Set<string>();

    // Collect paths of recently deleted files so they override stale session entries
    const recentDeletePaths = new Set<string>();
    for (const file of recentFiles) {
      if (file.action === "local_delete" || file.action === "remote_delete") {
        recentDeletePaths.add(file.path);
      }
    }

    // Add session files, but skip any that were recently deleted from the UI
    for (const file of sessionFiles) {
      if (recentDeletePaths.has(file.path)) continue;
      files.push(syncFileToActivityRow(file));
      addedPaths.add(file.path);
    }

    // Add recent files that aren't already covered by session entries
    for (const file of recentFiles) {
      if (!addedPaths.has(file.path)) {
        files.push(recentFileToActivityRow(file));
        addedPaths.add(file.path);
      }
    }

    // Stable sort: session files first (by startedAt, preserving
    // registration order), then recent files by completedAt. Files
    // never jump positions when their status changes — a file that
    // completes stays where it was, only its indicator changes.
    files.sort((a, b) => {
      // Session files (have startedAt) before recent-only files
      const aStarted = (a as any).startedAt as number | undefined;
      const bStarted = (b as any).startedAt as number | undefined;
      if (aStarted != null && bStarted != null) {
        return aStarted - bStarted; // registration order
      }
      if (aStarted != null) return -1;
      if (bStarted != null) return 1;
      // Both are recent files — most recent first
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    return files;
  }, [sessionFiles, recentFiles]);

  const syncMetrics = useMemo(() => {
    // Comprehensive sync detection matching tray menu logic — the tray is always
    // correct, so the widget should use the same signals.
    const hasActiveUpload = uploadProgress !== null && uploadProgress.bytes < uploadProgress.total;
    const hasActiveDownload = downloadProgress !== null && downloadProgress.bytes < downloadProgress.total;

    const isActivelySyncing = isSyncingFromEvents ||
      hasActiveUpload ||
      hasActiveDownload ||
      overallProgress.isActive ||
      (overallProgress.inProgressFiles > 0) ||
      (overallProgress.totalFiles > 0 &&
       overallProgress.completedFiles < overallProgress.totalFiles &&
       overallProgress.failedFiles === 0);

    // Priority 1: overallProgress has file data
    if (overallProgress.totalFiles > 0) {
      return {
        syncPercent: overallProgress.overallPercent,
        totalFiles: overallProgress.totalFiles,
        syncedFiles: overallProgress.completedFiles,
        uploadingFiles: overallProgress.inProgressFiles,
        filesFailed: overallProgress.failedFiles,
        isInProgress: isActivelySyncing,
        isCompleted: !isActivelySyncing && (overallProgress.completedFiles > 0 || overallProgress.failedFiles > 0),
        currentFile: overallProgress.currentFile?.fileName || null,
      };
    }

    // Priority 2: Sync is active but overallProgress has no files yet
    if (isActivelySyncing) {
      return {
        syncPercent: null, // Don't show percentage — no file data yet
        totalFiles: totalFilesToSync > 0 ? totalFilesToSync : 0,
        syncedFiles: completedFilesCount,
        uploadingFiles: totalFilesToSync > completedFilesCount ? 1 : 0,
        filesFailed: 0,
        isInProgress: true,
        isCompleted: false,
        currentFile: currentSyncFile,
      };
    }

    // Priority 3: Sync just completed via old atoms (no localStorage data)
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

    // Priority 4: Use local file list from synced activity (historical)
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
  }, [overallProgress, isSyncingFromEvents, totalFilesToSync, completedFilesCount, currentSyncFile, syncPercentFromAtom, syncFiles, uploadProgress, downloadProgress]);

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
      (completedFilesCount > 0 || overallProgress.completedFiles > 0);
    // Check if there are failed files that need to be shown
    const hasFailedFiles = filesFailed > 0 || overallProgress.failedFiles > 0 || hasSyncError;

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
    overallProgress.completedFiles,
    overallProgress.failedFiles,
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

  // Use displayFiles if available, otherwise fall back to syncFiles
  const filesToRender = displayFiles.length > 0 ? displayFiles : (syncFiles || []);

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