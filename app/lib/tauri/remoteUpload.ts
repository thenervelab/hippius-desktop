import { invoke } from "@tauri-apps/api/core";
import type { DriveTarget } from "@/app/lib/tauri/sharedDrives";

/**
 * The identity args the remote-upload IPCs accept, normalised to nulls.
 *
 * Named only for a drive shared with this account that is NOT synced here:
 * it has no local row, and the backend's lenient fallback would otherwise
 * resolve to THIS account's namespace, writing into the wrong drive rather
 * than failing.
 */
function targetArgs(target?: DriveTarget) {
  return {
    ownerSs58: target?.ownerSs58 ?? null,
    folderHash: target?.folderHash ?? null,
  };
}

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
  target?: DriveTarget,
): Promise<RemoteUploadFailure[]> {
  return invoke<RemoteUploadFailure[]>("upload_files_to_remote_folder", {
    accountId,
    label,
    parentPath: parentPath ?? null,
    filePaths,
    ...targetArgs(target),
  });
}

/**
 * Upload a whole folder into a Drive folder that is not synced here.
 *
 * Rust walks the tree and posts each file with the wire path that
 * reproduces the structure on the server — the walk is business logic and
 * stays there, so the frontend hands over one folder path.
 *
 * Resolves with the files that FAILED, like its single-file sibling.
 */
export async function uploadFolderToRemoteFolder(
  accountId: string,
  label: string,
  folderPath: string,
  parentPath?: string,
  target?: DriveTarget,
): Promise<RemoteUploadFailure[]> {
  return invoke<RemoteUploadFailure[]>("upload_folder_to_remote_folder", {
    accountId,
    label,
    parentPath: parentPath ?? null,
    folderPath,
    ...targetArgs(target),
  });
}
