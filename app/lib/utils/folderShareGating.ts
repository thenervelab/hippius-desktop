import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ShareModalTarget } from "@/app/lib/global-atoms/sharesAtoms";

/**
 * Single gate for whether a folder row's "Share via link" action is enabled.
 * Shared by the files-table menu, card view, and the right-click context menu
 * so the three surfaces can't drift. Mirrors `canRenameFile`.
 *
 * A folder share zips the folder from disk, so it needs the entry to actually
 * be on this device and at rest:
 *
 * - `!isAssigned`: still mid-upload, no settled server identity.
 * - `fileId && !source`: a cloud-only row (search / recent-uploads hit with no
 *   local path) — nothing on disk to pack.
 * - explicit non-"synced" status: pending download or upload. `undefined`
 *   status (plain local listings that never set one) stays shareable.
 *
 * Rust re-checks all of this and additionally verifies every child is present;
 * this gate is for the menu's disabled state, not for security.
 */
export function canShareFolder(file: FormattedUserFile): boolean {
  if (!file.isFolder) return false;
  if (!file.isAssigned) return false;
  if (file.fileId && !file.source) return false;
  if (file.syncStatus !== undefined && file.syncStatus !== "synced") return false;
  return true;
}

export const FOLDER_SHARE_DISABLED_TOOLTIP =
  "Only folders fully synced on this device can be shared as a link. Wait for sync to finish and try again.";

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
  file: FormattedUserFile,
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
