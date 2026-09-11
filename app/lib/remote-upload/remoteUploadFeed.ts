import { atom } from "jotai";

import type { FileProgress, SyncSnapshot } from "@/app/lib/types/syncSnapshot";

/** One in-flight remote upload, as Rust reports it. */
export interface RemoteUploadProgress {
  /** Which upload this row belongs to, assigned by Rust. */
  batchId: number;
  path: string;
  fileName: string;
  label: string;
  bytesTransferred: number;
  totalBytes: number;
  status: "pending" | "encrypting" | "inProgress" | "completed" | "error";
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

/**
 * Apply one progress event to the map.
 *
 * A finished batch is KEPT until the NEXT upload starts. Sweeping it on a
 * timer emptied the widget seconds after an upload ended, so the only
 * record that it happened was gone by the time the user looked — and the
 * sidebar widget is easy to miss while the upload is running. Old rows
 * cost nothing; the next batch replaces them.
 *
 * The boundary is Rust's `batchId`, not anything derived here. "A new
 * path while every row has settled" looks like a new upload but is also
 * what a small file finishing before the next file's first event looks
 * like, and treating that as a boundary empties the queue behind the
 * user mid-batch.
 */
export function applyRemoteUpload(
  current: Record<string, RemoteUploadProgress>,
  event: RemoteUploadProgress,
): Record<string, RemoteUploadProgress> {
  const startsNewBatch = Object.values(current).some(
    (r) => r.batchId !== event.batchId,
  );
  return { ...(startsNewBatch ? {} : current), [event.path]: event };
}

/**
 * The widget's row cap, mirroring Rust's `MAX_EVENT_FILES`.
 *
 * A product decision, not a performance one: the widget is about four
 * rows tall, so anything past the first handful is already behind a
 * scroll, and a long list renders as a wall. Lowering is safe; raising
 * re-grows the per-tick payload the freeze guard exists for.
 */
export const MAX_WIDGET_FILES = 10;

/**
 * Rows reserved for the most recent completions, mirroring Rust's
 * `COMPLETED_RETAINED`.
 *
 * Without it a blind truncate drops completed rows first — they sort
 * last — so in a batch larger than the cap a finished upload never
 * appears at all.
 */
export const COMPLETED_RETAINED = 3;

/** Sort rank: errors, then in-flight, then pending, then completed. */
function statusRank(status: FileProgress["status"]): number {
  if (status === "error") return 0;
  if (status === "inProgress" || status === "encrypting" || status === "decrypting") return 1;
  if (status === "pending") return 2;
  return 3;
}

/**
 * Order and truncate the merged rows the way Rust orders the engine's.
 *
 * The two lists are shown in one widget, so they have to obey one rule —
 * otherwise a remote upload could push every engine row off the list, or
 * sit below completed rows nobody is watching.
 */
export function capWidgetFiles(files: FileProgress[]): FileProgress[] {
  const ordered = [...files].sort((a, b) => statusRank(a.status) - statusRank(b.status));
  if (ordered.length <= MAX_WIDGET_FILES) return ordered;

  const firstCompleted = ordered.findIndex((f) => f.status === "completed");
  if (firstCompleted === -1) return ordered.slice(0, MAX_WIDGET_FILES);

  const active = ordered.slice(0, firstCompleted);
  const completed = ordered.slice(firstCompleted);
  const keepCompleted = Math.min(COMPLETED_RETAINED, completed.length);
  const keepActive = Math.min(active.length, MAX_WIDGET_FILES - keepCompleted);
  return [...active.slice(0, keepActive), ...completed.slice(0, MAX_WIDGET_FILES - keepActive)];
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
    // Capped as one list: the engine's rows are already capped by Rust,
    // so appending without re-capping would let a large batch push the
    // widget past the row limit it is sized for.
    files: capWidgetFiles([...snapshot.files, ...files]),
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
