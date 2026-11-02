import { invoke } from "@tauri-apps/api/core";

import type { RemoteFolder, SyncFolder } from "@/app/lib/types/sync-folder";

/**
 * Every drive on the account, as the Drive page and the Shared Drives page
 * list them: the ones syncing on this computer, and the ones that are only
 * on the server. One Rust call fetches both, joins the stats and works out
 * each folder's status.
 *
 * Every stat field the IPC returns is kept: the folder list renders them
 * inline next to the status pill, and dropping them was once the difference
 * between a row reading "default · Syncing" and one with its size, file
 * count and date.
 *
 * `remoteFailed` says the server's half could not be read (offline, or a
 * server error): `remote` is then empty because nothing is known, not
 * because there are no drives on the server.
 */
export async function fetchSyncFoldersWithStats(
  accountId: string,
): Promise<{ local: SyncFolder[]; remote: RemoteFolder[]; remoteFailed: boolean }> {
  const result = await invoke<{
    local: Array<{
      id: string;
      folderName: string;
      localPath: string;
      status: string;
      fileCount: number | null;
      totalBytes: number | null;
      lastModified: number | null;
      ownerSs58: string | null;
    }>;
    remote: Array<{
      folderName: string;
      deviceName: string;
      fileCount: number;
      totalBytes: number;
      lastModified: number;
      origin: { kind: "locallyRemoved" } | { kind: "otherDevice" };
    }>;
    remoteFailed?: boolean;
  }>("get_sync_folders_with_stats", { accountId });

  return {
    local: result.local.map((f) => ({
      id: f.id,
      folderName: f.folderName,
      localPath: f.localPath,
      isLocal: true,
      status: f.status as "syncing" | "paused",
      fileCount: f.fileCount ?? undefined,
      totalBytes: f.totalBytes ?? undefined,
      lastModified: f.lastModified ?? undefined,
      ownerSs58: f.ownerSs58 ?? undefined,
    })),
    remote: result.remote.map((f) => ({
      folderName: f.folderName,
      deviceName: f.deviceName,
      fileCount: f.fileCount,
      totalBytes: f.totalBytes,
      lastModified: f.lastModified,
      origin: f.origin,
    })),
    remoteFailed: result.remoteFailed === true,
  };
}

/** A drive made on Hippius by {@link createCloudDrive}. */
export interface CreatedCloudDrive {
  /** The drive's name, which is also its label everywhere. */
  label: string;
  folderHash: string;
}

/**
 * Make a drive on Hippius with no folder on this computer, as the console's
 * New drive does. It lists as "Not synced here" and can be shared at once;
 * "Sync to this computer" in its menu binds it to a folder later.
 *
 * Rust checks the name (and that no drive already answers to it) and words
 * every refusal, so a rejection's `message` is shown as is.
 */
export async function createCloudDrive(accountId: string, name: string): Promise<CreatedCloudDrive> {
  return invoke<CreatedCloudDrive>("create_cloud_drive", { accountId, name });
}
