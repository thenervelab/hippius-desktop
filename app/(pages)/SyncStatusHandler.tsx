"use client";

import React, { useState, useEffect } from "react";

import SyncStatusDialog from "./SyncStatusDialog";
import useSyncActivity from "../lib/hooks/useSyncActivity";

const SyncStatusHandler: React.FC = () => {
  const { data, isLoading, refetch } = useSyncActivity();
  const syncFiles = data?.rows || [];
  const backendTotalFiles = data?.totalFiles || 0;
  const backendProcessedFiles = data?.processedFiles || 0;
  const backendInProgress = data?.inProgress || false;
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isPermanentlyClosed, setIsPermanentlyClosed] = useState(false);

  const calculateSyncMetrics = () => {
    // Use backend metrics if available
    if (backendTotalFiles > 0 || backendInProgress) {
      const totalFiles = backendTotalFiles;
      const syncedFiles = backendProcessedFiles;
      const uploadingFiles = syncFiles.filter(
        (file) => file.status === "uploading"
      ).length;

      let syncPercent = 0;
      if (totalFiles > 0) {
        syncPercent = Math.min(100, Math.round((syncedFiles / totalFiles) * 100));
      }

      const isCompleted = !backendInProgress && (syncPercent === 100 || totalFiles === 0);

      return {
        syncPercent,
        totalFiles,
        syncedFiles,
        uploadingFiles,
        isInProgress: backendInProgress,
        isCompleted,
      };
    }

    if (!syncFiles || syncFiles.length === 0) {
      return {
        syncPercent: null,
        totalFiles: 0,
        syncedFiles: 0,
        uploadingFiles: 0,
        isInProgress: false,
        isCompleted: false,
      };
    }

    const totalFiles = syncFiles.length;
    const uploadingFiles = syncFiles.filter(
      (file) => file.status === "uploading"
    ).length;
    const syncedFiles = syncFiles.filter(
      (file) => file.status === "uploaded"
    ).length;
    const isInProgress = uploadingFiles > 0;

    let syncPercent: number | null = null;
    if (totalFiles > 0) {
      if (uploadingFiles === 0) {
        // No uploading files means sync is complete
        syncPercent = 100;
      } else {
        // Calculate percentage based on uploaded files
        syncPercent = Math.round((syncedFiles / totalFiles) * 100);
      }
    }

    const isCompleted = syncPercent === 100;

    return {
      syncPercent,
      totalFiles,
      syncedFiles,
      uploadingFiles,
      isInProgress,
      isCompleted,
    };
  };

  const syncMetrics = calculateSyncMetrics();

  useEffect(() => {
    const { isInProgress, isCompleted, uploadingFiles } = syncMetrics;
    const hasSyncFiles = syncFiles && syncFiles.length > 0;
    const hasUploadingFiles = uploadingFiles > 0;

    if (!isCompleted && isPermanentlyClosed) {
      setIsPermanentlyClosed(false);
    }

    if (
      (isInProgress || hasSyncFiles || hasUploadingFiles) &&
      !isPermanentlyClosed
    ) {
      refetch();
      setIsSyncOpen(true);
    }
  }, [
    syncFiles,
    syncMetrics.isInProgress,
    syncMetrics.isCompleted,
    syncMetrics.uploadingFiles,
    refetch,
    isPermanentlyClosed,
  ]);

  // Handle manual close
  const handleClose = () => {
    setIsSyncOpen(false);
    setIsPermanentlyClosed(true);
  };

  // Don't render anything if there are no sync files and no active sync
  if (
    !syncFiles ||
    (syncFiles.length === 0 && !syncMetrics.isInProgress) ||
    isPermanentlyClosed
  ) {
    return null;
  }

  return (
    <SyncStatusDialog
      open={!isLoading && isSyncOpen}
      onClose={handleClose}
      syncFiles={syncFiles || []}
      syncPercent={syncMetrics.syncPercent}
      totalFiles={syncMetrics.totalFiles}
      syncedFiles={syncMetrics.syncedFiles}
      isInProgress={syncMetrics.isInProgress}
    />
  );
};

export default SyncStatusHandler;
