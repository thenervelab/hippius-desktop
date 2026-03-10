"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useAtomValue } from "jotai";
import { listen } from "@tauri-apps/api/event";

import SyncStatusDialog from "./SyncStatusDialog";
import useSyncActivity, { SyncActivityRow } from "../lib/hooks/useSyncActivity";
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
    // Extra fields for progress display (custom extension)
    progress: file.progress,
    bytesTransferred: file.bytesTransferred,
    totalBytes: file.totalBytes,
    isActive: file.status === 'uploading' || file.status === 'downloading' || file.status === 'deleting',
  } as SyncActivityRow & { progress?: number; bytesTransferred?: number; totalBytes?: number; isActive?: boolean; error?: string };
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
  // Session files take priority (active sync), recent files fill in the rest
  const displayFiles = useMemo(() => {
    const files: SyncActivityRow[] = [];
    const addedPaths = new Set<string>();
    
    // Add session files first (currently syncing)
    for (const file of sessionFiles) {
      files.push(syncFileToActivityRow(file));
      addedPaths.add(file.path);
    }
    
    // Add recent files that aren't already in session
    for (const file of recentFiles) {
      if (!addedPaths.has(file.path)) {
        files.push(recentFileToActivityRow(file));
        addedPaths.add(file.path);
      }
    }
    
    // Sort by timestamp (most recent first)
    files.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    return files;
  }, [sessionFiles, recentFiles]);

  const calculateSyncMetrics = () => {
    // Debug log for troubleshooting
    console.log('[SyncStatusHandler] calculateSyncMetrics - overallProgress:', {
      isActive: overallProgress.isActive,
      totalFiles: overallProgress.totalFiles,
      completedFiles: overallProgress.completedFiles,
      failedFiles: overallProgress.failedFiles,
      overallPercent: overallProgress.overallPercent,
    });
    
    // Priority 1: Active sync in progress
    // isActive now correctly includes hidden encrypted downloads
    const hasPendingWork = overallProgress.inProgressFiles > 0 || 
      (overallProgress.totalFiles > overallProgress.completedFiles + overallProgress.failedFiles);
    const isSyncing = overallProgress.isActive || hasPendingWork;
    
    if (isSyncing && overallProgress.totalFiles > 0) {
      return {
        syncPercent: overallProgress.overallPercent,
        totalFiles: overallProgress.totalFiles,
        syncedFiles: overallProgress.completedFiles,
        uploadingFiles: overallProgress.inProgressFiles,
        filesFailed: overallProgress.failedFiles,
        isInProgress: true,
        isCompleted: false,
        currentFile: overallProgress.currentFile?.fileName || null,
      };
    }
    
    // Priority 2: Sync completed (may have failures)
    // This catches both successful completion and completion with failures
    if (!isSyncing && (overallProgress.completedFiles > 0 || overallProgress.failedFiles > 0)) {
      const totalFiles = overallProgress.completedFiles + overallProgress.failedFiles;
      const percent = totalFiles > 0 
        ? Math.round((overallProgress.completedFiles / totalFiles) * 100) 
        : 100;
      return {
        syncPercent: percent,
        totalFiles: totalFiles,
        syncedFiles: overallProgress.completedFiles,
        uploadingFiles: 0,
        filesFailed: overallProgress.failedFiles,
        isInProgress: false,
        isCompleted: true,
        currentFile: null,
      };
    }
    
    // Priority 3: Local sync events as fallback (old atom system)
    // The sync is in progress if isSyncingFromEvents is true AND we have files to sync
    if (isSyncingFromEvents && totalFilesToSync > 0) {
      return {
        syncPercent: null, // Don't show percentage during sync - it flickers
        totalFiles: totalFilesToSync,
        syncedFiles: completedFilesCount,
        uploadingFiles: totalFilesToSync > completedFilesCount ? 1 : 0,
        filesFailed: 0,
        isInProgress: true,
        isCompleted: false,
        currentFile: currentSyncFile,
      };
    }

    // Priority 4: Sync just completed via old atoms (no localStorage data)
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

    // Priority 5: Use local file list from synced activity (historical)
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
  };

  const syncMetrics = calculateSyncMetrics();
  const { isInProgress, isCompleted, uploadingFiles, filesFailed } = syncMetrics;

  // Log calculated sync metrics for debugging
  console.log(
    `[SyncStatusHandler] Metrics: percent=${syncMetrics.syncPercent}%, ` +
    `total=${syncMetrics.totalFiles}, synced=${syncMetrics.syncedFiles}, ` +
    `uploading=${uploadingFiles}, failed=${filesFailed}, ` +
    `inProgress=${isInProgress}, completed=${isCompleted}`
  );
  console.log(
    `[SyncStatusHandler] Input state: isSyncingFromEvents=${isSyncingFromEvents}, ` +
    `uploadProgress=${uploadProgress ? JSON.stringify(uploadProgress) : null}, ` +
    `syncFiles.length=${syncFiles?.length ?? 0}`
  );

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

    if (!isCompleted && isPermanentlyClosed) {
      setIsPermanentlyClosed(false);
    }

    // Show widget when there's activity, sync files, sync completed, OR failed files/errors
    if (
      (hasAnyActivity || hasSyncFiles || hasSyncCompleted || hasFailedFiles) &&
      !isPermanentlyClosed
    ) {
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

  // Listen for explicit sync stop event and immediately close the widget
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    listen("hcfs_sync_stopped", () => {
      console.log("[SyncStatusHandler] Sync stopped event received - closing widget");
      if (!cancelled) {
        setIsSyncOpen(false);
        // Don't set permanently closed - allow reopening if sync restarts
      }
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unsub = u;
      }
    }).catch(err => {
      console.warn("[SyncStatusHandler] Failed to listen for sync_stopped:", err);
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // Handle manual close
  const handleClose = () => {
    setIsSyncOpen(false);
    setIsPermanentlyClosed(true);
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
      open={!isLoading && isSyncOpen}
      onClose={handleClose}
      syncFiles={filesToRender}
      syncPercent={syncMetrics.syncPercent}
      totalFiles={syncMetrics.totalFiles}
      filesFailed={filesFailed}
      isInProgress={syncMetrics.isInProgress}
      uploadProgress={uploadProgress}
      downloadProgress={downloadProgress}
      actionCounts={syncActionCounts}
      totalBytesTransferred={overallProgress.totalBytesTransferred}
      totalBytesExpected={overallProgress.totalBytesExpected}
    />
  );
};

export default SyncStatusHandler;
