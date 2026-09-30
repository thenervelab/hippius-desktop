"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { folderSharingKey } from "@/app/lib/shared-drives/folderRowSharing";
import {
  isFolderGrantLabel,
  isSharedDriveLabel,
} from "@/app/lib/shared-drives/sharedDriveLabel";
import {
  listOwnedFolderSharing,
  type FolderSharingSummary,
} from "@/app/lib/tauri/sharedDrives";
import { useSharedDriveMembership } from "./useSharedDriveRoles";

/**
 * Query key prefix. `invalidateOwnedDriveSharing` refreshes it too, so every
 * mutation that already refreshes the drive mark (an invite, a revoke, a
 * holder removed) refreshes the folder marks with it.
 */
export const OWNED_FOLDER_SHARING_QUERY_KEY = "owned-folder-sharing";

const EMPTY: ReadonlyMap<string, FolderSharingSummary> = new Map();

/**
 * The folders of ONE own drive that are shared on their own, by folder path
 * (see `folderSharingKey`).
 *
 * Owner only: skipped for a drive shared with this account (by local label
 * or a browse label) and until the membership listing has settled, since
 * before it answers every drive looks own. Empty while loading or on a
 * failure, which draws no folder mark: a mark that appears a moment late is
 * better than one that flashes on the wrong folder.
 *
 * Every row of the open drive asks with the same label, so TanStack answers
 * them all from one request.
 */
export function useOwnedFolderSharing(
  label: string | null | undefined,
): ReadonlyMap<string, FolderSharingSummary> {
  const { membership, isSettled } = useSharedDriveMembership(label);
  const own =
    !!label &&
    isSettled &&
    !membership &&
    !isSharedDriveLabel(label) &&
    !isFolderGrantLabel(label);

  const { data } = useQuery({
    queryKey: [OWNED_FOLDER_SHARING_QUERY_KEY, label],
    queryFn: () => listOwnedFolderSharing(label as string),
    enabled: SHARED_DRIVES_ENABLED && own,
    // Same terms as the drive mark: this app's own mutations invalidate it,
    // another device's changes land on the next visit.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 2,
  });

  return useMemo(() => {
    if (!data || !own) return EMPTY;
    return new Map(data.map((f) => [folderSharingKey(f.path), f] as const));
  }, [data, own]);
}

/** One folder's entry, when it is shared on its own. */
export function useOwnedFolderSharingAt(
  label: string | null | undefined,
  path: string | null | undefined,
): FolderSharingSummary | undefined {
  const byPath = useOwnedFolderSharing(label);
  const key = folderSharingKey(path);
  return key ? byPath.get(key) : undefined;
}
