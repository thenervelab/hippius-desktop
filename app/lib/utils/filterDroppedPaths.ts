import { stat } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

/**
 * Filter dropped paths — separates files from directories.
 * Shows a toast warning if directories were dropped.
 * Returns only file paths (directories are excluded).
 */
export async function filterDroppedPaths(paths: string[]): Promise<string[]> {
  const results = await Promise.all(
    paths.map(async (p) => {
      const info = await stat(p);
      return { path: p, isDir: info.isDirectory };
    })
  );
  const dirs = results.filter((r) => r.isDir);
  const filePaths = results.filter((r) => !r.isDir).map((r) => r.path);

  if (dirs.length > 0) {
    toast.error(
      "Folders cannot be uploaded via drag & drop. Please use the \"Add Folder\" button instead.",
      { duration: 5000 }
    );
  }

  return filePaths;
}
