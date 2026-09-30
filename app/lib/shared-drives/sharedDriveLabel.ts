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
  // A folder grant is a folder of somebody else's drive: the same wire
  // identity, so every drive-scoped call addresses the right namespace.
  const grant = parseFolderGrantLabel(label);
  if (grant) return { ownerSs58: grant.ownerSs58, folderHash: grant.folderHash };
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

/**
 * Marks a FOLDER GRANT browse label: one folder of somebody else's drive,
 * browsed rooted at that folder so nothing above it is reachable. Mirrors
 * `GRANT_BROWSE_PREFIX` in Rust's `sync/drive/identity.rs` (a Rust test reads
 * this constant). Folder roles follow HCFS #475 (not merged yet).
 */
const FOLDER_GRANT_LABEL_PREFIX = "grant:";

export interface FolderGrantIdentity extends SharedDriveIdentity {
  /** The granted folder, drive-relative, no surrounding slashes. */
  pathPrefix: string;
}

function toHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function fromHex(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The label a granted folder is browsed under. The folder path is hex so the
 * label keeps the no-slash rule every browse label lives by; Rust joins the
 * path in front of every drive-relative path the views send.
 */
export function makeFolderGrantLabel(identity: FolderGrantIdentity): string {
  const path = identity.pathPrefix.replace(/^\/+|\/+$/g, "");
  return `${FOLDER_GRANT_LABEL_PREFIX}${identity.ownerSs58}${SHARED_DRIVE_LABEL_SEPARATOR}${identity.folderHash}${SHARED_DRIVE_LABEL_SEPARATOR}${toHex(path)}`;
}

/** The drive and folder a grant label names, or `null` for anything else. */
export function parseFolderGrantLabel(
  label: string | null | undefined,
): FolderGrantIdentity | null {
  if (!label || !label.startsWith(FOLDER_GRANT_LABEL_PREFIX)) return null;
  const parts = label
    .slice(FOLDER_GRANT_LABEL_PREFIX.length)
    .split(SHARED_DRIVE_LABEL_SEPARATOR);
  if (parts.length !== 3) return null;
  const [ownerSs58, folderHash, pathHex] = parts;
  const pathPrefix = fromHex(pathHex);
  if (!ownerSs58 || !folderHash || !pathPrefix) return null;
  if (pathPrefix.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return null;
  }
  return { ownerSs58, folderHash, pathPrefix };
}

/** Whether a label names one granted folder rather than a whole drive. */
export function isFolderGrantLabel(label: string | null | undefined): boolean {
  return parseFolderGrantLabel(label) !== null;
}
