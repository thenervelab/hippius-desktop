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
