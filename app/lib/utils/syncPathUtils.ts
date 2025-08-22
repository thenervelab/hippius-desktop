import { invoke } from "@tauri-apps/api/core";

export async function getPrivateSyncPath(): Promise<string> {
    try {
        const result = await invoke<{ path: string }>("get_sync_path", { isPublic: false });
        return result.path;
    } catch (error) {
        console.error("Error fetching sync path:", error);
        throw error;
    }
}

export async function setPrivateSyncPath(path: string, polkadotAddress: string, mnemonic: string): Promise<string> {
    try {
        return await invoke<string>("set_sync_path", {
            params: { path, is_public: false, account_id: polkadotAddress, mnemonic },
        });
    } catch (error) {
        console.error("Error setting sync path:", error);
        throw error;
    }
}


export async function getPublicSyncPath(): Promise<string> {
    try {
        const result = await invoke<{ path: string }>("get_sync_path", { isPublic: true });
        return result.path;
    } catch (error) {
        console.error("Error fetching sync path:", error);
        throw error;
    }
}

export async function setPublicSyncPath(path: string, polkadotAddress: string, mnemonic: string): Promise<string> {
    try {
        return await invoke<string>("set_sync_path", {
            params: { path, is_public: true, account_id: polkadotAddress, mnemonic },
        });
    } catch (error) {
        console.error("Error setting sync path:", error);
        throw error;
    }
}
