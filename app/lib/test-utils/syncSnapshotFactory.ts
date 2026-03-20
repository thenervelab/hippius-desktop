import {
  type SyncSnapshot,
  type FileProgress,
  type FileAction,
  type FileProgressStatus,
} from "../types/syncSnapshot";

export function makeFileProgress(
  fileName: string,
  overrides: Partial<FileProgress> = {},
): FileProgress {
  return {
    path: `/${fileName}`,
    fileName,
    label: "default",
    action: "upload" as FileAction,
    status: "pending" as FileProgressStatus,
    progressPercent: 0,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    ...overrides,
  };
}

export function makeSnapshot(
  files: FileProgress[],
  overrides: Partial<SyncSnapshot> = {},
): SyncSnapshot {
  const completedFiles = files.filter(
    (f) => f.status === "completed",
  ).length;
  const failedFiles = files.filter((f) => f.status === "error").length;
  // Failed files count toward expected but NOT toward progress bytes.
  let bytesExpected = 0;
  let progressBytes = 0;
  for (const f of files) {
    if (f.status === "completed") {
      bytesExpected += f.totalBytes;
      progressBytes += f.totalBytes;
    } else if (f.status === "error") {
      bytesExpected += f.totalBytes;
    } else if (f.totalBytes > 0) {
      bytesExpected += f.totalBytes;
      progressBytes += f.bytesTransferred > 0 ? f.bytesTransferred : f.bytesEncrypted;
    }
  }
  const overallPercent =
    files.length === 0
      ? 0
      : failedFiles === 0 && completedFiles === files.length
        ? 100
        : bytesExpected > 0
          ? Math.round(
              (progressBytes / bytesExpected) * 100,
            )
          : 0;

  return {
    isActive: files.some(
      (f) => f.status === "pending" || f.status === "inProgress" || f.status === "encrypting" || f.status === "decrypting",
    ),
    overallPercent,
    progressBytes,
    bytesExpected,
    totalFiles: files.length,
    completedFiles,
    failedFiles,
    retryInSecs: 0,
    lastError: null,
    files,
    ...overrides,
  };
}
