"use client";

import { useEffect, useRef, useState } from "react";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  isSharedDrivesUnavailable,
  listDriveMembers,
} from "@/app/lib/tauri/sharedDrives";

const EMPTY: ReadonlyMap<string, number> = new Map();

/**
 * How many people each OWN drive has been shared with, by local label.
 *
 * There is no bulk endpoint: members are per drive
 * (`/v1/drives/{hash}/members`), and `/v1/drive-memberships` answers the
 * opposite question -- drives shared WITH this account, not by it. So this is
 * one request per owned drive, which is why it is deliberately restrained:
 *
 *   - it runs once per set of drives, not on focus and not on an interval;
 *   - it skips entirely when the feature is off;
 *   - a drive that fails is simply absent from the map, so one failure costs
 *     one badge rather than the whole set;
 *   - a feature-off server is silent, since that is the expected case.
 *
 * A bulk "drives I have shared" endpoint would replace this with one call and
 * is the right long-term fix; until then the cost is bounded by how many
 * drives a user has, which is small.
 */
export function useOwnedDriveShareCounts(
  ownLabels: readonly string[],
): ReadonlyMap<string, number> {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(EMPTY);
  // Re-run only when the SET of drives changes, not on every render that
  // hands us a new array identity for the same drives.
  const key = [...ownLabels].sort().join("\u0000");
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!SHARED_DRIVES_ENABLED || ownLabels.length === 0) return;
    if (lastKey.current === key) return;
    lastKey.current = key;

    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        ownLabels.map(async (label) => {
          try {
            const members = await listDriveMembers(label);
            return [label, members.length] as const;
          } catch (err) {
            if (!isSharedDrivesUnavailable(err)) {
              console.warn(
                `[useOwnedDriveShareCounts] members for ${label} failed:`,
                err,
              );
            }
            return null;
          }
        }),
      );
      if (cancelled) return;
      setCounts(
        new Map(
          entries.filter((e): e is readonly [string, number] => e !== null),
        ),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [key, ownLabels]);

  return counts;
}
