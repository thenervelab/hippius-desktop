import { invoke } from "@tauri-apps/api/core";

/** One file that did not upload, mirroring Rust's `RemoteUploadFailure`. */
export interface RemoteUploadFailure {
  name: string;
  error: string;
}

/**
 * Upload files into a Drive folder that is not synced on this computer.
 *
 * Distinct from `add_files`, which copies into a local sync folder and lets
 * the sync engine push it. There is no local folder here, so Rust encrypts
 * and posts each file to the server directly — the same route the web
 * console uploads through.
 *
 * Resolves with the files that FAILED, not with a thrown error: each upload
 * is independent, and one failure must not discard the ones that landed.
 * An empty array means everything succeeded.
 */
export async function uploadFilesToRemoteFolder(
  accountId: string,
  label: string,
  filePaths: string[],
  parentPath?: string,
): Promise<RemoteUploadFailure[]> {
  return invoke<RemoteUploadFailure[]>("upload_files_to_remote_folder", {
    accountId,
    label,
    parentPath: parentPath ?? null,
    filePaths,
  });
}
