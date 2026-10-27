"use client";

// The memberships fetch behind "Shared with me", lifted out of
// `SharedWithMeSection` so the Shared Drives page can read the same answer
// (its tab counts and totals) without a second `list_my_drive_memberships`
// call. The section still owns it on its own where nobody else needs it
// (Settings).

import { useCallback, useEffect, useState } from "react";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  isSharedDrivesUnavailable,
  listMyDriveMemberships,
} from "@/app/lib/tauri/sharedDrives";
import type { SharedWithMeData } from "./sharedWithMeState";

export interface DriveMemberships {
  data: SharedWithMeData;
  /** Fetch again, keeping the rows on screen while it runs. */
  reload: () => Promise<void>;
  /** The server turned the feature off mid-session: hide quietly. */
  markUnavailable: () => void;
}

/**
 * Load the drives shared with this account once, when `enabled`. A
 * passive mount-time fetch: a failure is logged and settles as `error`,
 * never a toast.
 */
export function useDriveMemberships(enabled = true): DriveMemberships {
  const [data, setData] = useState<SharedWithMeData>({ kind: "idle" });

  const reload = useCallback(async () => {
    setData((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const memberships = await listMyDriveMemberships();
      setData({ kind: "ready", memberships });
    } catch (err) {
      if (isSharedDrivesUnavailable(err)) {
        setData({ kind: "unavailable" });
      } else {
        console.error("Failed to load drive memberships:", err);
        setData({ kind: "error" });
      }
    }
  }, []);

  const markUnavailable = useCallback(() => setData({ kind: "unavailable" }), []);

  useEffect(() => {
    if (!SHARED_DRIVES_ENABLED || !enabled) return;
    void reload();
  }, [enabled, reload]);

  return { data, reload, markUnavailable };
}
