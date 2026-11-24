// What a row's star names, and how the star shown on it is decided.
//
// Rust resolves the drive (owner + folder hash) and does the server call
// (`set_star`, `src-tauri/src/sync/fileops/favorites`); this file only turns
// the row on screen into the target Rust takes, and the key the session
// state is kept under. Pure, so the rules are tested without React.

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { driveRelativePathFor } from "@/app/lib/utils/driveRelativePath";
import { remoteDriveLabel } from "@/app/lib/utils/renameGating";
import { starKey, type StarKind, type StarScope, type StarTarget } from "@/app/lib/tauri/starred";

/** A file id is the lowercase hex of its 32-byte path hash. */
const FILE_ID = /^[0-9a-f]{64}$/;

/**
 * Rows whose bytes are not (all) on the server yet, or never will be from
 * here: nothing there to star.
 */
const NOT_ON_SERVER: ReadonlySet<string> = new Set(["uploading", "excluded", "hidden"]);

/** The label a row's star resolves its drive from: the browsed drive, else its own. */
export function starLabelOf(row: FormattedUserFile): string | null {
  const label = remoteDriveLabel(row) ?? row.label ?? null;
  return label && label.length > 0 ? label : null;
}

/** A file row's id on the server, or `null` when it has none yet. */
export function starFileIdOf(row: Pick<FormattedUserFile, "fileId" | "arionHash">): string | null {
  const id = (row.fileId || row.arionHash || "").toLowerCase();
  return FILE_ID.test(id) ? id : null;
}

/**
 * What starring this row names, or `null` when it cannot be starred: a row
 * still uploading or only on this computer, one with no drive, or a file the
 * server holds no id for yet. `basePath` is the folder the surface shows (a
 * folder row may carry only its own name).
 */
export function starTargetFor(row: FormattedUserFile, basePath?: string | null): StarTarget | null {
  if (row.tempData) return null;
  if (row.syncStatus && NOT_ON_SERVER.has(row.syncStatus)) return null;
  const label = starLabelOf(row);
  if (!label) return null;
  // A whole drive's row (Starred) stars the drive, not a folder at its root.
  if (row.isDriveRoot) return driveStarTarget(label, row.name);
  if (row.isFolder) {
    const path = driveRelativePathFor(row, basePath).replace(/^\/+|\/+$/g, "");
    if (!path) return null;
    return { kind: "folder", name: row.name, label, path };
  }
  if (!row.isAssigned) return null;
  const fileId = starFileIdOf(row);
  if (!fileId) return null;
  return { kind: "file", name: row.name, label, fileId };
}

/** Whether a row offers Star / Unstar at all. */
export function canStar(row: FormattedUserFile, basePath?: string | null): boolean {
  return starTargetFor(row, basePath) !== null;
}

/** A whole drive, by the label it is listed under (own label, `shared:` or `grant:`). */
export function driveStarTarget(label: string, name: string): StarTarget {
  return { kind: "drive", name, label };
}

/**
 * The key a target's star is kept under, given its drive's scope. `null`
 * while the scope is not known (the star then reads from the row alone).
 */
export function targetStarKey(target: StarTarget, scope: StarScope | null | undefined): string | null {
  if (!scope) return null;
  const kind: StarKind = target.kind;
  if (kind === "file") return target.fileId ? starKey(scope, "file", target.fileId) : null;
  if (kind === "drive") return starKey(scope, "drive");
  return target.path ? starKey(scope, "folder", target.path) : null;
}

/**
 * The star a row shows: this session's own toggle wins (it is newer than any
 * listing), then the listing's `favorite` (absent means the server did not
 * say), then whether the item is in the Starred list.
 */
export function resolveStarred(
  toggle: boolean | undefined,
  favorite: boolean | null | undefined,
  inStarredList: boolean,
): boolean {
  if (toggle !== undefined) return toggle;
  if (favorite === true || favorite === false) return favorite;
  return inStarredList;
}

/** The toast after one item was starred or unstarred. */
export function starToast(name: string, favorite: boolean): string {
  return favorite ? `"${name}" added to Starred` : `"${name}" removed from Starred`;
}

/** The toast after a batch. */
export function starBatchToast(count: number, favorite: boolean): string {
  const items = count === 1 ? "1 item" : `${count} items`;
  return favorite ? `${items} added to Starred` : `${items} removed from Starred`;
}

/** The sentence Rust uses when the account already holds 1,000 stars. */
export const STARS_FULL_MESSAGE = "You can star up to 1,000 items. Unstar some to add more.";

/** One error toast for a batch that did not fully go through. */
export function starBatchFailure(failed: number, done: number, favorite: boolean, full: boolean): string {
  if (full) return STARS_FULL_MESSAGE;
  const verb = favorite ? "star" : "unstar";
  const items = failed === 1 ? "1 item" : `${failed} items`;
  if (done === 0) return `Couldn't ${verb} ${items}. Try again.`;
  return `Couldn't ${verb} ${items}. Try again. ${starBatchToast(done, favorite)}.`;
}
