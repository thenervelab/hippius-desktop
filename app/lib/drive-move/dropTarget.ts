// Where a drag lands in the files table, Finder's way: every row stands
// for a folder. A folder row is that folder; any other row (a file, the
// loading or "Folder is empty" line under an expanded folder) is the
// folder it is listed in. This decides only what the drag OFFERS and
// highlights; the refusal rules are `moveProblem`'s, and Rust
// (`move_entries`) checks every one of them again.
// Unit-tested in `__tests__/dropTarget.test.ts`.

import {
  ALREADY_THERE,
  isSameOrInside,
  moveProblem,
  normalizePath,
  type MoveItem,
} from "./moveLogic";

/** A folder a drop can go into, addressed relative to the drive. */
export interface DropFolder {
  path: string;
  name: string;
}

/** A row in the table: its own drive-relative path and whether it is a folder. */
export interface DropRow {
  path: string;
  isFolder: boolean;
  name: string;
}

/**
 * The folder a hovered row stands for: a folder row is itself, anything
 * else is `listedIn`, the folder whose listing it appears in (the folder
 * on screen for a top-level row, the expanded folder for a nested one).
 */
export function rowDropFolder(row: DropRow | null, listedIn: DropFolder): DropFolder {
  if (row?.isFolder) return { path: normalizePath(row.path), name: row.name };
  return { path: normalizePath(listedIn.path), name: listedIn.name };
}

export type DropVerdict =
  | { kind: "none" }
  | { kind: "valid" }
  | { kind: "invalid"; reason: string };

const NONE: DropVerdict = { kind: "none" };

/**
 * What dropping `items` on `folder` would do.
 *
 * - `none`: nothing to show and nothing to move. The pointer is on a row
 *   that is itself being dragged, or every item already lives in that
 *   folder (its siblings all stand for the folder it is in).
 * - `invalid`: refused, with the sentence the drag label shows: a folder
 *   into itself or one of its own subfolders, or a drive that cannot be
 *   changed.
 * - `valid`: a move.
 *
 * `hoveredRowPath` is the hovered row's own path, when the target is a row.
 */
export function dropVerdict(
  items: readonly MoveItem[],
  folder: DropFolder | null,
  hoveredRowPath: string | null = null,
  readOnlyReason: string | null = null,
): DropVerdict {
  if (!folder || items.length === 0) return NONE;
  if (hoveredRowPath !== null) {
    const hovered = normalizePath(hoveredRowPath);
    if (items.some((item) => normalizePath(item.path) === hovered)) return NONE;
  }
  const problem = moveProblem(items, folder.path, readOnlyReason);
  if (problem === ALREADY_THERE) return NONE;
  if (problem) return { kind: "invalid", reason: problem };
  return { kind: "valid" };
}

/** `path` is the folder itself or anywhere under it; everything is under the drive's top. */
function isWithin(path: string, folder: string): boolean {
  return folder === "" || isSameOrInside(path, folder);
}

/**
 * How a row joins the highlight while a drag is over `target`: the
 * target folder's own row, a row anywhere inside it (so the whole
 * expanded group lights up and the level is obvious), or neither.
 *
 * `listedIn` is the folder the row appears in; a placeholder row passes
 * the expanded folder it sits under and `row` null.
 */
export function dropGroupRole(
  row: Pick<DropRow, "path" | "isFolder"> | null,
  listedIn: string,
  target: string | null,
): "target" | "member" | null {
  if (target === null) return null;
  const dest = normalizePath(target);
  if (row?.isFolder && normalizePath(row.path) === dest) return "target";
  if (isWithin(normalizePath(listedIn), dest)) return "member";
  return null;
}
