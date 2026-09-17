/**
 * Shared-drive roles, as the server defines them.
 *
 * The wire vocabulary is `reader` / `writer` / `manager`. The UI says
 * Viewer / Editor / Manager, which is what people already recognise from
 * every other drive product. The mapping lives here and nowhere else, so the
 * two vocabularies cannot drift apart across screens.
 *
 * "Owner" is deliberately NOT a role. The server has no owner membership
 * row: a drive's owner is the account it belongs to, and ownership is decided
 * by identity rather than by a role column. Callers that need to show "Owner"
 * hold that fact themselves.
 *
 * Deliberately a verbatim port of the console's `src/lib/shared-drives/roles.ts`
 * — same wire words, same labels, same degrade rule. Two clients showing a
 * member different powers for the same role is the failure this prevents, so
 * any change here has to land on both sides together.
 */

export const DRIVE_ROLES = ["reader", "writer", "manager"] as const;

export type DriveRole = (typeof DRIVE_ROLES)[number];

/**
 * Read a role off the wire.
 *
 * An unrecognised value degrades to `reader`, the LEAST privileged role,
 * never the most. A future server that adds a role this build has never heard
 * of must not have it silently treated as management: showing a viewer a
 * Remove Member button they cannot use is a smaller failure than hiding a
 * control, and far smaller than implying they hold powers they do not. The
 * server re-checks every mutation regardless, so this only governs what the
 * UI offers.
 */
export function parseDriveRole(value: string | undefined | null): DriveRole {
  return (DRIVE_ROLES as readonly string[]).includes(value ?? "")
    ? (value as DriveRole)
    : "reader";
}

const ROLE_LABELS: Record<DriveRole, string> = {
  reader: "Viewer",
  writer: "Editor",
  manager: "Manager",
};

export function driveRoleLabel(role: DriveRole): string {
  return ROLE_LABELS[role];
}

/** One line each, for the role picker. Says what the role can do, not what it is. */
const ROLE_DESCRIPTIONS: Record<DriveRole, string> = {
  reader: "Can open and download files.",
  writer: "Can open, download, upload and delete files.",
  manager: "Everything an editor can do, plus inviting and removing people.",
};

export function driveRoleDescription(role: DriveRole): string {
  return ROLE_DESCRIPTIONS[role];
}

/**
 * Whether a role may invite, remove, change roles, or see pending invites.
 *
 * Owners always can, and hold no membership row, so they are passed as a
 * separate fact rather than squeezed into the role.
 */
export function canManageDrive(params: {
  isOwner: boolean;
  role?: DriveRole;
}): boolean {
  return params.isOwner || params.role === "manager";
}

/** Whether a role may upload or delete. Owners always can. */
export function canWriteToDrive(params: {
  isOwner: boolean;
  role?: DriveRole;
}): boolean {
  return (
    params.isOwner || params.role === "writer" || params.role === "manager"
  );
}

/**
 * Manager invites are hard-capped by the server at one use and 24 hours.
 * The caps ARE the defaults, and exceeding either is a 400, so the mint form
 * has to stop offering the wider choices rather than let the server reject a
 * link the user thought they had configured.
 */
export const MANAGER_INVITE_MAX_USES = 1;
export const MANAGER_INVITE_MAX_SECONDS = 24 * 60 * 60;
