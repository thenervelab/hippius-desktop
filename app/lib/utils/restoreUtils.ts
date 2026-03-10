import { invoke } from "@tauri-apps/api/core";

export interface RemoteFolderInfo {
  label: string;
  folder_hash: string;
  file_count: number;
  total_bytes: number;
  created_at: number;
  updated_at: number;
  device_name: string;
}

export interface RestoreResult {
  label: string;
  success: boolean;
  error: string | null;
}

export async function listRemoteFolders(
  accountId: string,
): Promise<RemoteFolderInfo[]> {
  return invoke<RemoteFolderInfo[]>("list_remote_folders", { accountId });
}

export interface DeleteRemoteFolderResult {
  files_deleted: number;
  was_local: boolean;
}

export async function deleteRemoteFolder(
  accountId: string,
  label: string,
): Promise<DeleteRemoteFolderResult> {
  return invoke<DeleteRemoteFolderResult>("delete_remote_folder", {
    accountId,
    label,
  });
}

export async function restoreRemoteFolders(
  accountId: string,
  labels: string[],
  basePath: string,
  existingMnemonic?: string,
): Promise<RestoreResult[]> {
  const folders = labels.map((label) => ({ label }));
  return invoke<RestoreResult[]>("restore_remote_folders", {
    accountId,
    basePath,
    folders,
    existingMnemonic: existingMnemonic ?? null,
  });
}
