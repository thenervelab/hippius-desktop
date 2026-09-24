"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { useAtomValue } from "jotai";
import {
  manageableMemberDriveLabels,
  rolesByLocalLabel,
  writableMemberDriveLabels,
} from "@/app/lib/shared-drives/driveRowSharing";
import { parseFolderGrantLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import { folderRolesEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { DriveRole } from "@/app/lib/shared-drives/roles";
import {
  isSharedDrivesUnavailable,
  listMyDriveMemberships,
  listMyFolderGrants,
  type DriveMembershipInfo,
  type MyFolderGrantInfo,
} from "@/app/lib/tauri/sharedDrives";

const EMPTY_ROLES: ReadonlyMap<string, DriveRole> = new Map();
const EMPTY_LIST: readonly DriveMembershipInfo[] = [];
const EMPTY_LABELS: ReadonlySet<string> = new Set();

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
 * The membership for a drive named by its WIRE identity.
 *
 * A drive browsed without syncing it has no local label to look up, so the
 * owner + folder hash is the only handle there is.
 */
export function useSharedDriveMembershipByIdentity(
  identity: { ownerSs58: string; folderHash: string } | null | undefined,
): { membership: DriveMembershipInfo | undefined; isSettled: boolean } {
  const { memberships, isSettled } = useSharedDriveMembershipsQuery();
  const membership = useMemo(
    () =>
      identity
        ? memberships.find(
            (m) =>
              m.ownerSs58 === identity.ownerSs58 &&
              m.folderHash === identity.folderHash,
          )
        : undefined,
    [memberships, identity?.ownerSs58, identity?.folderHash],
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

/**
 * The local labels of the shared drives synced on this device.
 *
 * The set form, for the row-by-row questions: a listing can hold rows from
 * more than one drive, so "is this row's drive mine?" is asked per row and a
 * set answers it without re-scanning the memberships each time.
 *
 * It covers only drives with a local row. A drive being browsed without
 * syncing it has no label here, and needs none — its synthetic label says it
 * is shared on its own (`isMemberDriveLabel`).
 */
export function useMemberDriveLabels(): ReadonlySet<string> {
  const memberships = useSharedDriveMemberships();
  return useMemo(
    () =>
      memberships.length === 0
        ? EMPTY_LABELS
        : new Set(memberships.map((m) => m.localLabel).filter((l): l is string => Boolean(l))),
    [memberships],
  );
}

/**
 * Labels of the drives shared with this account that it may WRITE to: an
 * Editor or Manager role on a drive that is not frozen. Both spellings of a
 * drive are in the set, its local label when synced here and its
 * `shared:<owner>~<hash>` browse label, so a row from either view is answered
 * without the caller knowing which it is. The server re-checks every write.
 */
export function useWritableMemberDriveLabels(): ReadonlySet<string> {
  const memberships = useSharedDriveMemberships();
  const { grants } = useMyFolderGrants();
  return useMemo(
    () => writableMemberDriveLabels(memberships, grants),
    [memberships, grants],
  );
}

/**
 * Labels of what this account MANAGES in somebody else's drives (Manager,
 * not frozen), whole drives and granted folders alike.
 */
export function useManageableMemberDriveLabels(): ReadonlySet<string> {
  const memberships = useSharedDriveMemberships();
  const { grants } = useMyFolderGrants();
  return useMemo(
    () => manageableMemberDriveLabels(memberships, grants),
    [memberships, grants],
  );
}

export const MY_FOLDER_GRANTS_QUERY_KEY = "my-folder-grants";
const EMPTY_GRANTS: readonly MyFolderGrantInfo[] = [];

/**
 * The folders shared WITH this account (folder grants), once folder roles are
 * on. Off, or on a server without them, this is empty and nothing is fetched,
 * so the whole-drive surfaces behave exactly as before.
 */
export function useMyFolderGrants(): {
  grants: readonly MyFolderGrantInfo[];
  isSettled: boolean;
} {
  const enabled = useAtomValue(folderRolesEnabledAtom);
  const { data, isFetched } = useQuery({
    queryKey: [MY_FOLDER_GRANTS_QUERY_KEY],
    queryFn: async () => {
      try {
        return await listMyFolderGrants();
      } catch (err) {
        if (!isSharedDrivesUnavailable(err)) {
          console.warn("[useMyFolderGrants] listing failed:", err);
        }
        return [] as MyFolderGrantInfo[];
      }
    },
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return { grants: data ?? EMPTY_GRANTS, isSettled: !enabled || isFetched };
}

/** The folder grant a `grant:` browse label names, if this account holds it. */
export function useFolderGrantForLabel(label: string | null | undefined): {
  grant: MyFolderGrantInfo | undefined;
  isGrant: boolean;
  isSettled: boolean;
} {
  const { grants, isSettled } = useMyFolderGrants();
  const parsed = useMemo(() => parseFolderGrantLabel(label), [label]);
  const grant = useMemo(
    () =>
      parsed
        ? grants.find(
            (g) =>
              g.ownerSs58 === parsed.ownerSs58 &&
              g.folderHash === parsed.folderHash &&
              g.pathPrefix.replace(/^\/+|\/+$/g, "") === parsed.pathPrefix,
          )
        : undefined,
    [grants, parsed],
  );
  return { grant, isGrant: parsed !== null, isSettled };
}
