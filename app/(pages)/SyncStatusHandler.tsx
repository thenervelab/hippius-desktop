"use client";

import React, { useState, useEffect, forwardRef } from "react";
import { useAtom, useAtomValue } from "jotai";

import SyncStatusDialog from "./SyncStatusDialog";
import useSyncActivity from "../lib/hooks/useSyncActivity";
import {
  syncPercentAtom,
  syncStatusAtom,
  triggerSyncActivityRefetchAtom,
} from "../lib/store/syncAtoms";
import { toast } from "sonner";

type Props = {
  onSyncExpandedChange: (v: boolean) => void;
};

const SyncStatusHandler = forwardRef<HTMLDivElement, Props>(
  ({ onSyncExpandedChange }, ref) => {
    const { data: syncFiles, isLoading, refetch } = useSyncActivity();
    const [isSyncOpen, setIsSyncOpen] = useState(false);
    const [triggerCount] = useAtom(triggerSyncActivityRefetchAtom);
    // Get sync status from atoms
    const syncPercent = useAtomValue(syncPercentAtom);
    const syncStatus = useAtomValue(syncStatusAtom);

    // Listen for refetch triggers from other components
    useEffect(() => {
      if (triggerCount > 0) {
        refetch();
      }
    }, [triggerCount, refetch]);

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
      <SyncStatusDialog
        ref={ref}
        open={!isLoading && isSyncOpen}
        syncFiles={syncFiles || []}
        onExpandedChange={onSyncExpandedChange}
      />
    );
  }
);

export default SyncStatusHandler;
