/**
 * The two upload affordances — and the one rule that decides whether they
 * are offered.
 *
 * Both actions upload something that already exists on disk. Neither
 * creates anything, which is why the labels say Upload: "+ New Folder"
 * read as "make me a folder", a feature the desktop app does not have,
 * and "+ Add Files" was a third wording for the same idea.
 *
 * Labels live here rather than at each call site because there are five
 * surfaces (page header, header's disabled fallback, right-click menu,
 * the button component's own title, and the upload dialogs) and they had
 * drifted into four different strings.
 */

export const UPLOAD_FILE_LABEL = "Upload File";
export const UPLOAD_FOLDER_LABEL = "Upload Folder";

/**
 * Registering a local folder for ongoing sync is NOT an upload — it sets
 * up a two-way relationship rather than sending a copy once. It keeps its
 * own wording so it cannot be mistaken for the buttons above.
 */
export const SYNC_FOLDER_LABEL = "Sync a Folder";

/**
 * What each action does, in one line, for the affordance's tooltip.
 *
 * The distinction the wording alone did not carry: Upload Folder copies a
 * folder's contents in ONCE and stops caring about it, while Sync a Folder
 * sets up a folder that is kept up to date from then on. Two buttons that
 * both start with a folder picker and read almost alike are easy to pick
 * wrong, and picking wrong is only discovered later, when the copy silently
 * fails to track changes.
 */
export const UPLOAD_FOLDER_HINT =
  "Copies a folder's contents into a drive once. Later changes on this computer are not picked up.";
export const SYNC_FOLDER_HINT =
  "Sets up a folder on this computer as a drive, kept up to date from now on.";

/** Whether an upload affordance is offered, and in what state. */
export type UploadActionState = "hidden" | "disabled" | "enabled";

export interface UploadActionGates {
  /** A server-only view: there is no local folder to drop into, so an
   *  upload here would land somewhere else and read as data loss. */
  hideUploads: boolean;
  /** The Recent Files view rather than a drive. */
  isRecentFiles: boolean;
  /** The account has no sync folder configured at all. */
  hasNoSyncPaths: boolean;
  /** The active drive has no sync path resolved yet. */
  isSyncPathEmpty: boolean;
}

/**
 * One rule for both buttons.
 *
 * They used to resolve separately, and disagreed: the file button was
 * hidden whenever `hideUploads` was set, while the folder button's
 * disabled fallback ignored `hideUploads` entirely — so a remote view
 * with no sync paths showed a dead "folder" button beside no file button
 * at all. Deriving it once is also what keeps the shared-drive viewer and
 * frozen-drive cases from having to be re-implemented per surface: they
 * belong in `hideUploads`, and every surface then follows.
 */
export function resolveUploadAction(gates: UploadActionGates): UploadActionState {
  if (gates.hideUploads) return "hidden";
  if (gates.isRecentFiles && gates.hasNoSyncPaths) return "disabled";
  if (gates.isSyncPathEmpty) return "hidden";
  return "enabled";
}
