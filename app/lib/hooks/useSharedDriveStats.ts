"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  isSharedDrivesUnavailable,
  listSharedDriveStats,
  type SharedDriveStats,
} from "@/app/lib/tauri/sharedDrives";

const EMPTY: ReadonlyMap<string, SharedDriveStats> = new Map();

/** The key both sides agree on: a drive is (owner, folder hash), never either alone. */
export function sharedDriveStatsKey(identity: {
  ownerSs58: string;
  folderHash: string;
}): string {
  return `${identity.ownerSs58}:${identity.folderHash}`;
}

/**
 * Size, file count and last-changed for the drives shared with this account.
 *
 * A drive MISSING from the map is unknown, not empty. The membership listing
 * carries no counts, so a row starts with nothing to show and only the
 * owner's listing can correct it; rendering an uncorrected row as "0 B, 0
 * files" claims a drive is empty when nobody successfully asked.
 */
export function useSharedDriveStats(
  owners: readonly string[],
): ReadonlyMap<string, SharedDriveStats> {
  // Sorted and deduped so the same set of owners in any order is one query,
  // and so several drives from one person cost one request.
  const key = useMemo(() => [...new Set(owners)].sort(), [owners]);

  const { data } = useQuery({
    queryKey: ["shared-drive-stats", ...key],
    queryFn: async () => {
      try {
        return await listSharedDriveStats(key);
      } catch (err) {
        if (!isSharedDrivesUnavailable(err)) {
          console.warn("[useSharedDriveStats] listing failed:", err);
        }
        // Unknown, not empty — the map simply holds nothing for these drives.
        return [] as SharedDriveStats[];
      }
    },
    enabled: SHARED_DRIVES_ENABLED && key.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  return useMemo(() => {
    if (!data || data.length === 0) return EMPTY;
    return new Map(data.map((s) => [sharedDriveStatsKey(s), s] as const));
  }, [data]);
}
