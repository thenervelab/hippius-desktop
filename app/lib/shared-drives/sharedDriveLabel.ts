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

/**
 * Marks a label as a shared drive's synthetic browse label.
 *
 * Contains NO SLASH, deliberately. The first cut was `shared://owner/hash`,
 * which broke the moment anyone opened a folder inside such a drive: the
 * label is carried in a URL parameter and joined into folder paths by
 * machinery that splits on `/`, so it came back mangled, the view stopped
 * reading as remote, and uploads silently fell through to the LOCAL flow --
 * files landing in a sync folder instead of the shared drive, with nothing
 * erroring.
 */
const SHARED_DRIVE_LABEL_PREFIX = "shared:";

/**
 * Separator between the owner and the folder hash.
 *
 * `~` because an ss58 is base58 (alphanumeric only) and a folder hash is
 * hex, so neither half can contain one — and unlike `/` it survives every
 * path and URL join the label passes through.
 */
const SHARED_DRIVE_LABEL_SEPARATOR = "~";

export interface SharedDriveIdentity {
  ownerSs58: string;
  folderHash: string;
}

export function makeSharedDriveLabel(identity: SharedDriveIdentity): string {
  return `${SHARED_DRIVE_LABEL_PREFIX}${identity.ownerSs58}${SHARED_DRIVE_LABEL_SEPARATOR}${identity.folderHash}`;
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
  const at = rest.indexOf(SHARED_DRIVE_LABEL_SEPARATOR);
  if (at <= 0) return null;

  const ownerSs58 = rest.slice(0, at);
  const folderHash = rest.slice(at + 1);
  if (!ownerSs58 || !folderHash) return null;
  return { ownerSs58, folderHash };
}

/** Whether a label names a drive somebody shared with this account. */
export function isSharedDriveLabel(label: string | null | undefined): boolean {
  return parseSharedDriveLabel(label) !== null;
}

/**
 * The identity args a drive-scoped IPC takes, derived from the browse label.
 *
 * `null` for an ordinary drive, which the backend reads as "resolve the
 * label". One helper so a new call site cannot pass half an identity, which
 * both sides refuse rather than fall back on.
 */
export function sharedDriveTargetArgs(label: string | null | undefined): {
  ownerSs58: string | null;
  folderHash: string | null;
} {
  const identity = parseSharedDriveLabel(label);
  return {
    ownerSs58: identity?.ownerSs58 ?? null,
    folderHash: identity?.folderHash ?? null,
  };
}
