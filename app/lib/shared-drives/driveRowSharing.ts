import {
  canWriteToDrive,
  driveRoleLabel,
  parseDriveRole,
  type DriveRole,
} from "./roles";
import { makeFolderGrantLabel, makeSharedDriveLabel } from "./sharedDriveLabel";

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
  /**
   * Invite links that can still admit someone. A drive whose invite has been
   * sent but not yet accepted has no members and is very much shared, so the
   * badge cannot key on members alone.
   */
  liveInviteCount?: number;
  /** Every invite the server still lists, lapsed and revoked included. */
  totalInviteCount?: number;
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
  const members = params.memberCount ?? 0;
  const liveInvites = params.liveInviteCount ?? 0;

  if (members > 0) {
    const people = members === 1 ? "1 person" : `${members} people`;
    return {
      isShared: true,
      direction: "by-me",
      label: `Shared with ${members}`,
      title: `You shared this drive with ${people}`,
    };
  }

  // Invited but nobody has accepted yet. Saying "Shared with 0" would read as
  // a mistake; what is true is that a link is out there.
  if (liveInvites > 0) {
    return {
      isShared: true,
      direction: "by-me",
      label: "Invite sent",
      title:
        liveInvites === 1
          ? "An invite link to this drive is live"
          : `${liveInvites} invite links to this drive are live`,
    };
  }

  // Shared once, but every link has lapsed and nobody joined. Still marked:
  // the owner did share it, and the spent links are the thing they may want
  // to review or replace. Saying so is more use than saying nothing.
  if ((params.totalInviteCount ?? 0) > 0) {
    return {
      isShared: true,
      direction: "by-me",
      label: "Link expired",
      title:
        "You shared this drive, but no invite link is still live and nobody has joined",
    };
  }

  return NOT_SHARED;
}

/**
 * The count mark a MANAGER sees on a drive they manage for somebody else:
 * the owner's "Shared with N", counted from the membership listing
 * (`member_count`, owner excluded). `null` when the count is unknown or
 * zero, so the mark never claims nobody is there from absence.
 */
export function managedDriveCountMark(
  memberCount: number | null | undefined,
): { label: string; title: string } | null {
  if (!memberCount || memberCount < 1) return null;
  const people = memberCount === 1 ? "1 person" : `${memberCount} people`;
  return {
    label: `Shared with ${memberCount}`,
    title: `${people} besides the owner can open this drive`,
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

/**
 * The labels (local and browse) of every shared drive this account may write
 * to: Editor or Manager, and not frozen. See `useWritableMemberDriveLabels`.
 */
export function writableMemberDriveLabels(
  memberships: readonly {
    ownerSs58: string;
    folderHash: string;
    role: string;
    localLabel: string | null;
    frozen?: boolean;
  }[],
  /** Folder grants held, when folder roles are on; their `grant:` labels. */
  folderGrants: readonly FolderGrantRow[] = [],
): ReadonlySet<string> {
  return memberLabelsWhere(memberships, folderGrants, (role) =>
    canWriteToDrive({ isOwner: false, role }),
  );
}

/** The fields of a held folder grant these label sets read. */
export interface FolderGrantRow {
  ownerSs58: string;
  folderHash: string;
  pathPrefix: string;
  role: string;
  frozen?: boolean;
}

/**
 * Labels (local and `shared:`) of the drives this account MANAGES in
 * somebody else's name: a Manager role, not frozen. Drives the folder "Share
 * folder" item there. Never a `grant:` label: Manager is not a folder role
 * (HCFS #475), so a folder holder never manages the folder.
 */
export function manageableMemberDriveLabels(
  memberships: Parameters<typeof writableMemberDriveLabels>[0],
): ReadonlySet<string> {
  return memberLabelsWhere(memberships, [], (role) => role === "manager");
}

function memberLabelsWhere(
  memberships: Parameters<typeof writableMemberDriveLabels>[0],
  folderGrants: readonly FolderGrantRow[],
  allowed: (role: DriveRole) => boolean,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of memberships) {
    if (m.frozen || !allowed(parseDriveRole(m.role))) continue;
    out.add(makeSharedDriveLabel({ ownerSs58: m.ownerSs58, folderHash: m.folderHash }));
    if (m.localLabel) out.add(m.localLabel);
  }
  for (const g of folderGrants) {
    if (g.frozen || !allowed(parseDriveRole(g.role))) continue;
    out.add(makeFolderGrantLabel(g));
  }
  return out;
}
