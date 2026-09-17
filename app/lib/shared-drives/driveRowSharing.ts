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
  /** True when the row should carry a sharing badge at all. */
  isShared: boolean;
  /**
   * Which direction the sharing runs.
   *
   * `"with-me"` — someone else's drive that this account was invited into.
   * `"by-me"`   — this account's own drive that other people are in.
   *
   * The two are opposite facts and must not read the same. On a drive shared
   * WITH you the useful thing is what you may do in it; on one you shared, it
   * is that other people can see it and how many.
   */
  direction: "with-me" | "by-me" | null;
  /** The badge text. */
  label: string | null;
  /** Tooltip. */
  title: string | null;
}

const NOT_SHARED: DriveRowSharing = {
  isShared: false,
  direction: null,
  label: null,
  title: null,
};

export function driveRowSharing(params: {
  ownerSs58?: string | null;
  /** Wire role from the membership listing, joined by local label. */
  role?: string | null;
  /**
   * How many people this account has shared THIS drive with. Only meaningful
   * on an own drive; `undefined` means "not known yet", which shows no badge
   * rather than claiming the drive is private.
   */
  memberCount?: number;
}): DriveRowSharing {
  // A drive belonging to someone else carries their ss58 on the row; both
  // identity columns are NULL on an own drive by construction.
  if (params.ownerSs58) {
    const roleLabel = params.role
      ? driveRoleLabel(parseDriveRole(params.role))
      : null;
    return {
      isShared: true,
      direction: "with-me",
      label: roleLabel ? `Shared · ${roleLabel}` : "Shared",
      title: `Shared with you by ${params.ownerSs58}`,
    };
  }

  // An own drive with members is one the user has shared. Before this, an
  // owner had no way to tell a drive they had shared from a private one --
  // the badge only ever appeared on the receiving side.
  if (params.memberCount && params.memberCount > 0) {
    const people = params.memberCount === 1 ? "1 person" : `${params.memberCount} people`;
    return {
      isShared: true,
      direction: "by-me",
      label: `Shared with ${params.memberCount}`,
      title: `You shared this drive with ${people}`,
    };
  }

  return NOT_SHARED;
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
