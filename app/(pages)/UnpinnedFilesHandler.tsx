"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";

import UnpinFilesDialog, { FileDetail } from "./UnpinFilesDialog";
import useUnpinnedStorageRequests from "../lib/hooks/useUnpinnedStorageRequests";
import { triggerUnpinnedFilesRefetchAtom } from "../lib/global-atoms/unpinAtoms";
import { syncPercentAtom, syncStatusAtom } from "../lib/store/syncAtoms";
import useSyncActivity from "../lib/hooks/useSyncActivity";
import SyncStatusHandler from "./SyncStatusHandler";

const UnpinnedFilesHandler: React.FC = () => {
  const {
    data: unpinnedFiles,
    isLoading,
    refetch,
  } = useUnpinnedStorageRequests();
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);
  const [isUnpinnedExpanded, setIsUnpinnedExpanded] = useState(false);
  const [triggerCount] = useAtom(triggerUnpinnedFilesRefetchAtom);
  const syncDialogRef = useRef<HTMLDivElement | null>(null);
  // Get sync state for positioning

  const { data: syncFiles } = useSyncActivity();
  const syncPercent = useAtomValue(syncPercentAtom);
  const syncStatus = useAtomValue(syncStatusAtom);
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isSyncExpanded, setIsSyncExpanded] = useState(false);

  // Listen for refetch triggers from other components
  useEffect(() => {
    if (triggerCount > 0) {
      refetch();
    }
  }, [triggerCount, refetch]);

  // Calculate sync dialog state
  useEffect(() => {
    const hasActiveSync =
      syncStatus?.in_progress || (syncPercent !== null && syncPercent < 100);
    const hasSyncFiles = syncFiles && syncFiles.length > 0;
    const hasUploadingFiles = syncFiles?.some(
      (file) => file.status === "uploading"
    );

    setIsSyncOpen(Boolean(hasActiveSync || hasSyncFiles || hasUploadingFiles));
  }, [syncFiles, syncPercent, syncStatus]);

  // Update dialog state based on unpinned files
  useEffect(() => {
    if (unpinnedFiles && unpinnedFiles.length > 0) {
      setIsUnpinnedOpen(true);
    } else {
      setIsUnpinnedOpen(false);
      setIsUnpinnedExpanded(false);
    }
  }, [unpinnedFiles]);

  return (
    <>
      {/* Render unpinned files dialog */}
      {unpinnedFiles && unpinnedFiles.length > 0 && (
        <UnpinFilesDialog
          open={!isLoading && isUnpinnedOpen}
          unpinnedFiles={unpinnedFiles as FileDetail[]}
          onExpandedChange={setIsUnpinnedExpanded}
          syncDialogOpen={isSyncOpen}
          syncDialogExpanded={isSyncExpanded}
          syncDialogRef={syncDialogRef}
        />
      )}

      {/* Render sync status dialog with unpinned dialog state */}
      <SyncStatusHandler
        ref={syncDialogRef}
        onSyncExpandedChange={setIsSyncExpanded}
      />
    </>
  );
};

export default UnpinnedFilesHandler;
