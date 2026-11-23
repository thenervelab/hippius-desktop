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
