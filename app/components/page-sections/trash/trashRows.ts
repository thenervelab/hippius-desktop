// Pure helpers for the Trash page's rows.

import type { TrashRow } from "@/app/lib/tauri/trash";

/** One row's identity: an item id is unique within its drive only. */
export function rowKey(row: Pick<TrashRow, "label" | "itemId">): string {
  return `${row.label}::${row.itemId}`;
}

/** The size column: a file's bytes; a folder's files, or "Empty". */
export function sizeLabel(row: Pick<TrashRow, "isFolder" | "fileCount" | "totalBytes">, formatBytes: (n: number) => string): string {
  if (!row.isFolder) return formatBytes(row.totalBytes);
  if (row.fileCount === 0) return "Empty";
  return `${row.fileCount.toLocaleString("en-US")} ${row.fileCount === 1 ? "file" : "files"}`;
}

/**
 * Where the name clash dialog says an item is going back to: the folder
 * (or the drive, at its top) when every clash shares it, else "its folder".
 */
export function clashDestinationName(rows: Pick<TrashRow, "driveName" | "parentPath" | "label">[]): string {
  const places = new Set(rows.map((r) => `${r.label}/${r.parentPath}`));
  if (places.size !== 1) return "its folder";
  const [first] = rows;
  const folders = first.parentPath.split("/").filter(Boolean);
  return `“${folders.length > 0 ? folders[folders.length - 1] : first.driveName}”`;
}

/**
 * What a row in the middle of something says instead of its date: a
 * folder still being moved in (its trash stopped part way; Restore puts it
 * back), or a restore that stopped part way (Restore finishes it, the way
 * it started).
 */
export function rowStatus(row: Pick<TrashRow, "state">): string | null {
  if (row.state === "trashing") return "Still moving to Trash";
  if (row.state === "restoring") return "Restore not finished";
  return null;
}

/** The Restore action's words for a row. */
export function restoreLabel(row: Pick<TrashRow, "state">): string {
  return row.state === "restoring" ? "Finish restoring" : "Restore";
}
