/**
 * What a folder row (or an open folder's header) says when that folder is
 * shared on its own.
 *
 * The mark goes on the thing that is actually shared. A drive where only a
 * folder was shared is not a shared drive, so the drive carries no mark and
 * the folder does. The counts come from `list_owned_folder_sharing`, which
 * counts people holding a grant on exactly this folder: a nested grant marks
 * its own folder and never the one around it, and whole-drive members are
 * the drive's mark, not this one. Nobody is counted twice.
 */
export interface FolderRowSharing {
  isShared: boolean;
  /** The mark's text: "Shared with 2", or "Shared" when only invites. */
  label: string | null;
  /** Tooltip. */
  title: string | null;
}

const NOT_SHARED: FolderRowSharing = {
  isShared: false,
  label: null,
  title: null,
};

/** Said on every folder mark: the rest of the drive is not shared with them. */
export const FOLDER_SHARED_ON_ITS_OWN = "The rest of the drive isn't.";

export function folderRowSharing(
  summary: { holderCount: number; hasInvite: boolean } | undefined,
): FolderRowSharing {
  if (!summary) return NOT_SHARED;
  const holders = summary.holderCount;
  if (holders > 0) {
    const people = holders === 1 ? "1 person" : `${holders} people`;
    return {
      isShared: true,
      label: `Shared with ${holders}`,
      title: `Shared on its own with ${people}. ${FOLDER_SHARED_ON_ITS_OWN}`,
    };
  }
  // Invited but nobody holds it yet, or every folder link has lapsed. Still
  // marked, the same rule the drive mark keys on: the owner did share it, and
  // the links are what they may want to review.
  if (summary.hasInvite) {
    return {
      isShared: true,
      label: "Shared",
      title: `Shared on its own. ${FOLDER_SHARED_ON_ITS_OWN}`,
    };
  }
  return NOT_SHARED;
}

/**
 * A folder path as the folder sharing map keys it: no surrounding `/`, NFC.
 * Rust keys it the same way (the server stores a grant NFC), so a folder
 * whose name reached the webview decomposed still finds its mark.
 */
export function folderSharingKey(path: string | null | undefined): string {
  return (path ?? "").replace(/^\/+|\/+$/g, "").normalize("NFC");
}
