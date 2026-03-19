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
  const bytesTransferred = files.reduce(
    (sum, f) => sum + f.bytesTransferred,
    0,
  );
  const bytesExpected = files.reduce(
    (sum, f) => sum + f.totalBytes,
    0,
  );
  const overallPercent =
    files.length === 0
      ? 0
      : completedFiles + failedFiles === files.length
        ? 100
        : bytesExpected > 0
          ? Math.round(
              (bytesTransferred / bytesExpected) * 100,
            )
          : 0;

  return {
    isActive: files.some(
      (f) => f.status === "pending" || f.status === "inProgress",
    ),
    overallPercent,
    bytesTransferred,
    bytesExpected,
    totalFiles: files.length,
    completedFiles,
    failedFiles,
    files,
    ...overrides,
  };
}
