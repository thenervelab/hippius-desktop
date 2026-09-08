import { atom } from "jotai";

import type { FileProgress, SyncSnapshot } from "@/app/lib/types/syncSnapshot";

/** One in-flight remote upload, as Rust reports it. */
export interface RemoteUploadProgress {
  path: string;
  fileName: string;
  label: string;
  bytesTransferred: number;
  totalBytes: number;
  status: "encrypting" | "inProgress" | "completed" | "error";
  error?: string | null;
}

/**
 * Remote uploads in flight, keyed by their wire path.
 *
 * A second source for the sync widget rather than a write into the engine's
 * snapshot: that snapshot is rebuilt wholesale on every emit, so anything
 * written into it would be erased by the engine's next tick.
 */
export const remoteUploadsAtom = atom<Record<string, RemoteUploadProgress>>({});

/** How long a finished row lingers before it is dropped, in ms. */
export const REMOTE_UPLOAD_LINGER_MS = 4000;

/**
 * Apply one progress event to the map.
 *
 * A terminal row is KEPT rather than deleted so the widget can show the
 * file finishing — deleting on completion makes a fast upload flash into
 * existence and vanish, which reads as a glitch rather than as done.
 * `pruneRemoteUploads` drops it once it has been seen.
 */
export function applyRemoteUpload(
  current: Record<string, RemoteUploadProgress>,
  event: RemoteUploadProgress,
  now = Date.now(),
): Record<string, RemoteUploadProgress> {
  return {
    ...current,
    [event.path]: {
      ...event,
      ...(event.status === "completed" || event.status === "error"
        ? { finishedAt: now }
        : {}),
    } as RemoteUploadProgress,
  };
}

/** Drop terminal rows older than the linger window. */
export function pruneRemoteUploads(
  current: Record<string, RemoteUploadProgress>,
  now = Date.now(),
): Record<string, RemoteUploadProgress> {
  const next: Record<string, RemoteUploadProgress> = {};
  for (const [key, row] of Object.entries(current)) {
    const finishedAt = (row as RemoteUploadProgress & { finishedAt?: number }).finishedAt;
    if (finishedAt !== undefined && now - finishedAt > REMOTE_UPLOAD_LINGER_MS) continue;
    next[key] = row;
  }
  return next;
}

function toFileProgress(row: RemoteUploadProgress): FileProgress {
  const total = Math.max(row.totalBytes, 0);
  const sent = Math.min(row.bytesTransferred, total || row.bytesTransferred);
  return {
    path: row.path,
    fileName: row.fileName,
    label: row.label,
    action: "upload",
    status: row.status,
    // Clamped: hcfs reports ciphertext bytes, which can exceed the
    // plaintext total, and a bar past 100% reads as a bug.
    progressPercent: total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0,
    bytesEncrypted: row.status === "encrypting" ? 0 : sent,
    bytesTransferred: sent,
    totalBytes: total,
    ...(row.error ? { error: row.error } : {}),
  };
}

/**
 * Fold remote uploads into the snapshot the widget renders.
 *
 * The engine's own fields are left alone except where they must move for
 * the widget to show anything at all: it hides itself on `widgetVisible`,
 * and counts drive the header. An upload happening outside the engine is
 * still an upload happening, so it has to be reflected there — otherwise
 * the row would render inside a widget that never opens.
 */
export function mergeRemoteUploads(
  snapshot: SyncSnapshot,
  uploads: Record<string, RemoteUploadProgress>,
): SyncSnapshot {
  const rows = Object.values(uploads);
  if (rows.length === 0) return snapshot;

  const files = rows.map(toFileProgress);
  const active = files.filter((f) => f.status !== "completed" && f.status !== "error");
  const completed = files.filter((f) => f.status === "completed");
  const failed = files.filter((f) => f.status === "error");

  const addedBytes = files.reduce((sum, f) => sum + f.totalBytes, 0);
  const sentBytes = files.reduce((sum, f) => sum + f.bytesTransferred, 0);
  const totalBytes = snapshot.bytesExpected + addedBytes;
  const doneBytes = snapshot.progressBytes + sentBytes;

  return {
    ...snapshot,
    isActive: snapshot.isActive || active.length > 0,
    files: [...snapshot.files, ...files],
    totalFiles: snapshot.totalFiles + files.length,
    completedFiles: snapshot.completedFiles + completed.length,
    failedFiles: snapshot.failedFiles + failed.length,
    expectedUploads: snapshot.expectedUploads + files.length,
    syncedCount: snapshot.syncedCount + completed.length,
    actualTotal: snapshot.actualTotal + files.length,
    progressBytes: doneBytes,
    bytesExpected: totalBytes,
    combinedProgressBytes: snapshot.combinedProgressBytes + sentBytes,
    combinedBytesExpected: snapshot.combinedBytesExpected + addedBytes,
    overallPercent:
      totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : snapshot.overallPercent,
    // Without this the rows exist in a widget that never opens.
    widgetVisible: true,
    widgetState: active.length > 0 ? "active" : snapshot.widgetState,
    effectiveInProgress: snapshot.effectiveInProgress || active.length > 0,
    effectiveCompleted: active.length === 0 && snapshot.effectiveCompleted,
  };
}
