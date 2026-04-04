import { invoke } from "@tauri-apps/api/core";

export interface SyncPathResult {
    path: string;
    label: string;
    isPublic: boolean;
    isPaused: boolean;
}

export async function getPrivateSyncPath(accountId?: string): Promise<SyncPathResult | null> {
    try {
        return await invoke<SyncPathResult>("get_sync_path", {
            params: { isPublic: false, accountId },
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("not set yet")) {
            return null;
        }
        console.error("Error fetching sync path:", error);
        throw new Error(msg);
    }
}

export async function setPrivateSyncPath(
    path: string,
    polkadotAddress: string,
    label?: string,
): Promise<string> {
    try {
        return await invoke<string>("set_sync_path", {
            params: { path, isPublic: false, accountId: polkadotAddress, label },
        });
    } catch (error) {
        console.error("Error setting sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}


export async function getPublicSyncPath(accountId?: string): Promise<SyncPathResult> {
    try {
        return await invoke<SyncPathResult>("get_sync_path", {
            params: { isPublic: true, accountId },
        });
    } catch (error) {
        console.error("Error fetching sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}

export async function setPublicSyncPath(
    path: string,
    polkadotAddress: string,
    label?: string,
): Promise<string> {
    try {
        return await invoke<string>("set_sync_path", {
            params: { path, isPublic: true, accountId: polkadotAddress, label },
        });
    } catch (error) {
        console.error("Error setting sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}

export async function getAllSyncPaths(
    accountId?: string,
): Promise<SyncPathResult[]> {
    try {
        return await invoke<SyncPathResult[]>("get_all_sync_paths", {
            params: { isPublic: false, accountId },
        });
    } catch (error) {
        console.error("Error fetching all sync paths:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}

export async function removeSyncPath(
    accountId: string,
    label: string,
): Promise<void> {
    await invoke("remove_sync_path", { accountId, label });
}

/// Expand the Tauri asset protocol scope to include the given directory,
/// so files within it can be displayed via `asset://` URLs.
export async function allowAssetScope(path: string): Promise<void> {
    await invoke("allow_asset_scope", { path });
}

/// Returns the default sync folder path for use as `defaultPath` in OS file
/// dialogs. Returns `undefined` (not an empty string) when unavailable so
/// callers can fall back to the OS default location.
export async function getSyncFolderDefaultPath(
    accountId?: string,
): Promise<string | undefined> {
    try {
        const result = await getPrivateSyncPath(accountId);
        return result?.path || undefined;
    } catch {
        return undefined;
    }
}
