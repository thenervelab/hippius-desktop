"use client";

import { useMemo } from "react";

import {
  driveRowSharing,
  type DriveRowSharing,
} from "@/app/lib/shared-drives/driveRowSharing";
import {
  canManageDrive,
  canWriteToDrive,
  parseDriveRole,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";
import { isDriveShared, useOwnedDriveSharing } from "./useOwnedDriveSharing";
import { useSharedDriveMembership } from "./useSharedDriveRoles";

const NO_LABELS: readonly string[] = [];

export interface DriveSharing {
  /** How the drive should be described — the same projection a row uses. */
  sharing: DriveRowSharing;
  /** Shared in either direction: by this account, or with it. */
  isShared: boolean;
  /**
   * The role this account holds on the drive, when it is one shared WITH
   * them and the membership listing has answered. `null` for an own drive
   * (ownership is identity, not a role) and while the listing is in flight,
   * where claiming a role would be guessing.
   */
  role: DriveRole | null;
  /**
   * Whether the viewer may manage who has access — invite, remove, re-role.
   *
   * An owner may, once the drive is actually shared. A MANAGER may too, on a
   * drive they do not own: the server admits a delegated manager by name
   * (`?owner=`), and refusing them here is what made the desktop mint Manager
   * invites it could not then honour.
   */
  canManage: boolean;
  /**
   * Whether the viewer may upload, delete or create folders here.
   *
   * False only for a Viewer on somebody else's drive. The server refuses
   * their writes anyway, so this governs what the UI OFFERS -- and offering
   * an upload that can only fail is worse than not offering it: the refusal
   * arrives later, as a sync error, nowhere near the button that caused it.
   *
   * Permitted while the membership listing is still in flight. Own drives
   * vastly outnumber member ones, and a write control that appears a moment
   * late on every drive is a worse trade than one that briefly appears for a
   * Viewer.
   */
  canWrite: boolean;
}

const NOT_SHARED: DriveSharing = {
  sharing: { isShared: false, direction: null, label: null, title: null },
  isShared: false,
  role: null,
  canManage: false,
  canWrite: true,
};

/**
 * Everything one drive's surfaces need to know about its sharing.
 *
 * The header mark and File Details both ask, and a second copy of "is this
 * drive shared, and which way" is how one surface comes to claim a drive is
 * private while another badges it. Both read this.
 *
 * The owner-only listing is skipped for a member drive, and until the
 * membership listing has settled — before it answers, every drive looks own,
 * and asking that endpoint about somebody else's drive is a refusal waiting
 * to happen.
 */
export function useDriveSharing(label: string | null | undefined): DriveSharing {
  const { membership, isSettled } = useSharedDriveMembership(label);
  const ownSharing = useOwnedDriveSharing(
    !label || !isSettled || membership ? NO_LABELS : [label],
  );
  const own = label ? ownSharing.get(label) : undefined;

  return useMemo(() => {
    if (!label) return NOT_SHARED;
    const sharing = driveRowSharing({
      ownerSs58: membership?.ownerSs58,
      role: membership?.role,
      ...own,
    });
    const role = membership ? parseDriveRole(membership.role) : null;
    return {
      sharing,
      isShared: sharing.isShared,
      role,
      canManage: canManageDrive({
        isOwner: !membership,
        role: role ?? undefined,
      })
        // An owner with nothing shared has nothing to manage; a manager
        // always does, since being one means the drive is already shared.
        && (Boolean(membership) || isDriveShared(own)),
      canWrite: canWriteToDrive({
        // No membership row means this account owns the drive -- or the
        // listing has not answered yet, which reads the same way on purpose.
        isOwner: !membership,
        role: role ?? undefined,
      }),
    };
  }, [label, membership, own]);
}
