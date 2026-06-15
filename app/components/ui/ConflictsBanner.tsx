"use client";

import { useState, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import { useStagedChanges } from "@/lib/hooks/useStagedChanges";
import StagedChangesDialog from "@/components/page-sections/files/StagedChangesDialog";
import { Icons } from "@/components/ui";
import type { ConflictResolution, StagedChanges } from "@/lib/types/syncTypes";

/**
 * Renders one independent conflict banner per drive that has pending conflicts.
 * Conflict state is now keyed by drive label (see `pendingConflictsAtom`), so a
 * second drive's conflicts no longer overwrite the first's and resolving one
 * drive leaves the others' banners intact.
 */
export default function ConflictsBanner() {
  const pendingConflicts = useAtomValue(pendingConflictsAtom);
  if (pendingConflicts.size === 0) return null;
  return (
    <>
      {Array.from(pendingConflicts.entries()).map(([label, staged]) => (
        <ConflictBannerRow key={label} label={label} staged={staged} />
      ))}
    </>
  );
}

/**
 * A single drive's conflict banner. Every action (review, resolve, dismiss) is
 * scoped to `label` so it only touches this drive's review state.
 *
 * Note: there is intentionally NO cancel-on-unmount here. `cancel_review` arms a
 * 60s per-drive cooldown that suppresses fresh conflict dialogs, and a row
 * cannot distinguish "the engine resolved this entry" (completed/error/timeout
 * removed it) from "the user navigated away" — firing it on every unmount would
 * re-arm that cooldown after a normal resolution. Explicit dismiss/resolve cancel
 * this drive's review directly; navigate-away is covered by the engine's 5-minute
 * REVIEW_MODE_TIMEOUT.
 */
function ConflictBannerRow({ label, staged }: { label: string; staged: StagedChanges }) {
  const setPendingConflicts = useSetAtom(pendingConflictsAtom);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { syncWithResolutions, cancelReview, isSyncing } = useStagedChanges(label);

  const dropSelf = useCallback(() => {
    setPendingConflicts((prev) => {
      if (!prev.has(label)) return prev;
      const next = new Map(prev);
      next.delete(label);
      return next;
    });
  }, [setPendingConflicts, label]);

  const handleDismiss = useCallback(async () => {
    await cancelReview();
    dropSelf();
  }, [cancelReview, dropSelf]);

  const handleSync = useCallback(
    async (resolutions: Record<string, ConflictResolution>) => {
      await syncWithResolutions(resolutions);
      dropSelf();
      setDialogOpen(false);
    },
    [syncWithResolutions, dropSelf]
  );

  const conflictCount = staged.conflicts.length;

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
        stagedChanges={staged}
        isSyncing={isSyncing}
        onSync={handleSync}
        onCancel={() => setDialogOpen(false)}
      />
    </>
  );
}
