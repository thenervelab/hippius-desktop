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
  /** Epoch-ms when the sync session started (null if no session). */
  startedAt: number | null;
  /** Epoch-ms when the session completed (null if still active). */
  completedAt: number | null;
  files: FileProgress[];
  /** Pre-computed widget state: "active", "completed", "retrying", or "idle". */
  widgetState: string;
  /** Whether the sync status widget should be visible. */
  widgetVisible: boolean;

  // Pre-computed display values from Rust
  combinedProgressBytes: number;
  combinedBytesExpected: number;
  deletedCount: number;
  /** Non-delete completed count */
  syncedCount: number;
  /** Effective total including failed files */
  actualTotal: number;
  /** Badge variant: "progress" | "success" | "error" */
  statusVariant: string;
  /** Primary sync direction: "upload" | "download" | "delete" | "mixed" */
  syncDirection: string;
  /** True when files still processing even if session marked complete */
  effectiveInProgress: boolean;
  /** True only when session complete AND no files still processing */
  effectiveCompleted: boolean;
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
  startedAt: null,
  completedAt: null,
  files: [],
  widgetState: "idle",
  widgetVisible: false,
  combinedProgressBytes: 0,
  combinedBytesExpected: 0,
  deletedCount: 0,
  syncedCount: 0,
  actualTotal: 0,
  statusVariant: "progress",
  syncDirection: "mixed",
  effectiveInProgress: false,
  effectiveCompleted: false,
};
