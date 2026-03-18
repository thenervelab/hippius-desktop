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
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
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
