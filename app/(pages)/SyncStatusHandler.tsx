"use client";

import React, { useState, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";

import SyncStatusDialog from "./SyncStatusDialog";
import useSyncActivity from "../lib/hooks/useSyncActivity";
import { syncPercentAtom, syncStatusAtom } from "../lib/store/syncAtoms";
import { toast } from "sonner";

const SyncStatusHandler: React.FC = () => {
  const { data: syncFiles, isLoading, refetch } = useSyncActivity();
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isPermanentlyClosed, setIsPermanentlyClosed] = useState(false);
  // Get sync status from atoms
  const syncPercent = useAtomValue(syncPercentAtom);
  const syncStatus = useAtomValue(syncStatusAtom);
  // toast.success(`Files: ${JSON.stringify(syncFiles)}`);
  // Listen for refetch triggers from other components

  // Update dialog state based on sync activity and status
  useEffect(() => {
    const hasActiveSync =
      syncStatus?.in_progress || (syncPercent !== null && syncPercent < 100);
    const hasSyncFiles = syncFiles && syncFiles.length > 0;
    const hasUploadingFiles = syncFiles?.some(
      (file) => file.status === "uploading"
    );
    const isCompleted = syncPercent !== null && syncPercent >= 100;

    // Reset permanently closed state when a new sync starts (not completed)
    if (!isCompleted && isPermanentlyClosed) {
      setIsPermanentlyClosed(false);
    }

    // Show dialog if there's active sync or uploading files, but respect permanent closure
    if (
      (hasActiveSync || hasSyncFiles || hasUploadingFiles) &&
      !isPermanentlyClosed
    ) {
      refetch();
      setIsSyncOpen(true);
    }
  }, [syncFiles, syncPercent, syncStatus, refetch, isPermanentlyClosed]);

  // Handle manual close
  const handleClose = () => {
    setIsSyncOpen(false);
    setIsPermanentlyClosed(true);
  };

  // Don't render anything if there are no sync files and no active sync
  if (
    !syncFiles ||
    (syncFiles.length === 0 && !syncStatus?.in_progress) ||
    isPermanentlyClosed
  ) {
    return null;
  }

  return (
    <SyncStatusDialog
      open={!isLoading && isSyncOpen}
      onClose={handleClose}
      syncFiles={syncFiles || []}
    />
  );
};

export default SyncStatusHandler;
