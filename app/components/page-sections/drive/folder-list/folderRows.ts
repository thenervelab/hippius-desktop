/**
 * One flat list of folders, however they reach this computer.
 *
 * The Drive page used to show three separate sections — "Local Sync
 * Folders", "Sync from Other Devices" and "Not synced on this computer" —
 * which split one idea ("your folders") across three headings and made the
 * page read as three lists that happen to sit together. The console shows
 * one list; so does this now.
 *
 * The distinction those headings carried is real, so it moves onto each
 * row as `presence`: a badge plus a cloud icon for the folders that are
 * not on this machine. Losing it entirely would leave a laptop user
 * unable to tell which folders are consuming local disk.
 */

import type { RemoteFolder, SyncFolder } from "@/app/lib/types/sync-folder";

/**
 * Where a folder actually is, from this computer's point of view.
 *
 * Rust owns the underlying bucket (`RemoteFolderOrigin`); this maps it onto
 * the three states a user can act on differently. The FE must not re-derive
 * it by comparing device names — that is H-077, and it returns the moment
 * two copies of the comparison drift.
 */
export type FolderPresence =
  /** Syncing to this machine: it takes local disk and can be opened offline. */
  | "on-this-device"
  /** Lives on the account, synced by another device. Browsable, not local. */
  | "other-device"
  /** On the account, synced nowhere right now — including folders this
   *  computer used to sync and stopped. */
  | "not-synced-here";

export interface FolderRow {
  /** Stable key: the sync label for a local row, the name for a remote one. */
  id: string;
  folderName: string;
  presence: FolderPresence;
  /** Sync state, only meaningful for `on-this-device`. */
  status?: SyncFolder["status"];
  deviceName?: string;
  fileCount?: number;
  totalBytes?: number;
  lastModified: number;
  /** Present only on a local row, and only for shared (member) drives. */
  ownerSs58?: string;
  /** The underlying row, for menus that still need the original shape. */
  local?: SyncFolder;
  remote?: RemoteFolder;
}

/** Whether this folder needs the cloud mark — i.e. is not on this machine. */
export function isCloudOnly(presence: FolderPresence): boolean {
  return presence !== "on-this-device";
}

/**
 * Short label under the folder name. Deliberately phrased from the user's
 * point of view ("On this computer") rather than the system's ("local
 * sync path"), because it replaces a section heading they used to read.
 */
export function presenceLabel(row: Pick<FolderRow, "presence" | "deviceName">): string {
  switch (row.presence) {
    case "on-this-device":
      return "On this computer";
    case "other-device":
      // Naming the device is the useful part: "which machine has this?"
      return row.deviceName ? `On ${row.deviceName}` : "On another device";
    default:
      return "Not synced here";
  }
}

function presenceForRemote(folder: RemoteFolder): FolderPresence {
  return folder.origin?.kind === "locallyRemoved" ? "not-synced-here" : "other-device";
}

function localLastModified(folder: SyncFolder): number {
  return folder.lastModified ?? folder.lastSynced ?? 0;
}

/**
 * Merge the two sources into the single list the page renders.
 *
 * A name can in principle arrive from both sides — the remote list is
 * meant to hold only folders absent from `sync_paths`, but that is the
 * server's view of this device and it can lag a just-added folder. When
 * it happens the LOCAL row wins: it is the more capable row (it can be
 * paused, browsed offline, have exclusions), and showing the same folder
 * twice in one flat list is worse than in two sections, where the reader
 * could at least see why.
 *
 * Ordering is most-recently-changed first, the way a file browser sorts,
 * with the name as a stable tiebreak so the list does not reshuffle
 * between renders when timestamps match.
 */
export function toFolderRows(
  syncFolders: SyncFolder[],
  remoteFolders: RemoteFolder[],
): FolderRow[] {
  const rows: FolderRow[] = syncFolders.map((folder) => ({
    id: folder.id,
    folderName: folder.folderName,
    presence: "on-this-device",
    status: folder.status,
    deviceName: folder.deviceName,
    fileCount: folder.fileCount,
    totalBytes: folder.totalBytes,
    lastModified: localLastModified(folder),
    ownerSs58: folder.ownerSs58,
    local: folder,
  }));

  const taken = new Set(rows.map((r) => r.folderName));
  for (const folder of remoteFolders) {
    if (taken.has(folder.folderName)) continue;
    taken.add(folder.folderName);
    rows.push({
      id: folder.folderName,
      folderName: folder.folderName,
      presence: presenceForRemote(folder),
      deviceName: folder.deviceName,
      fileCount: folder.fileCount,
      totalBytes: folder.totalBytes,
      lastModified: folder.lastModified,
      remote: folder,
    });
  }

  return rows.sort(
    (a, b) => b.lastModified - a.lastModified || a.folderName.localeCompare(b.folderName),
  );
}
