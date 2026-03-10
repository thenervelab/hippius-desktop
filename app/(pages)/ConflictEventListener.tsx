"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { listen } from "@tauri-apps/api/event";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import type { StagedChanges } from "@/lib/types/syncTypes";

/**
 * Invisible component that listens for conflict-related Tauri events
 * and updates the pendingConflictsAtom accordingly.
 *
 * - `hcfs_conflicts_pending` → set atom with conflict data
 * - `hcfs_sync_completed`   → clear atom (conflicts resolved)
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
    ];

    return () => {
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [setPendingConflicts]);

  return null;
}
