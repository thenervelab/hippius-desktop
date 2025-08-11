/**
 * Utility functions for handling folder path construction and tracking
 */

/**
 * Builds the folder path for navigation and backend operations
 * @param currentFolderName - The actual name of the current folder
 * @param mainFolderCID - The actual CID of the main folder
 * @param mainFolderName - The main/root folder name
 * @param existingPath - The existing subfolder path (if any)
 * @returns An object with updated path information
 */
export function buildFolderPath(
    currentFolderName: string,
    mainFolderCID: string,
    mainFolderName?: string | null,
    existingPath?: string | null
): {
    mainFolderCid: string;
    mainFolderActualName: string;
    subFolderPath: string;
} {
    // If no main folder is set yet, the current folder becomes the main folder
    if (!mainFolderName) {
        return {
            mainFolderCid: mainFolderCID,
            mainFolderActualName: currentFolderName,
            subFolderPath: ''
        };
    }

    // When we already have a main folder and we're navigating to a subfolder
    if (!existingPath || existingPath === '') {
        // First level subfolder - path should be just the main folder
        return {
            mainFolderCid: mainFolderCID,
            mainFolderActualName: mainFolderName,
            subFolderPath: mainFolderName
        };
    } else {
        // Deeper level subfolder - append current folder to existing path
        return {
            mainFolderCid: mainFolderCID,
            mainFolderActualName: mainFolderName,
            subFolderPath: `${existingPath}/${currentFolderName}`
        };
    }
}

/**
 * Gets the full path including all folders in the hierarchy
 * @param mainFolderName - The main/root folder name
 * @param subFolderPath - The subfolder path
 * @returns The full path string
 */
export function getFullPath(
    mainFolderName?: string | null,
    subFolderPath?: string | null
): string {
    if (!mainFolderName) return '';
    if (!subFolderPath || subFolderPath.length === 0) return mainFolderName;
    return subFolderPath; // The subFolderPath already contains the full path
}

/**
 * Parses the full path into an array of folder names
 * @param mainFolderName - The main/root folder name
 * @param subFolderPath - The subfolder path
 * @returns Array of folder names in the path
 */
export function getFolderPathArray(
    mainFolderName?: string | null,
    subFolderPath?: string | null
): string[] {
    const fullPath = getFullPath(mainFolderName, subFolderPath);
    if (!fullPath) return [];
    return fullPath.split('/');
}
