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
 * - `hcfs_sync_completed`         → clear atom (only for the label that had conflicts)
 * - `hcfs_sync_error`             → clear atom (only for the label that had conflicts)
 * - `hcfs_review_mode_timeout`    → clear atom (review mode auto-expired after 5 min)
 */
export default function ConflictEventListener() {
  const setPendingConflicts = useSetAtom(pendingConflictsAtom);

  useEffect(() => {
    // Track which label has pending conflicts so we only clear
    // when THAT label completes, not when any other drive completes.
    let conflictLabel: string | null = null;

    const listeners = [
      listen<{ label: string; staged: StagedChanges }>("hcfs_conflicts_pending", (event) => {
        conflictLabel = event.payload.label;
        setPendingConflicts(event.payload.staged);
      }),
      listen<{ label: string }>("hcfs_sync_completed", (event) => {
        if (conflictLabel && event.payload.label === conflictLabel) {
          setPendingConflicts(null);
          conflictLabel = null;
        }
      }),
      listen<{ label: string }>("hcfs_sync_error", (event) => {
        if (conflictLabel && event.payload.label === conflictLabel) {
          setPendingConflicts(null);
          conflictLabel = null;
        }
      }),
      listen<{ label: string }>("hcfs_review_mode_timeout", (event) => {
        if (!conflictLabel || event.payload.label === conflictLabel) {
          setPendingConflicts(null);
          conflictLabel = null;
        }
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
