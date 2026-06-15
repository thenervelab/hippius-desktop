import { stat } from "@tauri-apps/plugin-fs";

/**
 * Classification of a set of dropped paths. Callers decide how to react —
 * the table-level listener routes folders to the FolderUploadDialog and
 * files to the FileUploadDialog, while the file-only dropzone shows a
 * dedicated toast when the user drops a folder onto it.
 */
export type ClassifiedDroppedPaths = {
  files: string[];
  folders: string[];
};

/**
 * Stat every path concurrently and split into files / folders. Paths
 * whose `stat` call rejects (deleted between drop and stat, permission
 * error, etc.) are silently dropped — surfacing them as files would
 * cause the uploader to fail later anyway.
 */
export async function filterDroppedPaths(
  paths: string[],
): Promise<ClassifiedDroppedPaths> {
  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const info = await stat(p);
      return { path: p, isDir: info.isDirectory };
    }),
  );
  const files: string[] = [];
  const folders: string[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    if (r.value.isDir) {
      folders.push(r.value.path);
    } else {
      files.push(r.value.path);
    }
  }
  return { files, folders };
}
