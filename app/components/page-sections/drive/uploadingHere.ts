import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";

/**
 * Uploads on their way into the folder on screen, from the same
 * `remote_upload_progress` rows the sync widget reads. A capture uploads
 * straight to the server, so it is not in the folder's listing until it
 * lands; this lets "Show in folder" open on a folder that already shows it
 * arriving.
 */

/** The folder part of a wire path: "Captures/a.mp4" → "Captures". */
export function parentOf(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? "" : trimmed.slice(0, i);
}

/** Rows going into `subPath` of drive `label` and not finished yet, oldest first. */
export function uploadsInFolder(
  rows: Record<string, RemoteUploadProgress>,
  label: string | null,
  subPath: string | null,
): RemoteUploadProgress[] {
  if (!label) return [];
  const folder = (subPath ?? "").replace(/^\/+|\/+$/g, "");
  return Object.values(rows).filter(
    (r) => r.label === label && parentOf(r.path) === folder && r.status !== "completed",
  );
}

/** 0 to 100, or null while encrypting (nothing sent yet). */
export function rowPercent(row: RemoteUploadProgress): number | null {
  if (row.status === "encrypting" || row.status === "pending" || row.totalBytes <= 0) return null;
  return Math.min(99, Math.round((row.bytesTransferred / row.totalBytes) * 100));
}
