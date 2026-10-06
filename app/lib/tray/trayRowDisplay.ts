import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import {
  fileTypeDisplayLabels,
  getFileTypeFromExtension,
} from "@/app/lib/utils/getTileTypeFromExtension";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { formatUploadedDate } from "@/app/lib/utils/formatUploadedDate";

/**
 * The first word of a row's subtitle. A row Rust listed as a capture reads
 * as a Screenshot or a Recording; any other file reads as its type
 * ("Image", "PDF", "Spreadsheet").
 */
export function trayRowKind(item: UploadFeedItem, isCapture: boolean): string {
  if (item.isFolder) return "Folder";
  const name = item.actualFileName || item.name;
  const ext = name.includes(".") ? (name.split(".").pop() ?? null) : null;
  const type = getFileTypeFromExtension(ext);
  if (isCapture && type === "image") return "Screenshot";
  if (isCapture && type === "video") return "Recording";
  return type ? fileTypeDisplayLabels[type] : "File";
}

/**
 * "Screenshot · 1.7 MB · 5m ago". The time is left out while the file is
 * still on its way (the row's status says where it is instead), and the
 * size when it is not known yet.
 */
export function trayRowSubtitle(
  item: UploadFeedItem,
  isCapture: boolean,
  now: number = Date.now(),
): string {
  const parts = [trayRowKind(item, isCapture)];
  if (typeof item.size === "number" && item.size > 0) {
    parts.push(formatBytes(item.size, 1));
  }
  if (item.feedStatus === "completed") {
    const when = formatUploadedDate(item.createdAt, now);
    if (when) parts.push(when);
  }
  return parts.join(" · ");
}

/** A recording's length for the thumbnail's corner: "0:42", "12:05", "1:02:09". */
export function formatClipDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
