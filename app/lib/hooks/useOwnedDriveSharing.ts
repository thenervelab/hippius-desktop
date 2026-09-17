"use client";

import { useEffect, useRef, useState } from "react";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  isSharedDrivesUnavailable,
  listDriveInvites,
  listDriveMembers,
} from "@/app/lib/tauri/sharedDrives";

/** What a drive row needs to know about its own sharing. */
export interface DriveSharing {
  /** People who have joined. */
  memberCount: number;
  /** Invite links that can still admit someone. */
  liveInviteCount: number;
}

const EMPTY: ReadonlyMap<string, DriveSharing> = new Map();

/**
 * Sharing state for each OWN drive, by local label.
 *
 * "Shared" means members OR a live invite -- both, because either alone is
 * wrong. A drive whose invite has been sent but not yet accepted has no
 * members and is very much shared; a drive whose invite expired after people
 * joined has no live link and is still shared.
 *
 * There is no bulk endpoint -- members and invites are both per drive, and
 * `/v1/drive-memberships` answers the opposite question -- so this is two
 * requests per owned drive. It is therefore deliberately restrained: once per
 * set of drives, never on focus or an interval, skipped entirely when the
 * feature is off, and a drive that fails is absent from the map rather than
 * failing the set. A bulk "drives I have shared" endpoint would collapse it to
 * one call and is the right fix when the server offers one.
 */
export function useOwnedDriveSharing(
  ownLabels: readonly string[],
): ReadonlyMap<string, DriveSharing> {
  const [sharing, setSharing] = useState<ReadonlyMap<string, DriveSharing>>(EMPTY);
  // Re-run only when the SET of drives changes, not on every render that
  // hands us a new array identity for the same drives.
  const key = [...ownLabels].sort().join("|");
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!SHARED_DRIVES_ENABLED || ownLabels.length === 0) return;
    if (lastKey.current === key) return;
    lastKey.current = key;

    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        ownLabels.map(async (label) => {
          // SETTLED, not `all`. The two listings answer independently and one
          // must not erase the other: `/invites` is a newer route than
          // `/members`, so a server that serves members but not invites would
          // otherwise drop the drive entirely and hide a badge for people who
          // have demonstrably joined.
          const [membersResult, invitesResult] = await Promise.allSettled([
            listDriveMembers(label),
            listDriveInvites(label),
          ]);

          for (const result of [membersResult, invitesResult]) {
            if (
              result.status === "rejected" &&
              !isSharedDrivesUnavailable(result.reason)
            ) {
              console.warn(`[useOwnedDriveSharing] ${label}:`, result.reason);
            }
          }

          // Both failing means we know nothing about this drive, which is not
          // the same as knowing it is private -- leave it out of the map.
          if (
            membersResult.status === "rejected" &&
            invitesResult.status === "rejected"
          ) {
            return null;
          }

          return [
            label,
            {
              memberCount:
                membersResult.status === "fulfilled"
                  ? membersResult.value.length
                  : 0,
              liveInviteCount:
                invitesResult.status === "fulfilled"
                  ? invitesResult.value.filter((i) => i.valid && !i.revoked)
                      .length
                  : 0,
            },
          ] as const;
        }),
      );
      if (cancelled) return;
      setSharing(
        new Map(
          entries.filter((e): e is readonly [string, DriveSharing] => e !== null),
        ),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [key, ownLabels]);

  return sharing;
}

/** Whether a drive has been shared at all. */
export function isDriveShared(sharing: DriveSharing | undefined): boolean {
  if (!sharing) return false;
  return sharing.memberCount > 0 || sharing.liveInviteCount > 0;
}
