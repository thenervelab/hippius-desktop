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
  // The combined pair mirrors hcfs-client `build_snapshot` EXACTLY (snapshot.rs):
  // a transfer (upload/download) is two phases of work, so its expected bytes
  // are counted twice (`total_bytes * 2`) and its progress is `encrypted +
  // transferred`. Replicating the doubling here — instead of the old
  // `combined = single` shortcut — is what lets a test reproduce the
  // "doubled total" the widget showed; the shortcut silently masked it.
  let combinedBytesExpected = 0;
  let combinedProgressBytes = 0;
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
    const isTransfer = f.action === "upload" || f.action === "download";
    combinedBytesExpected += f.totalBytes * (isTransfer ? 2 : 1);
    combinedProgressBytes += f.bytesEncrypted + f.bytesTransferred;
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

  const isActive = files.some(
    (f) => f.status === "pending" || f.status === "inProgress" || f.status === "encrypting" || f.status === "decrypting",
  );
  const hasActiveFiles = files.some((f) => f.status !== "completed" && f.status !== "error");
  const isCompleted = !isActive && (completedFiles > 0 || failedFiles > 0);
  const deletedCount = files.filter((f) => (f.action === "local_delete" || f.action === "remote_delete") && f.status === "completed").length;
  const syncedCount = completedFiles - deletedCount;

  return {
    isActive,
    overallPercent,
    progressBytes,
    bytesExpected,
    totalFiles: files.length,
    completedFiles,
    failedFiles,
    retryInSecs: 0,
    lastError: null,
    expectedUploads: 0,
    expectedDownloads: 0,
    expectedLocalDeletes: 0,
    expectedRemoteDeletes: 0,
    startedAt: null,
    completedAt: null,
    files,
    widgetState: isActive ? "active" : isCompleted ? "completed" : "idle",
    widgetVisible: (isActive && files.length > 0) || isCompleted,
    combinedProgressBytes,
    combinedBytesExpected,
    deletedCount,
    syncedCount,
    actualTotal: files.length,
    statusVariant: failedFiles > 0 && !isActive ? "error" : isCompleted && !hasActiveFiles ? "success" : "progress",
    syncDirection: "mixed",
    effectiveInProgress: isActive || hasActiveFiles,
    effectiveCompleted: isCompleted && !hasActiveFiles,
    ...overrides,
  };
}
