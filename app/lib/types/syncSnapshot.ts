export type FileAction = "upload" | "download" | "local_delete" | "remote_delete";
export type FileProgressStatus = "pending" | "inProgress" | "completed" | "error";

export interface FileProgress {
  path: string;
  fileName: string;
  label: string;
  action: FileAction;
  status: FileProgressStatus;
  progressPercent: number;
  bytesTransferred: number;
  totalBytes: number;
  error?: string;
}

export interface SyncSnapshot {
  isActive: boolean;
  overallPercent: number;
  bytesTransferred: number;
  bytesExpected: number;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  files: FileProgress[];
}

export const EMPTY_SNAPSHOT: SyncSnapshot = {
  isActive: false,
  overallPercent: 0,
  bytesTransferred: 0,
  bytesExpected: 0,
  totalFiles: 0,
  completedFiles: 0,
  failedFiles: 0,
  files: [],
};
