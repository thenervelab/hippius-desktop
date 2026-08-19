"use client";

import { useState, useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import { useStagedChanges } from "@/lib/hooks/useStagedChanges";
import StagedChangesDialog from "@/components/page-sections/drive/StagedChangesDialog";
import {
  reconcileResolutions,
  type ResolutionMap,
} from "@/components/page-sections/drive/stagedChangesLogic";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import type { StagedChanges } from "@/lib/types/syncTypes";

/**
 * Renders one independent conflict banner per drive that has pending conflicts.
 * Conflict state is now keyed by drive label (see `pendingConflictsAtom`), so a
 * second drive's conflicts no longer overwrite the first's and resolving one
 * drive leaves the others' banners intact (upstream F16).
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
 * Note: there is intentionally NO cancel-on-unmount here (upstream F16/F42).
 * `cancel_review` arms a per-drive cooldown that suppresses fresh conflict
 * dialogs, and a row cannot distinguish "the engine resolved this entry"
 * (completed/error/timeout removed it) from "the user navigated away" — firing
 * it on every unmount would re-arm that cooldown after a normal resolution.
 * Explicit dismiss/resolve cancels this drive's review directly; navigate-away
 * is covered by the engine's 5-minute REVIEW_MODE_TIMEOUT.
 */
function ConflictBannerRow({
  label,
  staged,
}: {
  label: string;
  staged: StagedChanges;
}) {
  const setPendingConflicts = useSetAtom(pendingConflictsAtom);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Resolutions live HERE, not in the dialog. The engine re-emits
  // `hcfs_conflicts_pending` (a fresh `staged` object) on every re-stage while
  // review mode is armed, and the dialog used to wipe its own state on that
  // identity change — silently discarding an in-progress review. Owning them
  // one level up also means closing the dialog, or a sync that never started,
  // doesn't cost the user their choices.
  const [resolutions, setResolutions] = useState<ResolutionMap>({});
  const { syncWithResolutions, cancelReview, isSyncing } =
    useStagedChanges(label);

  // Keep picks whose conflict the engine still reports; drop the rest so a
  // stale file_id can never be submitted.
  useEffect(() => {
    setResolutions((prev) => reconcileResolutions(prev, staged.conflicts));
  }, [staged]);

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

  const handleSync = useCallback(async () => {
    // Close immediately and hand progress off to the sidebar sync widget.
    // `sync_with_conflict_resolutions` runs the ENTIRE cycle inline — on a
    // large plan that is minutes of a modal spinner with Cancel disabled,
    // which users read as a hung button. The dialog's job (collecting
    // resolutions) is done the moment it's submitted.
    setDialogOpen(false);

    const result = await syncWithResolutions(resolutions);
    if (result.ok) {
      dropSelf();
      setResolutions({});
      return;
    }

    // The sync never started or failed outright. Keep the banner so the user
    // can reopen — `resolutions` is still here, so their choices are intact.
    // (On a genuine engine failure Rust also emits `hcfs_sync_error`, which
    // drops this row via ConflictEventListener; the engine then re-detects the
    // conflicts on the next cycle and raises a fresh banner.)
    if (result.syncInProgress) {
      toast.warning("A sync cycle is already running for this drive", {
        description:
          "Your choices are saved — reopen Review & Resolve and press Sync Now again in a moment.",
        duration: 8000,
      });
    } else {
      toast.error("Couldn't apply the conflict resolutions", {
        description: result.message,
        duration: 8000,
      });
    }
  }, [syncWithResolutions, dropSelf, resolutions]);

  const conflictCount = staged.conflicts.length;

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
        stagedChanges={staged}
        isSyncing={isSyncing}
        resolutions={resolutions}
        onResolutionsChange={setResolutions}
        onSync={handleSync}
        onCancel={() => setDialogOpen(false)}
      />
    </>
  );
}
