// Pure rules for moving files and folders within a drive: which
// destination the UI offers, and the words it uses. Rust (`move_entries`)
// checks every rule again, so this decides only what is OFFERED.
// Unit-tested in `__tests__/moveLogic.test.ts`.

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { driveRelativePathFor } from "@/app/lib/utils/driveRelativePath";

/** One item being moved, addressed the way `move_entries` takes it. */
export interface MoveItem {
  /** Relative to the drive (or to a granted folder), `/`-separated. */
  path: string;
  isFolder: boolean;
  /** What the user sees it called. */
  name: string;
}

/** What `move_entries` reports for one item. */
export interface MoveItemResult {
  path: string;
  isFolder: boolean;
  status: "moved" | "skipped" | "clash" | "failed";
  newPath: string | null;
  message: string | null;
  clashIsFolder: boolean;
  replaced: boolean;
}

export type ClashChoice = "ask" | "keepBoth" | "replace" | "skip";

/** Trim slashes and use one separator, so two spellings compare equal. */
export function normalizePath(path: string | null | undefined): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `path` is `folder` or lies under it; `Trip` holds `Trip/a`, not `Trip Photos/a`. */
export function isSameOrInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * A row as a move item. A folder row carries only its basename, so its
 * path is rebuilt from the folder it was listed in (`parentRelativePath`,
 * else the folder on screen), the same way rename and share do it.
 */
export function moveItemFor(
  file: FormattedUserFile,
  currentFolder: string | null | undefined,
): MoveItem {
  const path = normalizePath(driveRelativePathFor(file, currentFolder));
  return { path, isFolder: Boolean(file.isFolder), name: basenameOf(path) || file.name };
}

export const READ_ONLY_REASON = "You can only view this drive";
export const FROZEN_REASON = "This drive is frozen";
export const INSIDE_ITSELF = "A folder can't go inside itself";
export const ALREADY_THERE = "Already in this folder";

/**
 * Why `items` cannot move into `destination`, or `null` when they can.
 *
 * Refused when nothing would change for ALL of them (each already lives
 * there), or when ANY folder would go into itself: a drop that silently
 * moves half the selection is worse than one that says why it will not.
 */
export function moveProblem(
  items: readonly MoveItem[],
  destination: string,
  readOnlyReason: string | null = null,
): string | null {
  if (readOnlyReason) return readOnlyReason;
  if (items.length === 0) return ALREADY_THERE;
  const dest = normalizePath(destination);
  if (items.some((item) => item.isFolder && isSameOrInside(dest, item.path))) {
    return INSIDE_ITSELF;
  }
  if (items.every((item) => parentOf(item.path) === dest)) return ALREADY_THERE;
  return null;
}

/** "Move 3 items", or "Move "name"" for one. */
export function moveTitle(items: readonly MoveItem[]): string {
  if (items.length === 1) return `Move "${items[0].name}"`;
  return `Move ${items.length} items`;
}

/** The label that follows the pointer while dragging. */
export function dragLabel(count: number, targetName: string | null, problem: string | null): string {
  if (targetName && problem) return problem;
  if (targetName) return `Move to ${targetName}`;
  return count === 1 ? "Move 1 item" : `Move ${count} items`;
}

/** The toast after a move; `null` when nothing moved. */
export function movedMessage(movedCount: number, destinationName: string): string | null {
  if (movedCount === 0) return null;
  if (movedCount === 1) return `Moved to ${destinationName}`;
  return `Moved ${movedCount} items to ${destinationName}`;
}

/** "2 items couldn't be moved: <first reason>", or `null`. */
export function failedMessage(results: readonly MoveItemResult[]): string | null {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length === 0) return null;
  const reason = failed[0].message ?? "Something went wrong";
  if (failed.length === 1) return `"${basenameOf(failed[0].path)}" couldn't be moved: ${reason}`;
  return `${failed.length} items couldn't be moved: ${reason}`;
}

/**
 * The moves that put each moved item back, grouped by the folder it came
 * from (one request per folder, since a request has one destination).
 * A replaced file cannot be put back, so a move that replaced one has no
 * Undo at all rather than a partial one: `null`.
 */
export function undoRequests(
  results: readonly MoveItemResult[],
): Array<{ destination: string; items: Array<{ path: string; isFolder: boolean; name: string }> }> | null {
  const moved = results.filter((r) => r.status === "moved" && r.newPath);
  if (moved.length === 0 || moved.some((r) => r.replaced)) return null;
  const byParent = new Map<string, Array<{ path: string; isFolder: boolean; name: string }>>();
  for (const r of moved) {
    const from = parentOf(r.path);
    const list = byParent.get(from) ?? [];
    list.push({ path: r.newPath as string, isFolder: r.isFolder, name: basenameOf(r.path) });
    byParent.set(from, list);
  }
  return [...byParent.entries()].map(([destination, items]) => ({ destination, items }));
}

/**
 * The rows between `anchorKey` and `targetKey` inclusive, in list order,
 * for Shift-click. Falls back to the target alone when the anchor is not
 * on screen any more.
 */
export function rangeBetween<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  anchorKey: string | null,
  targetKey: string,
): T[] {
  const end = rows.findIndex((row) => keyOf(row) === targetKey);
  if (end < 0) return [];
  const start = anchorKey ? rows.findIndex((row) => keyOf(row) === anchorKey) : -1;
  if (start < 0) return [rows[end]];
  const [from, to] = start <= end ? [start, end] : [end, start];
  return rows.slice(from, to + 1);
}

/** Whether a drive view should show the one-time drag hint. */
export function shouldShowMoveHint(
  rows: readonly Pick<FormattedUserFile, "isFolder">[],
  seen: boolean,
): boolean {
  if (seen || rows.length < 2) return false;
  return rows.some((row) => row.isFolder);
}

export const MOVE_HINT_PREF = "drive_move_hint_seen_v1";
