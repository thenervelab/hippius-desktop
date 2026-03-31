import { invoke } from "@tauri-apps/api/core";

export interface HcfsConfigResult {
  server_url: string;
  has_password: boolean;
}

export interface InitSyncResult {
  user_id: string;
  mnemonic: string | null;
  is_new_setup: boolean;
}

export async function saveHcfsConfig(
  accountId: string,
  serverUrl: string,
  drivePassword: string
): Promise<void> {
  await invoke("save_hcfs_config", {
    accountId,
    serverUrl,
    drivePassword,
  });
}

export async function getHcfsConfig(
  accountId: string
): Promise<HcfsConfigResult> {
  return invoke<HcfsConfigResult>("get_hcfs_config", { accountId });
}




export async function initializeSync(
  accountId: string,
  label: string,
  existingMnemonic?: string
): Promise<InitSyncResult> {
  return invoke<InitSyncResult>("initialize_sync", {
    accountId,
    label,
    existingMnemonic: existingMnemonic ?? null,
  });
}
