import { invoke } from "@tauri-apps/api/core";

export interface SyncPathResult {
    path: string;
    label: string;
}

export async function getPrivateSyncPath(accountId?: string): Promise<SyncPathResult> {
    try {
        const result = await invoke<{ path: string; label: string }>("get_sync_path", {
            params: { isPublic: false, accountId },
        });
        return { path: result.path, label: result.label };
    } catch (error) {
        console.error("Error fetching sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
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
        const result = await invoke<{ path: string; label: string }>("get_sync_path", {
            params: { isPublic: true, accountId },
        });
        return { path: result.path, label: result.label };
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
