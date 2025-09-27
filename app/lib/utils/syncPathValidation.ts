import { getPrivateSyncPath, getPublicSyncPath } from "./syncPathUtils";

/**
 * Check if sync path validation is needed before uploading files.
 * Returns true if sync path is empty string (user skipped) or false if path exists
 */
export async function needsSyncPathValidation(isPrivateView: boolean): Promise<boolean> {
    try {
        const syncPath = isPrivateView ? await getPrivateSyncPath() : await getPublicSyncPath();

        // If sync path is empty string, user has skipped setup and validation is needed
        // If sync path has value, validation is not needed
        // If sync path is null/undefined, this will be handled by the main flow
        return syncPath === "";
    } catch (error) {
        console.error("Error checking sync path:", error);
        return false; // If we can't check, don't block the user
    }
}

/**
 * Get the current sync path for the given view
 */
export async function getCurrentSyncPath(isPrivateView: boolean): Promise<string> {
    try {
        return isPrivateView ? await getPrivateSyncPath() : await getPublicSyncPath();
    } catch (error) {
        console.error("Error getting current sync path:", error);
        return "";
    }
}