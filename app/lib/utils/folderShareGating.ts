import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ShareModalTarget } from "@/app/lib/global-atoms/sharesAtoms";

/**
 * Single gate for whether a folder row's "Share via link" action is enabled.
 * Shared by the files-table menu, card view, and the right-click context menu
 * so the three surfaces can't drift. Mirrors `canRenameFile`.
 *
 * A folder share is a live browsable link minted from the SERVER's state (one
 * metadata POST — nothing is packed from disk), so local settlement no longer
 * matters: a cloud-only or still-syncing folder is just as mintable. The only
 * FE gate left is the server capability — `/v1/folder-shares` exists only on
 * new servers, so the item disables (with {@link FOLDER_SHARE_DISABLED_TOOLTIP})
 * until `capabilities.folder_shares` is confirmed.
 *
 * Member drives stay owner-mint-only (server v1); the drive listing rows never
 * reach these file surfaces with an owner marker, so that refusal lives in
 * Rust (`hcfs_create_folder_share` rejects with a message the modal shows).
 */
export function canShareFolder(
  file: FormattedUserFile,
  folderSharesEnabled: boolean,
): boolean {
  if (!file.isFolder) return false;
  return folderSharesEnabled;
}

export const FOLDER_SHARE_DISABLED_TOOLTIP =
  "The connected server doesn't support folder links yet. Update the server to share folders as a link.";

/**
 * Resolve a folder row's drive-relative path for the share IPC.
 *
 * A folder row's `actualFileName` is NOT always the full path: the
 * inline-expanded tree stores only the basename and carries the containing
 * path in `parentRelativePath`, while the subfolder view supplies it as
 * `basePath`. Handing the bare name to the backend would resolve a nested
 * `Trips/Photos` to a root-level `Photos` and share the wrong folder.
 *
 * Mirrors `resolveRelativePath` in the files table, which computes the same
 * value for folder keys.
 */
export function folderShareRelativePath(
  file: Pick<FormattedUserFile, "name" | "actualFileName" | "parentRelativePath">,
  basePath: string | null | undefined,
): string {
  const trim = (value: string) => value.replace(/^\/+|\/+$/g, "");

  const name = trim(file.actualFileName || file.name);
  const base = trim(file.parentRelativePath ?? basePath ?? "");

  if (!base) return name;

  // Only treat the name as already-qualified when it genuinely carries a path.
  // A folder row's name is a bare basename, so an unconditional `name === base`
  // check would collapse `Trips/Trips` to `Trips` and share the PARENT — a
  // strict superset of what the user selected. Same-named nesting is ordinary
  // (`src/src`, an archive that re-nests its own directory).
  const isQualified = name.includes("/");
  if (isQualified && (name === base || name.startsWith(`${base}/`))) return name;
  if (isQualified) return name;

  return `${base}/${name}`;
}

/**
 * Build the `shareModalFileAtom` payload for a row the user chose to share.
 *
 * One helper rather than the same expression at each of the four surfaces that
 * open the modal (files table, card view, right-click menu, file viewer),
 * because the rule is not uniform: a FILE's `actualFileName` is already the
 * full drive-relative path, while a FOLDER's may be just the basename and has
 * to be resolved against the surface's `basePath`.
 */
export function shareTargetFor(
  file: FormattedUserFile,
  basePath: string | null | undefined,
): ShareModalTarget {
  return {
    file,
    relativePath: file.isFolder
      ? folderShareRelativePath(file, basePath)
      : file.actualFileName || file.name,
  };
}

// Label → server folder hash, memoized: the value is a pure function of the
// label and every folder row in a listing asks for the same drive's hash.
const folderHashCache = new Map<string, string>();

/**
 * The server-side folder hash of an OWN drive: the first 16 hex chars of
 * SHA-256 over the label — pinned byte-for-byte to
 * `hcfs_client::drive::keys::folder_hash`, which the Rust mint path uses.
 *
 * This is the drive half of a folder share's `(folderHash, pathPrefix)`
 * identity: the mint sends the hash the drive-scoped client computed from the
 * same label, so a badge that derives it here finds exactly the rows that
 * mint created. Member drives carry the OWNER's hash instead, but they can
 * never mint a folder share (owner-mint-only v1), so a member label hashing
 * to a different value simply never matches a listing row — which is correct.
 */
export async function driveFolderHash(label: string): Promise<string> {
  const cached = folderHashCache.get(label);
  if (cached !== undefined) return cached;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(label),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const hash = hex.slice(0, 16);

  folderHashCache.set(label, hash);
  return hash;
}
