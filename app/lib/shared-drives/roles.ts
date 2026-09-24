/**
 * Shared-drive roles, as this client offers them.
 *
 * Two roles: Viewer (wire `reader`) and Editor (wire `writer`), the words
 * people already recognise from every other drive product. The mapping lives
 * here and nowhere else, so the two vocabularies cannot drift apart across
 * screens. Rust holds the same list (`WIRE_ROLES` in
 * `src-tauri/src/shared_drives/commands.rs`) and refuses anything else before
 * a request is made.
 *
 * The server also knows `manager`. This client never offers it: only a
 * drive's owner invites and removes people. Rust already reads a `manager` the
 * server returns as `writer`; `parseDriveRole` maps it to Editor too, so a
 * former Manager keeps upload and delete here even if one ever arrives.
 *
 * "Owner" is deliberately NOT a role. The server has no owner membership
 * row: a drive's owner is the account it belongs to, and ownership is decided
 * by identity rather than by a role column. Callers that need to show "Owner"
 * hold that fact themselves.
 */

export const DRIVE_ROLES = ["reader", "writer"] as const;

export type DriveRole = (typeof DRIVE_ROLES)[number];

/**
 * Read a role off the wire.
 *
 * `manager` is an Editor: the server may still return it for a member made
 * one before this client dropped the role, and reading it as a Viewer would
 * take away upload and delete they still have.
 *
 * Anything else unrecognised degrades to `reader`, the LEAST privileged role,
 * never the most. A future server that adds a role this build has never heard
 * of must not have it silently treated as more than it is. The server
 * re-checks every mutation regardless, so this only governs what the UI
 * offers.
 */
export function parseDriveRole(value: string | undefined | null): DriveRole {
  if (value === "manager") return "writer";
  return (DRIVE_ROLES as readonly string[]).includes(value ?? "")
    ? (value as DriveRole)
    : "reader";
}

const ROLE_LABELS: Record<DriveRole, string> = {
  reader: "Viewer",
  writer: "Editor",
};

export function driveRoleLabel(role: DriveRole): string {
  return ROLE_LABELS[role];
}

/** One line each, for the role picker. Says what the role can do, not what it is. */
const ROLE_DESCRIPTIONS: Record<DriveRole, string> = {
  reader: "Can open and download files.",
  writer: "Can open, download, upload and delete files.",
};

export function driveRoleDescription(role: DriveRole): string {
  return ROLE_DESCRIPTIONS[role];
}

/**
 * Whether this account may invite, remove, change roles, or see pending
 * invites and links. The owner only: no member role manages a drive, whatever
 * the server calls it. Rust decides the same for the Manage access panel
 * (`can_manage` in `shared_drives/access_panel.rs`) and refuses every access
 * change on a drive this account does not own.
 */
export function canManageDrive(params: { isOwner: boolean }): boolean {
  return params.isOwner;
}

/** Whether a role may upload or delete. Owners always can. */
export function canWriteToDrive(params: {
  isOwner: boolean;
  role?: DriveRole;
}): boolean {
  return params.isOwner || params.role === "writer";
}

/**
 * What a role change costs the member, when it costs them something.
 *
 * The server makes a demotion sticky: it revokes the invite that admitted
 * the member when that link outranks their new role. That is invisible from
 * the picker and is discovered later as a link that mysteriously stopped
 * working, so the role dialog says it before Save.
 *
 * `null` for an unchanged role and for a promotion, which takes nothing away.
 */
export function driveRoleDemotionWarning(
  current: DriveRole,
  next: DriveRole,
): string | null {
  if (current === next || next === "writer") return null;
  return "The invite link that admitted them is revoked too, if it granted more than their new role.";
}
