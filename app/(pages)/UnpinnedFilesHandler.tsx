"use client";

import React, { useState, useEffect } from "react";
import { useAtom } from "jotai";

import UnpinFilesDialog, { FileDetail } from "./UnpinFilesDialog";
import useUnpinnedStorageRequests from "../lib/hooks/useUnpinnedStorageRequests";
import { triggerUnpinnedFilesRefetchAtom } from "../lib/global-atoms/unpinAtoms";
import SyncStatusHandler from "./SyncStatusHandler";
import { createPortal } from "react-dom";

const UnpinnedFilesHandler: React.FC = () => {
  const {
    data: unpinnedFiles,
    isLoading,
    refetch,
  } = useUnpinnedStorageRequests();
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);
  const [triggerCount] = useAtom(triggerUnpinnedFilesRefetchAtom);

  // Listen for refetch triggers from other components
  useEffect(() => {
    if (triggerCount > 0) {
      refetch();
    }
  }, [triggerCount, refetch]);

  // Update dialog state based on unpinned files
  useEffect(() => {
    if (unpinnedFiles && unpinnedFiles.length > 0) {
      setIsUnpinnedOpen(true);
    } else {
      setIsUnpinnedOpen(false);
    }
  }, [unpinnedFiles]);

  return (
    <>
      {createPortal(
        <div className="fixed z-[10] right-4 sm:right-12 bottom-20 sm:bottom-7 pointer-events-none">
          <div className="flex flex-col gap-4 items-end pointer-events-auto">
            {unpinnedFiles && unpinnedFiles.length > 0 && (
              <UnpinFilesDialog
                open={!isLoading && isUnpinnedOpen}
                unpinnedFiles={unpinnedFiles as FileDetail[]}
              />
            )}

            <SyncStatusHandler />
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default UnpinnedFilesHandler;
