import { invoke } from "@tauri-apps/api/core";

/** `AppError::Io` (a missing path), matched on the structured `kind`, as `revealFile` does. */
function isIoError(error: unknown): boolean {
  return (error as { kind?: unknown } | null)?.kind === "Io";
}

interface SaveFileToDesktopParams {
  /** The file's path on this computer, tried first (the row's `source`). */
  sourcePath?: string;
  /** Drive label, to find the file when `sourcePath` is missing or stale. */
  label?: string;
  /** Account address, with `label`. */
  accountId?: string;
  /** The file's name in its drive. */
  fileName: string;
}

/**
 * Put a copy of a drive file that is on this computer on the Desktop, found
 * the same way "Reveal in Finder" finds it: its own path first, else the
 * path Rust resolves from the drive. Rust checks the file is in one of the
 * account's synced folders, picks a free name and makes the copy; this
 * returns its sentence for the toast ("Saved to your Desktop as ...").
 */
export async function saveFileToDesktop(params: SaveFileToDesktopParams): Promise<string> {
  const { sourcePath, label, accountId, fileName } = params;
  if (sourcePath) {
    try {
      return await invoke<string>("save_file_to_desktop", { path: sourcePath });
    } catch (error) {
      if (!isIoError(error)) throw error;
    }
  }
  if (label && accountId) {
    const path = await invoke<string>("resolve_file_path", { accountId, label, fileName });
    return invoke<string>("save_file_to_desktop", { path });
  }
  throw new Error("This file isn't on this computer, so it can't be saved to the Desktop.");
}
