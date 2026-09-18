/**
 * The label a shared drive is browsed under.
 *
 * Browsing a drive somebody shared with you needs its WIRE identity — the
 * owner's address and folder hash — because there is no local row to resolve
 * a label against. Carrying that identity as separate state beside the active
 * label invites the one bug that matters here: a navigation that clears the
 * label but not the identity, after which the next drive browsed is asked for
 * under somebody else's namespace.
 *
 * So the identity IS the label. There is nothing to clear and nothing to keep
 * in step, and a label that does not parse is simply not a shared drive.
 *
 * It also settles a collision the display name cannot: two owners may both
 * call a drive "Documents", and so may you.
 */

/** Marks a label as a shared drive's synthetic browse label. */
const SHARED_DRIVE_LABEL_PREFIX = "shared://";

export interface SharedDriveIdentity {
  ownerSs58: string;
  folderHash: string;
}

export function makeSharedDriveLabel(identity: SharedDriveIdentity): string {
  return `${SHARED_DRIVE_LABEL_PREFIX}${identity.ownerSs58}/${identity.folderHash}`;
}

/**
 * The wire identity a browse label names, or `null` for an ordinary drive.
 *
 * Both halves must be present: half an identity would leave the backend to
 * fall back on this account's own namespace, browsing the wrong drive instead
 * of failing. The backend refuses that too — this is the near side of the
 * same rule.
 */
export function parseSharedDriveLabel(
  label: string | null | undefined,
): SharedDriveIdentity | null {
  if (!label || !label.startsWith(SHARED_DRIVE_LABEL_PREFIX)) return null;
  const rest = label.slice(SHARED_DRIVE_LABEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;

  const ownerSs58 = rest.slice(0, slash);
  const folderHash = rest.slice(slash + 1);
  if (!ownerSs58 || !folderHash) return null;
  return { ownerSs58, folderHash };
}

/** Whether a label names a drive somebody shared with this account. */
export function isSharedDriveLabel(label: string | null | undefined): boolean {
  return parseSharedDriveLabel(label) !== null;
}
