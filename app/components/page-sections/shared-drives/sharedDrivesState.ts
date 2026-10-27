// Pure rules for the Shared Drives page. Unit-tested in
// `__tests__/sharedDrivesState.test.ts`.

import { isDriveShared, type DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import {
  makeFolderGrantLabel,
  makeSharedDriveLabel,
} from "@/app/lib/shared-drives/sharedDriveLabel";
import { driveFolderRoute, sharedDriveRoute } from "@/app/lib/routes";
import type { FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";

/**
 * This account's own drives. A drive shared WITH it carries its owner's
 * address on the row; one it owns carries none.
 */
export function ownDriveRows(rows: readonly FolderRow[]): FolderRow[] {
  return rows.filter((r) => !r.ownerSs58);
}

/**
 * "Shared by Me": own drives shared as a whole, with people in them or with
 * invite links out (lapsed ones included, as the drive page's badge counts
 * them). A drive whose sharing is not known is left out rather than guessed,
 * and a drive where only one folder is shared is not a shared drive.
 */
export function sharedByMeRows(
  rows: readonly FolderRow[],
  sharingByLabel: ReadonlyMap<string, DriveSharing>,
): FolderRow[] {
  return ownDriveRows(rows).filter((r) => isDriveShared(sharingByLabel.get(r.folderName)));
}

/**
 * Where opening an own drive goes: the Drive page with it open, synced here
 * or not, the way its row on the drive page opens it.
 */
export function ownDriveRoute(row: FolderRow): string {
  return row.local ? driveFolderRoute(row.local.id, false) : driveFolderRoute(row.folderName, true);
}

/** Where opening a drive shared with this account goes, without syncing it here. */
export function joinedDriveRoute(identity: {
  ownerSs58: string;
  folderHash: string;
  displayLabel: string;
}): string {
  return sharedDriveRoute(makeSharedDriveLabel(identity), identity.displayLabel);
}

/** Where opening a folder shared with this account goes, rooted at that folder. */
export function folderGrantRoute(grant: {
  ownerSs58: string;
  folderHash: string;
  pathPrefix: string;
  folderName: string;
}): string {
  return sharedDriveRoute(makeFolderGrantLabel(grant), grant.folderName);
}

// The tabs, the totals and the pages.

/** Which kind of shared drive the list shows. */
export type SharedDrivesFilter = "all" | "with-you" | "by-you";

/** Whether one kind of shared drive has answered. */
export type SharedKindStatus = "loading" | "error" | "ready";

/** One kind's answer: its status, and how many rows it has to show. */
export interface SharedKind {
  status: SharedKindStatus;
  count: number;
}

/**
 * Where "Shared by you" stands.
 *
 * The list holds only SHARED own drives, so it has two questions to ask:
 * which drives there are, and which of them are shared. Either failing
 * means the page cannot say, so it is an error and never "none". The
 * sharing IPC leaves out a drive whose listings both failed and still
 * answers OK, so own drives with not one answer between them is a failure
 * too (resolving an own drive is local and lenient, so only the network
 * drops every one of them). A drive that simply is not shared still has an
 * answer, with zero people.
 */
export function sharedByYouStatus(input: {
  foldersLoading: boolean;
  foldersFailed: boolean;
  ownDriveCount: number;
  sharingPending: boolean;
  sharingFailed: boolean;
  sharingAnswered: number;
}): SharedKindStatus {
  if (input.foldersLoading) return "loading";
  if (input.foldersFailed) return "error";
  if (input.ownDriveCount === 0) return "ready";
  if (input.sharingPending) return "loading";
  if (input.sharingFailed || input.sharingAnswered === 0) return "error";
  return "ready";
}

/**
 * Where "Shared with you" stands. A server with shared drives switched off
 * is a real "none" (the quiet degrade), not an error; a fetch that failed
 * is an error, never folded into "none" the way Settings folds it.
 */
export function sharedWithYouStatus(input: {
  memberships: "idle" | "loading" | "ready" | "unavailable" | "error";
  grantsSettled: boolean;
}): SharedKindStatus {
  if (input.memberships === "idle" || input.memberships === "loading") return "loading";
  if (input.memberships === "error") return "error";
  return input.grantsSettled ? "ready" : "loading";
}

/**
 * Whether the tabs are worth drawing: once both kinds have answered (so they
 * appear once, not one by one) and the list has anything in it. Shown with
 * only one kind too, so the empty one can say what would go there; with
 * nothing either way the page's own empty state says it instead.
 */
export function showSharedDrivesTabs(kinds: { byYou: SharedKind; withYou: SharedKind }): boolean {
  const { byYou, withYou } = kinds;
  if (byYou.status === "loading" || withYou.status === "loading") return false;
  return byYou.count + withYou.count > 0;
}

/**
 * The filter actually applied. Without the tabs there is no tab to leave a
 * filter by, so the list is all of it.
 */
export function effectiveSharedDrivesFilter(filter: SharedDrivesFilter, tabsShown: boolean): SharedDrivesFilter {
  return tabsShown ? filter : "all";
}

/**
 * A tab's count pill. A kind that failed has no count (a "0" there would be
 * a confident lie), and neither does All while one of its halves failed.
 */
export function sharedDrivesTabCount(kinds: SharedKind[]): number | undefined {
  if (kinds.some((k) => k.status === "error")) return undefined;
  return kinds.reduce((sum, k) => sum + k.count, 0);
}

/** What the list area shows. */
export type SharedDrivesContent =
  /** Nothing to show yet: skeleton rows, never an early "nothing shared". */
  | { kind: "loading" }
  /** The tab's drives could not be loaded, and there are none to show. */
  | { kind: "error"; scope: SharedDrivesFilter }
  /** Everything in scope answered, and there is nothing in it. */
  | { kind: "empty"; scope: SharedDrivesFilter }
  /**
   * Rows. `pending`: a kind in scope is still loading under them.
   * `failed`: kinds in scope that could not be loaded, said in a line
   * above the rows that are there.
   */
  | { kind: "rows"; pending: boolean; failed: Array<"by-you" | "with-you"> };

/**
 * Decide the list area for the applied filter.
 *
 * Rows win: whatever has arrived is shown, with a placeholder for a kind
 * still on its way and a line for one that failed. With no rows, a kind
 * still loading holds the skeleton, a failed one means the page cannot say
 * the tab is empty, and only then is it empty. The empty states word their
 * action by plan ("Share a drive" or "Upgrade plan"), so an empty list also
 * waits for the plan rather than flashing one and swapping to the other.
 */
export function resolveSharedDrivesContent(input: {
  filter: SharedDrivesFilter;
  byYou: SharedKind;
  withYou: SharedKind;
  planKnown: boolean;
}): SharedDrivesContent {
  const { filter, byYou, withYou, planKnown } = input;
  const inScope: Array<["by-you" | "with-you", SharedKind]> = [];
  if (filter !== "with-you") inScope.push(["by-you", byYou]);
  if (filter !== "by-you") inScope.push(["with-you", withYou]);

  const rows = inScope.reduce((sum, [, k]) => sum + k.count, 0);
  const pending = inScope.some(([, k]) => k.status === "loading");
  const failed = inScope.filter(([, k]) => k.status === "error").map(([key]) => key);

  if (rows > 0) return { kind: "rows", pending, failed };
  if (pending) return { kind: "loading" };
  if (failed.length > 0) return { kind: "error", scope: filter };
  if (!planKnown) return { kind: "loading" };
  return { kind: "empty", scope: filter };
}

/**
 * One drive's contribution to the figures over the list. `hasStats` is
 * false while (or when) nobody managed to read the drive's size: an
 * unknown is not a zero, and summing it in as one would under-report the
 * total while looking perfectly healthy.
 */
export interface SharedDriveStatRow {
  hasStats: boolean;
  totalBytes: number;
  fileCount: number;
}

export interface SharedDriveListTotals {
  /** No drives in the list, so zero is the whole truth. */
  isEmpty: boolean;
  /** Drives exist but not one of their sizes could be read. */
  isUnknown: boolean;
  totalBytes: number;
  fileCount: number;
}

/** The console's `sharedDriveListTotals`: known drives summed, unknown ones left out. */
export function sharedDriveListTotals(rows: readonly SharedDriveStatRow[]): SharedDriveListTotals {
  const known = rows.filter((row) => row.hasStats);
  return {
    isEmpty: rows.length === 0,
    isUnknown: rows.length > 0 && known.length === 0,
    totalBytes: known.reduce((sum, row) => sum + row.totalBytes, 0),
    fileCount: known.reduce((sum, row) => sum + row.fileCount, 0),
  };
}

/** An own drive's figures, from the drive listing. Absent bytes are unknown. */
export function ownDriveStatRow(row: Pick<FolderRow, "totalBytes" | "fileCount">): SharedDriveStatRow {
  return {
    hasStats: row.totalBytes !== undefined,
    totalBytes: row.totalBytes ?? 0,
    fileCount: row.fileCount ?? 0,
  };
}

/**
 * What an unknown figure shows: the dash the rows and the console use for a
 * size nobody could read. Written as an escape so the glyph is deliberate.
 */
export const UNKNOWN_FIGURE = "\u2014";

/**
 * How the totals read, worded as the console words them: "0 B" and 0 for an
 * empty list, a dash for an unknown one (never a confident zero), the sum
 * otherwise. Sizes use the app's SI formatter, as every row does.
 */
export function formatSharedDriveListTotals(
  totals: SharedDriveListTotals,
  formatBytes: (_bytes: number) => string,
): { size: string; files: string | number } {
  if (totals.isEmpty) return { size: "0 B", files: 0 };
  if (totals.isUnknown) return { size: UNKNOWN_FIGURE, files: UNKNOWN_FIGURE };
  return { size: formatBytes(totals.totalBytes), files: totals.fileCount };
}

/**
 * Drives per page on the Shared Drives page. Ten, the console's list page
 * size; with ten or fewer in the tab there is no pager at all.
 */
export const SHARED_DRIVES_PAGE_SIZE = 10;

/** A half-open slice of one kind's rows. */
export interface RowSlice {
  start: number;
  end: number;
}

/**
 * Which rows of each kind one page of the list holds.
 *
 * The list is one sequence: your own shared drives first, then the drives
 * and folders shared with you, and a page is a window over it. "By you" and
 * "With you" are the same sequence with the other kind empty, so every tab
 * pages the same way and one pager serves all three.
 */
export function sharedDrivesPageSlices(input: {
  byYou: number;
  withYou: number;
  start: number;
  end: number;
}): { byYou: RowSlice; withYou: RowSlice } {
  const { byYou, withYou, start, end } = input;
  const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), max);
  return {
    byYou: { start: clamp(start, byYou), end: clamp(end, byYou) },
    withYou: { start: clamp(start - byYou, withYou), end: clamp(end - byYou, withYou) },
  };
}
