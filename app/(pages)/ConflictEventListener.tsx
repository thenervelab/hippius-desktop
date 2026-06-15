"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import type { StagedChanges } from "@/lib/types/syncTypes";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Invisible component that listens for conflict-related Tauri events and
 * updates the per-drive `pendingConflictsAtom` map. Every event carries the
 * owning drive `label`, so each write/delete is scoped to that drive — one
 * drive's completion no longer clears another drive's pending conflicts
 * (upstream F16).
 *
 * - `hcfs_conflicts_pending`   → set this drive's conflicts
 * - `hcfs_sync_completed`      → drop this drive (conflicts resolved)
 * - `hcfs_sync_error`          → drop this drive (sync failed)
 * - `hcfs_review_mode_timeout` → drop this drive (review auto-expired after 5 min)
 */
export default function ConflictEventListener() {
  const setPendingConflicts = useSetAtom(pendingConflictsAtom);

  useEffect(() => {
    const dropLabel = (label: string) =>
      setPendingConflicts((prev) => {
        if (!prev.has(label)) return prev;
        const next = new Map(prev);
        next.delete(label);
        return next;
      });

    const { cleanup } = registerTauriListeners([
      ["hcfs_conflicts_pending", (event) => {
        const payload = event.payload as { label: string; staged: StagedChanges };
        setPendingConflicts((prev) => new Map(prev).set(payload.label, payload.staged));
      }],
      ["hcfs_sync_completed", (event) => {
        dropLabel((event.payload as { label: string }).label);
      }],
      ["hcfs_sync_error", (event) => {
        dropLabel((event.payload as { label: string }).label);
      }],
      ["hcfs_review_mode_timeout", (event) => {
        dropLabel((event.payload as { label: string }).label);
        toast.warning("Review mode timed out — conflicts were skipped", {
          duration: 6000,
        });
      }],
    ]);

    return cleanup;
  }, [setPendingConflicts]);

  return null;
}
