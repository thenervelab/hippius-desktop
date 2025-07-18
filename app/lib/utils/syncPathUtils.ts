import { invoke } from "@tauri-apps/api/core";

/**
 * Gets the configured sync path from the backend
 * @returns The sync path as a string
 */
export async function getSyncPath(): Promise<string> {
    try {
        const result = await invoke<{ path: string }>("get_sync_path", { isPublic: false });
        return result.path;
    } catch (error) {
        console.error("Error fetching sync path:", error);
        throw error;
    }
}

/**
 * Sets the sync path
 * @param path The path to set as sync path
 * @returns Result message from the backend
 */
export async function setSyncPath(path: string): Promise<string> {
    try {
        return await invoke<string>("set_sync_path", {
            params: { path, is_public: false },
        });
    } catch (error) {
        console.error("Error setting sync path:", error);
        throw error;
    }
}
