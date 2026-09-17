import { driveRoleLabel, parseDriveRole, type DriveRole } from "./roles";

/**
 * What a drive row should say about sharing.
 *
 * A member drive is a first-class drive that happens to live in someone else's
 * namespace, and the list rendered it identically to an owned one — same icon,
 * same name, nothing to say whose it was or what the user could do in it. The
 * row's `ownerSs58` already carried the fact; nothing read it.
 *
 * Roles arrive separately: drive rows come from `sync_paths` and roles from the
 * membership listing, joined on the local label. A row whose role has not
 * arrived — still loading, or a listing that failed — shows the shared badge
 * without a role rather than guessing one. Claiming "Viewer" on a drive the
 * user can actually write to is worse than saying nothing yet.
 */
export interface DriveRowSharing {
  /** True when this drive belongs to another account. */
  isShared: boolean;
  /** The role label to show, or `null` when unknown or not applicable. */
  roleLabel: string | null;
  /** Tooltip for the badge — the owner's address when we have it. */
  title: string | null;
}

export function driveRowSharing(params: {
  ownerSs58?: string | null;
  /** Wire role from the membership listing, joined by local label. */
  role?: string | null;
}): DriveRowSharing {
  // An own drive has no owner column: both identity columns are NULL by
  // construction, which is what makes it own.
  if (!params.ownerSs58) {
    return { isShared: false, roleLabel: null, title: null };
  }
  return {
    isShared: true,
    roleLabel: params.role ? driveRoleLabel(parseDriveRole(params.role)) : null,
    title: `Shared by ${params.ownerSs58}`,
  };
}

/**
 * Index a membership listing by the local label it syncs as, so a drive row can
 * find its own role.
 *
 * Only rows synced locally can match — a membership not yet added has no local
 * label, and is surfaced by "Shared with me" rather than by the drive list.
 */
export function rolesByLocalLabel(
  memberships: ReadonlyArray<{
    localLabel?: string | null;
    syncedLocally?: boolean;
    role: string;
  }>,
): Map<string, DriveRole> {
  const byLabel = new Map<string, DriveRole>();
  for (const m of memberships) {
    if (m.syncedLocally && m.localLabel) {
      byLabel.set(m.localLabel, parseDriveRole(m.role));
    }
  }
  return byLabel;
}
