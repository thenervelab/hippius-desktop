// The words around Drive Trash that are the webview's own: toasts, the
// confirm dialogs and the Trash page's dates. Presentation only; every fact
// in them comes from Rust. Items in Trash are deleted forever by the server
// after its retention (`trash_retention_days`, 30 when absent); the app
// only says when.

/** "1 item" / "1,234 items". */
export function itemCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "item" : "items"}`;
}

function quoted(name: string): string {
  return `“${name}”`;
}

/** The toast while a Move to Trash runs. `progress` once Rust reports files. */
export function movingToTrashMessage(names: string[], progress?: { done: number; total: number }): string {
  if (progress && progress.total > 1) {
    return `Moving ${progress.done.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")} files to Trash…`;
  }
  return names.length === 1 ? `Moving ${quoted(names[0])} to Trash…` : `Moving ${itemCount(names.length)} to Trash…`;
}

/** The toast after a Move to Trash, which carries Undo. */
export function movedToTrashMessage(names: string[], trashed: number): string {
  return trashed === 1 && names.length === 1 ? `Moved ${quoted(names[0])} to Trash` : `Moved ${itemCount(trashed)} to Trash`;
}

/** The toast after Undo. */
export function undoneMessage(restored: number, leftInTrash: number): { title: string; description?: string } {
  const title = restored === 1 ? "Put back" : `Put back ${itemCount(restored)}`;
  if (leftInTrash === 0) return { title };
  return {
    title: restored === 0 ? "Couldn't put it back" : title,
    description:
      leftInTrash === 1
        ? "1 item stayed in Trash because its name is taken. Restore it from Trash."
        : `${itemCount(leftInTrash)} stayed in Trash because their names are taken. Restore them from Trash.`,
  };
}

/** A running restore, delete forever or empty, with Rust's progress. */
export function progressMessage(
  action: "restore" | "delete" | "empty",
  progress: { done: number; total: number } | null,
  count: number,
): string {
  const verb = action === "restore" ? "Restoring" : action === "empty" ? "Emptying Trash" : "Deleting";
  if (action === "empty") return `${verb}…`;
  if (progress && progress.total > 1) {
    const unit = action === "restore" ? "files" : "items";
    return `${verb} ${progress.done.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")} ${unit}…`;
  }
  return `${verb} ${itemCount(count)}…`;
}

export function restoredMessage(names: string[], restored: number): string {
  return restored === 1 && names.length === 1 ? `Restored ${quoted(names[0])}` : `Restored ${itemCount(restored)}`;
}

export const DELETE_FOREVER_TITLE = "Delete forever?";
export const DELETE_FOREVER_BUTTON = "Delete forever";
export const EMPTY_TRASH_TITLE = "Empty Trash?";
export const EMPTY_TRASH_BUTTON = "Empty Trash";

/** The Delete forever confirmation's line. */
export function deleteForeverText(names: string[]): string {
  return names.length === 1
    ? `${quoted(names[0])} will be deleted. This can't be undone.`
    : `These ${itemCount(names.length)} will be deleted. This can't be undone.`;
}

/** The Empty Trash confirmation's line. */
export function emptyTrashText(count: number): string {
  return count === 1
    ? "The item in Trash will be deleted. This can't be undone."
    : `All ${itemCount(count)} in Trash will be deleted. This can't be undone.`;
}

const DAY = 86_400_000;

/** Days an item stays in Trash when the server names none. */
export const DEFAULT_RETENTION_DAYS = 30;

/** The server's retention, or 30 when it sent none. */
export function retentionDays(days: number | null | undefined): number {
  return typeof days === "number" && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

function dayCount(days: number): string {
  return `${days.toLocaleString("en-US")} ${days === 1 ? "day" : "days"}`;
}

/** The line at the top of Trash, and under the Move to Trash toast. */
export function retentionNotice(days: number): string {
  return `Items in Trash are deleted forever after ${dayCount(days)}.`;
}

/** The line under "Trash is empty". */
export function emptyTrashNote(days: number): string {
  return `Items moved to Trash are deleted forever after ${dayCount(days)}.`;
}

/**
 * Whole days until the server deletes an item forever, by the calendar:
 * 0 when that is today, `null` once the time has passed. `purgeAt` and
 * `trashedAt` are unix seconds; with no `purgeAt` it is counted from
 * `trashedAt` and the retention.
 */
export function daysUntilDeleted(
  item: { purgeAt?: number | null; trashedAt: number },
  retention: number,
  now: number = Date.now(),
): number | null {
  const purgeAt = typeof item.purgeAt === "number" ? item.purgeAt * 1000 : (item.trashedAt + retention * 86_400) * 1000;
  if (purgeAt <= now) return null;
  const startOf = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  return Math.max(0, Math.round((startOf(purgeAt) - startOf(now)) / DAY));
}

/** The Trash column under "Deleted forever": "In 12 days", "Today", "Soon". */
export function deletedForeverIn(days: number | null): string {
  if (days === null) return "Soon";
  if (days === 0) return "Today";
  return `In ${dayCount(days)}`;
}

/** The same as one phrase, for the row's line on narrow screens. */
export function deletedForeverPhrase(days: number | null): string {
  if (days === null) return "Deleting soon";
  if (days === 0) return "Deleted today";
  return `Deleted in ${dayCount(days)}`;
}

/** The full date and time it was moved to Trash, for a tooltip. */
export function deletedExact(trashedAt: number): string {
  return new Date(trashedAt * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Where an item was: "My Drive / Legal" style, the drive then its folder. */
export function locationOf(driveName: string, parentPath: string): string {
  const folders = parentPath.split("/").filter(Boolean);
  return [driveName, ...folders].join(" / ");
}
