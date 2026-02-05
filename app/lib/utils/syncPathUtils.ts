import { invoke } from "@tauri-apps/api/core";

export async function getPrivateSyncPath(accountId?: string): Promise<string> {
    try {
        const result = await invoke<{ path: string }>("get_sync_path", {
            params: { isPublic: false, accountId },
        });
        return result.path;
    } catch (error) {
        console.error("Error fetching sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}

export async function setPrivateSyncPath(path: string, polkadotAddress: string): Promise<string> {
    try {
        return await invoke<string>("set_sync_path", {
            params: { path, is_public: false, account_id: polkadotAddress },
        });
    } catch (error) {
        console.error("Error setting sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}


export async function getPublicSyncPath(accountId?: string): Promise<string> {
    try {
        const result = await invoke<{ path: string }>("get_sync_path", {
            params: { isPublic: true, accountId },
        });
        return result.path;
    } catch (error) {
        console.error("Error fetching sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}

export async function setPublicSyncPath(path: string, polkadotAddress: string): Promise<string> {
    try {
        return await invoke<string>("set_sync_path", {
            params: { path, is_public: true, account_id: polkadotAddress },
        });
    } catch (error) {
        console.error("Error setting sync path:", error);
        throw new Error(error instanceof Error ? error.message : `${error}`);
    }
}
