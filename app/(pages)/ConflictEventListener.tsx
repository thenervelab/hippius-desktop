"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import type { StagedChanges } from "@/lib/types/syncTypes";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Invisible component that listens for conflict-related Tauri events
 * and updates the pendingConflictsAtom accordingly.
 *
 * - `hcfs_conflicts_pending`      → set atom with conflict data
 * - `hcfs_sync_completed`         → clear atom (conflicts resolved)
 * - `hcfs_sync_error`             → clear atom (sync failed)
 * - `hcfs_review_mode_timeout`    → clear atom (review mode auto-expired after 5 min)
 */
export default function ConflictEventListener() {
  const setPendingConflicts = useSetAtom(pendingConflictsAtom);

  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      ["hcfs_conflicts_pending", (event) => {
        const payload = event.payload as { label: string; staged: StagedChanges };
        setPendingConflicts(payload.staged);
      }],
      ["hcfs_sync_completed", () => {
        setPendingConflicts(null);
      }],
      ["hcfs_sync_error", () => {
        setPendingConflicts(null);
      }],
      ["hcfs_review_mode_timeout", () => {
        setPendingConflicts(null);
        toast.warning("Review mode timed out — conflicts were skipped", {
          duration: 6000,
        });
      }],
    ]);

    return cleanup;
  }, [setPendingConflicts]);

  return null;
}
