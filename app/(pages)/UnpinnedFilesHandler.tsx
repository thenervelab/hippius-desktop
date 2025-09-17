"use client";

import React, { useState, useEffect } from "react";
import { useAtom } from "jotai";

import FileDetailsDialog, {
  FileDetail,
} from "../components/page-sections/files/ipfs/files-table/UnpinFilesDialog";
import useUnpinnedStorageRequests from "../lib/hooks/useUnpinnedStorageRequests";
import { triggerUnpinnedFilesRefetchAtom } from "../lib/global-atoms/unpinAtoms";

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

  // Don't render anything if there are no unpinned files or still loading
  if (!unpinnedFiles || unpinnedFiles.length === 0) {
    return null;
  }

  return (
    <FileDetailsDialog
      open={!isLoading && isUnpinnedOpen}
      unpinnedFiles={unpinnedFiles as FileDetail[]}
    />
  );
};

export default UnpinnedFilesHandler;
