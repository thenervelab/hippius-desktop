export type FileAction = "upload" | "download" | "local_delete" | "remote_delete";
export type FileProgressStatus = "pending" | "inProgress" | "encrypting" | "decrypting" | "completed" | "error";

export interface FileProgress {
  path: string;
  fileName: string;
  label: string;
  action: FileAction;
  status: FileProgressStatus;
  progressPercent: number;
  bytesEncrypted: number;
  bytesTransferred: number;
  totalBytes: number;
  resumedFromBytes?: number;
  error?: string;
}

export interface SyncSnapshot {
  isActive: boolean;
  overallPercent: number;
  /** Best progress bytes across all files — consistent with overallPercent. */
  progressBytes: number;
  bytesExpected: number;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  /** Seconds until next retry attempt. 0 = no retry scheduled. */
  retryInSecs: number;
  /** Error message from the last failed sync cycle. */
  lastError: string | null;
  /** Expected action counts from the session — drives UI text. */
  expectedUploads: number;
  expectedDownloads: number;
  expectedLocalDeletes: number;
  expectedRemoteDeletes: number;
  /** Epoch-ms when the session completed (null if still active). */
  completedAt: number | null;
  files: FileProgress[];
}

export const EMPTY_SNAPSHOT: SyncSnapshot = {
  isActive: false,
  overallPercent: 0,
  progressBytes: 0,
  bytesExpected: 0,
  totalFiles: 0,
  completedFiles: 0,
  failedFiles: 0,
  retryInSecs: 0,
  lastError: null,
  expectedUploads: 0,
  expectedDownloads: 0,
  expectedLocalDeletes: 0,
  expectedRemoteDeletes: 0,
  completedAt: null,
  files: [],
};
