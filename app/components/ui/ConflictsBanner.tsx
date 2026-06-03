"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import { useStagedChanges } from "@/lib/hooks/useStagedChanges";
import StagedChangesDialog from "@/components/page-sections/drive/StagedChangesDialog";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
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
      <div className="relative overflow-hidden rounded-xl border border-warning-50/40 bg-gradient-to-r from-warning-50/[0.14] to-warning-50/[0.04] px-4 py-3.5 mt-2 dark:border-warning-50/35 dark:from-warning-50/[0.16] dark:to-warning-50/[0.05]">
        <button
          onClick={handleDismiss}
          className="absolute right-3 top-3 text-grey-50 transition-colors hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-white"
          title="Dismiss and resume auto-sync"
          aria-label="Dismiss conflicts banner"
        >
          <X className="size-4" />
        </button>
        <div className="flex items-center gap-3 pr-8">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-50">
            <Icons.OctagonAlert className="size-4 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-grey-10 dark:text-white">
              {conflictCount} file conflict{conflictCount !== 1 ? "s" : ""} detected
            </p>
            <p className="text-xs text-grey-50 dark:text-grey-dark-700">
              Review and resolve them to resume syncing.
            </p>
          </div>
          <Button
            variant="primary"
            size="auto"
            className="h-[30px] gap-[10px] rounded-[6px] px-3 py-[10px] font-geist text-[14px] leading-[1.109] tracking-[-0.28px]"
            onClick={() => setDialogOpen(true)}
          >
            Review &amp; Resolve
          </Button>
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
