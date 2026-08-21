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
}

export interface RemoteFolder {
  folderName: string;
  deviceName: string;
  lastModified: number;
  fileCount: number;
  totalBytes: number;
}
