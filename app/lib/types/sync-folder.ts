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
