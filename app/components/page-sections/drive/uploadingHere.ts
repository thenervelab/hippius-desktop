import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";
import { cappedPercent } from "@/app/lib/upload-feed/percent";

/**
 * Uploads on their way into the folder on screen, from the same rows the sync
 * widget reads: `remote_upload_progress` for a drive uploaded to directly,
 * and the sync engine's snapshot for a drive synced here (where a capture is
 * saved into the folder and the engine uploads it). Either way the file is
 * not in the folder's listing until it lands; this lets "Show in folder"
 * open on a folder that already shows it arriving.
 */

/** The folder part of a wire path: "Captures/a.mp4" → "Captures". */
export function parentOf(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? "" : trimmed.slice(0, i);
}

/** The last segment of a drive-relative path: the file's own name. */
export function baseNameOf(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** One row of the strip, whichever feed it came from. */
export interface UploadingRow {
  path: string;
  fileName: string;
  status: string;
  bytesTransferred: number;
  totalBytes: number;
}

/**
 * Rows going into `subPath` of drive `label` and not finished yet, oldest
 * first: direct uploads, then the sync engine's uploads not already listed
 * (a path is shown once).
 */
export function uploadsInFolder(
  rows: Record<string, RemoteUploadProgress>,
  label: string | null,
  subPath: string | null,
  syncFiles: readonly FileProgress[] = [],
): UploadingRow[] {
  if (!label) return [];
  const folder = (subPath ?? "").replace(/^\/+|\/+$/g, "");
  const here = (r: { label: string; path: string; status: string }) =>
    r.label === label && parentOf(r.path) === folder && r.status !== "completed";
  const direct: UploadingRow[] = Object.values(rows).filter(here);
  const seen = new Set(direct.map((r) => r.path.replace(/^\/+/, "")));
  const synced = syncFiles.filter((f) => f.action === "upload" && here(f) && !seen.has(f.path.replace(/^\/+/, "")));
  return [...direct, ...synced];
}

/** 0 to 100, or null while encrypting (nothing sent yet). */
export function rowPercent(row: Pick<UploadingRow, "status" | "bytesTransferred" | "totalBytes">): number | null {
  if (row.status === "encrypting" || row.status === "pending") return null;
  return cappedPercent(row.bytesTransferred, row.totalBytes);
}
