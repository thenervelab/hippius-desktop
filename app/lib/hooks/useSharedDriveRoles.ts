"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { rolesByLocalLabel } from "@/app/lib/shared-drives/driveRowSharing";
import type { DriveRole } from "@/app/lib/shared-drives/roles";
import {
  isSharedDrivesUnavailable,
  listMyDriveMemberships,
  type DriveMembershipInfo,
} from "@/app/lib/tauri/sharedDrives";

const EMPTY_ROLES: ReadonlyMap<string, DriveRole> = new Map();
const EMPTY_LIST: readonly DriveMembershipInfo[] = [];

export const SHARED_DRIVE_MEMBERSHIPS_QUERY_KEY = "shared-drive-memberships";

/**
 * The drives shared WITH this account, as the server lists them.
 *
 * One query, so every surface that asks — the drive list's row badge, the
 * header mark inside an open drive — reads one answer rather than each
 * fanning out its own membership listing and drifting.
 *
 * Failures collapse to an empty list on purpose. A missing membership costs a
 * badge detail, whereas surfacing a listing error would put a failure in front
 * of someone who did not ask for this surface; a feature-off server is the
 * expected case, not an exception.
 */
export function useSharedDriveMemberships(): readonly DriveMembershipInfo[] {
  return useSharedDriveMembershipsQuery().memberships;
}

/**
 * The listing plus whether it has answered yet.
 *
 * `isSettled` matters to anything that must know whether a drive is a member
 * drive BEFORE acting on it: until the listing lands, every drive looks own,
 * and asking an owner-only endpoint about somebody else's drive earns a
 * refusal the caller then has to explain away.
 */
export function useSharedDriveMembershipsQuery(): {
  memberships: readonly DriveMembershipInfo[];
  isSettled: boolean;
} {
  const { data, isFetched } = useQuery({
    queryKey: [SHARED_DRIVE_MEMBERSHIPS_QUERY_KEY],
    queryFn: async () => {
      try {
        return await listMyDriveMemberships();
      } catch (err) {
        if (!isSharedDrivesUnavailable(err)) {
          console.warn("[useSharedDriveMemberships] listing failed:", err);
        }
        return [] as DriveMembershipInfo[];
      }
    },
    enabled: SHARED_DRIVES_ENABLED,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return {
    memberships: data ?? EMPTY_LIST,
    // With the feature off nothing will ever be fetched, and a caller waiting
    // on `isSettled` would wait forever.
    isSettled: !SHARED_DRIVES_ENABLED || isFetched,
  };
}

/** The membership for one local drive label, or `undefined` if it is own. */
export function useSharedDriveMembership(label: string | null | undefined): {
  membership: DriveMembershipInfo | undefined;
  isSettled: boolean;
} {
  const { memberships, isSettled } = useSharedDriveMembershipsQuery();
  const membership = useMemo(
    () => (label ? memberships.find((m) => m.localLabel === label) : undefined),
    [memberships, label],
  );
  return { membership, isSettled };
}

/**
 * Roles for the shared drives synced on this device, keyed by local label.
 *
 * Drive rows come from `sync_paths` and roles from the membership listing, so
 * this is the join that lets a row say what the viewer can do in it. The key is
 * the local label, which both sides agree on: `folder_name` is
 * `sync_paths.label`, and so is a membership's `local_label`.
 */
export function useSharedDriveRoles(): ReadonlyMap<string, DriveRole> {
  const memberships = useSharedDriveMemberships();
  return useMemo(
    () => (memberships.length === 0 ? EMPTY_ROLES : rolesByLocalLabel(memberships)),
    [memberships],
  );
}
