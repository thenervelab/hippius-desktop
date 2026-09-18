"use client";

import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  listOwnedDriveSharing,
  type DriveSharingSummary,
} from "@/app/lib/tauri/sharedDrives";

/** What a drive row needs to know about its own sharing. */
export type DriveSharing = Omit<DriveSharingSummary, "label">;

/**
 * Query key prefix. Every mutation that changes who can reach a drive — a
 * mint, a revoke, a member removed or re-roled — invalidates it through
 * {@link invalidateOwnedDriveSharing} so the row's badge follows the change
 * without a reload.
 */
export const OWNED_DRIVE_SHARING_QUERY_KEY = "owned-drive-sharing";

const EMPTY: ReadonlyMap<string, DriveSharing> = new Map();

/**
 * Sharing state for each OWN drive, by local label.
 *
 * One TanStack query over the `list_owned_drive_sharing` IPC, which does the
 * per-drive fan-out and the fold in Rust. The query owns the request
 * lifecycle, and that is the point: the previous hand-rolled effect listed
 * the labels array in its deps, so every re-render of the drive page — a
 * sync tick, a progress event — re-ran the effect, whose cleanup cancelled
 * the fetch in flight, while its own "already asked" guard stopped a
 * replacement from starting. The backend answered every time and the row
 * never saw it. Pinned by `useOwnedDriveSharing.test.tsx`.
 *
 * Keyed on the sorted SET of labels, so a fresh array identity for the same
 * drives is a cache hit, and the drive page and the settings sync manager
 * share one answer instead of asking twice.
 *
 * A drive missing from the map is UNKNOWN, not private: the IPC omits a
 * drive whose listings both failed.
 */
export function useOwnedDriveSharing(
  ownLabels: readonly string[],
): ReadonlyMap<string, DriveSharing> {
  const key = useMemo(() => [...ownLabels].sort(), [ownLabels]);

  const { data } = useQuery({
    queryKey: [OWNED_DRIVE_SHARING_QUERY_KEY, ...key],
    queryFn: () => listOwnedDriveSharing(key),
    enabled: SHARED_DRIVES_ENABLED && key.length > 0,
    // Two requests per drive on the server side, so no interval and no focus
    // refetch: the state changes only through this app's own mutations,
    // which invalidate explicitly, or from another device, which the next
    // navigation onto the list picks up.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // A boot-time miss must not hide the badge for the whole session.
    retry: 2,
  });

  return useMemo(() => {
    if (!data) return EMPTY;
    return new Map(
      data.map(({ label, ...sharing }) => [label, sharing] as const),
    );
  }, [data]);
}

/** Refresh every drive row's sharing state after a mutation. */
export function invalidateOwnedDriveSharing(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: [OWNED_DRIVE_SHARING_QUERY_KEY],
  });
}

/**
 * Whether a drive has been shared at all.
 *
 * Any invite counts, not just a live one. Keying on live links alone made a
 * drive whose invites had lapsed look exactly like one that was never shared
 * -- no badge, no way in to the links -- which is wrong twice over: the owner
 * did share it, and the lapsed links are the very thing they might want to
 * review or replace.
 */
export function isDriveShared(sharing: DriveSharing | undefined): boolean {
  if (!sharing) return false;
  return sharing.memberCount > 0 || sharing.totalInviteCount > 0;
}
