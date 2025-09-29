"use client";

import React, { useEffect, useMemo, useRef, useCallback } from "react";
import { useAtom } from "jotai";
import UnpinFilesDialog, { FileDetail } from "./UnpinFilesDialog";
import useUnpinnedStorageRequests from "../lib/hooks/useUnpinnedStorageRequests";
import SyncStatusHandler from "./SyncStatusHandler";
import { createPortal } from "react-dom";
import {
  isUnpinnedDialogOpenAtom,
  triggerUnpinnedFilesRefetchAtom,
} from "../lib/global-atoms/unpinAtoms";
import { useBreakpoint } from "../lib/hooks";

const UnpinnedFilesHandler: React.FC = () => {
  const {
    data: unpinnedFiles,
    isLoading,
    refetch,
  } = useUnpinnedStorageRequests();
  const { isMobile } = useBreakpoint();

  const [isUnpinnedOpen, setIsUnpinnedOpen] = useAtom(isUnpinnedDialogOpenAtom);
  const [triggerCount] = useAtom(triggerUnpinnedFilesRefetchAtom);

  const stackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (triggerCount > 0) refetch();
  }, [triggerCount, refetch]);

  // Update dialog state based on unpinned files
  useEffect(() => {
    if (unpinnedFiles && unpinnedFiles.length > 0 && !isMobile) {
      setIsUnpinnedOpen(true);
    } else {
      setIsUnpinnedOpen(false);
    }
  }, [unpinnedFiles, isMobile, setIsUnpinnedOpen]);

  // Compute whether the “stack” exists and should reserve space
  const stackActive = useMemo(() => {
    if (isMobile) return false;
    if (isLoading) return false;
    if (!isUnpinnedOpen) return false;
    return !!(unpinnedFiles && unpinnedFiles.length > 0);
  }, [isMobile, isLoading, isUnpinnedOpen, unpinnedFiles]);

  // Update CSS variable to push the global Toaster above our stack
  const updateToastBottom = useCallback(() => {
    const el = stackRef.current;
    if (!el || !stackActive) {
      // Remove so RootLayout gets default (24px)
      document.documentElement.style.removeProperty("--toast-bottom-offset");
      return;
    }
    const rect = el.getBoundingClientRect();
    const gap = 12;
    const bottom = Math.max(window.innerHeight - rect.top + gap, 24);
    document.documentElement.style.setProperty(
      "--toast-bottom-offset",
      `${bottom}px`
    );
  }, [stackActive]);

  // Watch size and window changes
  useEffect(() => {
    updateToastBottom();
    const el = stackRef.current;
    const ro = el ? new ResizeObserver(updateToastBottom) : null;

    if (el && ro) ro.observe(el);
    window.addEventListener("resize", updateToastBottom);

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", updateToastBottom);
      document.documentElement.style.removeProperty("--toast-bottom-offset");
    };
  }, [updateToastBottom]);

  // Also re-run when activity toggles
  useEffect(() => {
    updateToastBottom();
  }, [stackActive, updateToastBottom]);

  return (
    <>
      {createPortal(
        <div
          ref={stackRef}
          className="fixed z-[10] right-6 bottom-20 sm:bottom-7 pointer-events-none"
        >
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
