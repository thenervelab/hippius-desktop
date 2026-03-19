"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import type { StagedChanges } from "@/lib/types/syncTypes";

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
    const listeners = [
      listen<{ label: string; staged: StagedChanges }>("hcfs_conflicts_pending", (event) => {
        setPendingConflicts(event.payload.staged);
      }),
      listen("hcfs_sync_completed", () => {
        setPendingConflicts(null);
      }),
      listen("hcfs_sync_error", () => {
        setPendingConflicts(null);
      }),
      listen<{ label: string }>("hcfs_review_mode_timeout", () => {
        setPendingConflicts(null);
        toast.warning("Review mode timed out — conflicts were skipped", {
          duration: 6000,
        });
      }),
    ];

    return () => {
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [setPendingConflicts]);

  return null;
}
