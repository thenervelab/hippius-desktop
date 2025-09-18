"use client";

import React, { useState, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";

import SyncStatusDialog from "./SyncStatusDialog";
import useSyncActivity from "../lib/hooks/useSyncActivity";
import {
  syncPercentAtom,
  syncStatusAtom,
  triggerSyncActivityRefetchAtom,
} from "../lib/store/syncAtoms";
import { toast } from "sonner";

const SyncStatusHandler: React.FC = () => {
  const { data: syncFiles, isLoading, refetch } = useSyncActivity();
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [triggerCount] = useAtom(triggerSyncActivityRefetchAtom);
  // Get sync status from atoms
  const syncPercent = useAtomValue(syncPercentAtom);
  const syncStatus = useAtomValue(syncStatusAtom);
  // toast.success(`Files: ${JSON.stringify(syncFiles)}`);
  // Listen for refetch triggers from other components
  useEffect(() => {
    if (triggerCount > 0) {
      refetch();
    }
  }, [triggerCount, refetch]);

  // Poll sync files every 3 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
    }, 3000); // 3 seconds

    return () => clearInterval(interval);
  }, [refetch]);

  // Update dialog state based on sync activity and status
  useEffect(() => {
    const hasActiveSync =
      syncStatus?.in_progress || (syncPercent !== null && syncPercent < 100);
    const hasSyncFiles = syncFiles && syncFiles.length > 0;
    const hasUploadingFiles = syncFiles?.some(
      (file) => file.status === "uploading"
    );

    // Show dialog if there's active sync or uploading files
    if (hasActiveSync || hasSyncFiles || hasUploadingFiles) {
      setIsSyncOpen(true);
    } else {
      setIsSyncOpen(false);
    }
  }, [syncFiles, syncPercent, syncStatus]);

  // Don't render anything if there are no sync files and no active sync
  if (!syncFiles || (syncFiles.length === 0 && !syncStatus?.in_progress)) {
    return null;
  }

  return (
    <>
      <SyncStatusDialog
        open={!isLoading && isSyncOpen}
        syncFiles={syncFiles || []}
      />
    </>
  );
};

export default SyncStatusHandler;
