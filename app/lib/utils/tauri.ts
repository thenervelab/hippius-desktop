/* eslint-disable @typescript-eslint/no-explicit-any */
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";

export const openExternalLink = async (url: string) => {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("Failed to open link:", error);
    // Fallback to window.open if tauri plugin fails (e.g. in browser dev mode)
    window.open(url, "_blank");
  }
};

const getMimeType = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "tiff":
    case "tif":
      return "image/tiff";
    case "heic":
    case "heif":
      return "image/heif";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "webm":
      return "video/webm";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "ogg":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "pdf":
      return "application/pdf";
    case "zip":
      return "application/zip";
    case "dmg":
      return "application/x-apple-diskimage";
    case "tar":
      return "application/x-tar";
    case "gz":
      return "application/gzip";
    case "rar":
      return "application/vnd.rar";
    case "7z":
      return "application/x-7z-compressed";
    case "iso":
      return "application/x-iso9660-image";
    case "txt":
    case "csv":
    case "log":
      return "text/plain";
    case "json":
      return "application/json";
    case "html":
      return "text/html";
    case "css":
      return "text/css";
    case "js":
      return "application/javascript";
    case "xml":
      return "application/xml";
    case "md":
    case "mdx":
      return "text/markdown";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
};

export const selectFile = async (
  multiple: boolean = false,
  acceptImagesOnly: boolean = false
): Promise<File[] | null> => {
  try {
    const { downloadDir } = await import("@tauri-apps/api/path");
    let defaultPath: string | undefined;
    try {
      defaultPath = await downloadDir();
    } catch {
      // Fall back to no directory hint
    }
    const selected = await open({
      multiple,
      defaultPath,
      filters: acceptImagesOnly
        ? [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
            },
          ]
        : undefined,
    });

    if (!selected) return null;

    const paths = Array.isArray(selected) ? selected : [selected];
    const files: File[] = [];

    for (const path of paths) {
      // In Tauri v2, the path is the absolute path on the filesystem
      const contents = await readFile(path);
      // Extract filename from path (handles both / and \ separators)
      const name = path.split(/[/\\]/).pop() || "unknown";
      const mimeType = getMimeType(name);

      const file = new File([contents as any], name, { type: mimeType });
      files.push(file);
    }

    return files;
  } catch (error) {
    console.error("Failed to select file:", error);
    return null;
  }
};
