"use client";

import { useMemo } from "react";

import {
  driveRowSharing,
  type DriveRowSharing,
} from "@/app/lib/shared-drives/driveRowSharing";
import { isDriveShared, useOwnedDriveSharing } from "./useOwnedDriveSharing";
import { useSharedDriveMembership } from "./useSharedDriveRoles";

const NO_LABELS: readonly string[] = [];

export interface DriveSharing {
  /** How the drive should be described — the same projection a row uses. */
  sharing: DriveRowSharing;
  /** Shared in either direction: by this account, or with it. */
  isShared: boolean;
  /** Only an owner of an already-shared drive may manage access. */
  canManage: boolean;
}

const NOT_SHARED: DriveSharing = {
  sharing: { isShared: false, direction: null, label: null, title: null },
  isShared: false,
  canManage: false,
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
    return {
      sharing,
      isShared: sharing.isShared,
      canManage: sharing.direction === "by-me" && isDriveShared(own),
    };
  }, [label, membership, own]);
}
