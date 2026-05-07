"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import { useStagedChanges } from "@/lib/hooks/useStagedChanges";
import StagedChangesDialog from "@/components/page-sections/drive/StagedChangesDialog";
import { Icons } from "@/components/ui";
import { invoke } from "@tauri-apps/api/core";
import type { ConflictResolution } from "@/lib/types/syncTypes";

export default function ConflictsBanner() {
  const [pendingConflicts, setPendingConflicts] = useAtom(pendingConflictsAtom);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { syncWithResolutions, cancelReview, isSyncing } = useStagedChanges();

  // Track whether review is active via ref so the unmount cleanup sees the latest value
  const reviewActiveRef = useRef(false);
  useEffect(() => {
    reviewActiveRef.current = pendingConflicts !== null;
  }, [pendingConflicts]);

  // Safety net: cancel review mode on unmount to prevent stuck SYNC_REVIEW_MODE
  useEffect(() => {
    return () => {
      if (reviewActiveRef.current) {
        invoke("cancel_review").catch((err: unknown) => console.warn("[ConflictsBanner] cancel_review failed on unmount:", err));
      }
    };
  }, []);

  const handleDismiss = useCallback(async () => {
    await cancelReview();
    setPendingConflicts(null);
  }, [cancelReview, setPendingConflicts]);

  const handleSync = useCallback(
    async (resolutions: Record<string, ConflictResolution>) => {
      await syncWithResolutions(resolutions);
      setPendingConflicts(null);
      setDialogOpen(false);
    },
    [syncWithResolutions, setPendingConflicts]
  );

  if (!pendingConflicts) return null;

  const conflictCount = pendingConflicts.conflicts.length;

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-4 py-2 mt-2 rounded-lg border border-warning-50/30 bg-warning-50/5">
        <div className="flex items-center gap-2 min-w-0">
          <Icons.OctagonAlert className="size-4 text-warning-50 shrink-0" />
          <span className="text-sm text-grey-10">
            {conflictCount} file conflict{conflictCount !== 1 ? "s" : ""}{" "}
            detected during sync.
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setDialogOpen(true)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-primary-50 text-white hover:bg-primary-40 shadow-outer-action-button transition-colors"
          >
            Review &amp; Resolve
          </button>
          <button
            onClick={handleDismiss}
            className="p-1 rounded hover:bg-grey-90 transition-colors"
            title="Dismiss and resume auto-sync"
          >
            <Icons.CloseCircle className="size-4 text-grey-40" />
          </button>
        </div>
      </div>

      <StagedChangesDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        stagedChanges={pendingConflicts}
        isSyncing={isSyncing}
        onSync={handleSync}
        onCancel={() => setDialogOpen(false)}
      />
    </>
  );
}
