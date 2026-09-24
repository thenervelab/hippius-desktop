import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { driveRelativePathFor } from "@/app/lib/utils/driveRelativePath";
import type { ShareModalTarget } from "@/app/lib/global-atoms/sharesAtoms";
import { isSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";

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
 * Whether a member drive may mint one is a separate question, and a
 * visibility one rather than an enabled one — see {@link offersShareAction}.
 */
export function canShareFolder(
  file: FormattedUserFile,
  folderSharesEnabled: boolean,
): boolean {
  if (!file.isFolder) return false;
  return folderSharesEnabled;
}

/**
 * Whether a row's "Share via link" action is offered at all.
 *
 * A FILE always can be, from anybody's drive: sharing one uploads a
 * re-encrypted copy to the sharer's own share storage.
 *
 * A FOLDER in somebody else's drive is a reference, not a copy: the mint
 * names the drive's owner (`owner_ss58`, hcfs #458), which the server accepts
 * from an Editor or a Manager of a drive that is not frozen, and only once it
 * advertises `member_folder_shares`. Anywhere else the item is ABSENT rather
 * than disabled: a Viewer's answer will not change by waiting, and a dead
 * control invites a hunt for a permission that was never going to be granted.
 * (The missing `folder_shares` capability stays disabled-with-a-tooltip,
 * because that one is a "not yet".) Rust keeps every refusal as the
 * enforcement; this is the affordance. Console `offersShareByLink` parity.
 */
export function offersShareAction(
  file: FormattedUserFile,
  memberDriveLabels?: ReadonlySet<string>,
  context: {
    /** `capabilities.member_folder_shares`. */
    memberFolderShares?: boolean;
    /** Labels of shared drives this account may write to (not frozen). */
    writableMemberDriveLabels?: ReadonlySet<string>;
  } = {},
): boolean {
  if (!file.isFolder) return true;
  if (!isMemberDriveLabel(file.label, memberDriveLabels)) return true;
  return (
    context.memberFolderShares === true &&
    Boolean(file.label && context.writableMemberDriveLabels?.has(file.label))
  );
}

/**
 * Whether a drive label names a drive shared WITH this account rather than one
 * it owns.
 *
 * Two shapes, because a shared drive reaches the UI two ways. One synced here
 * has an ordinary label and is known only from the membership listing, so the
 * caller passes the labels that listing returned. One merely BROWSED has no
 * local row at all and carries the synthetic `shared:<owner>~<hash>` label,
 * which says so on its own — no listing, no waiting, and no window in which a
 * drive that cannot mint still offers to.
 */
export function isMemberDriveLabel(
  label: string | null | undefined,
  memberDriveLabels?: ReadonlySet<string>,
): boolean {
  if (!label) return false;
  if (isSharedDriveLabel(label)) return true;
  return memberDriveLabels?.has(label) ?? false;
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
  // Delegates to the shared resolver: a folder's path is the same
  // question whether it is being shared or renamed, and the two answering
  // it differently is how one of them ends up acting on the wrong folder.
  return driveRelativePathFor({ ...file, isFolder: true }, basePath);
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
/**
 * Whether a FILE row can be shared.
 *
 * The viewer used to require a local `source`, on the reasoning that a
 * share is minted from the file's synced copy on disk. That stopped being
 * true when `createRemoteShare` landed: for a cloud-only row Rust
 * downloads the file, re-encrypts it under a fresh share key and mints
 * from that, so nothing local is needed. The gate outlived its reason and
 * hid the share button on every file in a drive this device does not
 * sync.
 *
 * What a cloud-only share DOES need is the server id of the file and the
 * drive it lives in — without either there is nothing to fetch — so those
 * are what is checked instead of a disk path.
 */
export function canShareFile(file: FormattedUserFile): boolean {
  if (file.isFolder) return false;
  // A row still uploading has no settled server identity to share.
  if (file.syncStatus !== undefined && file.syncStatus !== "synced") return false;
  // Synced here: share from the local copy.
  if (file.source) return true;
  // Not here: Rust fetches it by id from the drive that holds it.
  return Boolean(file.fileId && file.label);
}

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
