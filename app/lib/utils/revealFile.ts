import { invoke } from "@tauri-apps/api/core";
import { isIoError } from "@/lib/utils/dispatchTauriError";

interface RevealFileParams {
  /** Direct source path to try first (e.g. file.source). */
  sourcePath?: string;
  /** Drive label for DB fallback. */
  label?: string;
  /** Account address for DB fallback. */
  accountId?: string;
  /** File name for DB fallback. */
  fileName: string;
  /** If true, reveal the containing folder instead of the file. */
  revealFolder?: boolean;
}

/**
 * Reveal a file (or its containing folder) in the system file manager.
 *
 * Tries the direct source path first. If that fails, falls back to
 * resolving the canonical path from the DB via Rust `resolve_file_path`.
 *
 * Throws with a user-facing message if the file cannot be found locally.
 */
export async function revealFile(params: RevealFileParams): Promise<void> {
  const { sourcePath, label, accountId, fileName, revealFolder } = params;

  // Try direct source path first
  if (sourcePath) {
    try {
      const target = revealFolder ? stripFileName(sourcePath, fileName) : sourcePath;
      await invoke("reveal_path_in_file_manager", { path: target });
      return;
    } catch (error) {
      // Missing path is Io (canonicalize). Other kinds — xdg-open
      // missing, Validation (not a sync folder) — must surface.
      // invoke() rejects a plain { kind, message }, not Error.
      if (!isIoError(error)) {
        throw error;
      }
    }
  }

  // Fallback: resolve canonical path from DB
  if (label && accountId) {
    const filePath = await invoke<string>("resolve_file_path", {
      accountId,
      label,
      fileName,
    });
    const target = revealFolder ? stripFileName(filePath, fileName) : filePath;
    await invoke("reveal_path_in_file_manager", { path: target });
    return;
  }

  throw new Error("File is not available locally. It may only exist on another device.");
}

/** Strip the filename from a path to get the containing folder. */
function stripFileName(filePath: string, fileName: string): string {
  return filePath.endsWith(fileName)
    ? filePath.slice(0, filePath.length - fileName.length - 1)
    : filePath;
}
