/**
 * Types for multi-folder sync management
 */

export interface SyncFolder {
  id: string;
  folderName: string;
  localPath: string;
  isLocal: boolean;
  deviceName?: string;
  lastSynced?: number;
  status: "syncing" | "paused" | "error";
  /**
   * User-facing reason carried by a backend `DriveStatus.Error` (init
   * failure, revoked shared drive). Set only while `status === "error"`;
   * `applyDriveStatusToRow` clears it when the drive recovers.
   */
  errorMessage?: string;
  fileCount?: number;
  totalBytes?: number;
  lastModified?: number;
  /**
   * The drive OWNER's ss58 when this row is a MEMBER drive (a shared drive
   * synced from another account), absent for the account's own drives.
   * Threaded from Rust (`get_sync_folders_with_stats` → `ownerSs58`) — the
   * FE never infers member-ness; this field is the only discriminant, and
   * it drives the owner badge plus the member-vs-own menu gating
   * (`folderMenuGating.ts`).
   */
  ownerSs58?: string;
}

/**
 * Why a remote-only folder is not in this device's `sync_paths`.
 * Tagged by Rust (`RemoteFolderOrigin`); the FE must not re-derive this
 * by comparing `deviceName` to the local device name.
 */
export type RemoteFolderOrigin =
  | { kind: "locallyRemoved" }
  | { kind: "otherDevice" };

export interface RemoteFolder {
  folderName: string;
  deviceName: string;
  lastModified: number;
  fileCount: number;
  totalBytes: number;
  /**
   * Threaded from Rust. Absent on synthetic browse targets built from a
   * local row (those never hit the remote section).
   */
  origin?: RemoteFolderOrigin;
}
