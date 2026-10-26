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
 * Whether "Shared by Me" cannot answer yet: the drives are still loading, or
 * their sharing has not come back. The list holds only shared drives, so
 * before the sharing is known an empty list would claim "nothing shared".
 */
export function sharedByMeLoading(input: { foldersLoading: boolean; sharingPending: boolean }): boolean {
  return input.foldersLoading || input.sharingPending;
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

/**
 * The filter actually applied. The tabs show only when both kinds exist
 * (with one kind they would offer a choice of the same list), so a filter
 * left on a kind that has since emptied falls back to all rather than
 * showing an empty list with no tab to leave it by. The web console's
 * `effectiveSharedListFilter`.
 */
export function effectiveSharedDrivesFilter(
  filter: SharedDrivesFilter,
  counts: { withYou: number; byYou: number },
): SharedDrivesFilter {
  if (counts.withYou === 0 || counts.byYou === 0) return "all";
  return filter;
}

/** Whether the tabs are worth drawing: only when both kinds exist. */
export function showSharedDrivesTabs(counts: { withYou: number; byYou: number }): boolean {
  return counts.withYou > 0 && counts.byYou > 0;
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
