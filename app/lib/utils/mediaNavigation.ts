import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFilePartsFromFileName } from "./getFilePartsFromFileName";
import { getFileTypeFromExtension } from "./getTileTypeFromExtension";
import { isLocalFile } from "./ipfsUrlResolver";

export type ViewableFileType = "image" | "video" | "PDF";

/**
 * Options for filtering viewable files
 */
export interface ViewableFileOptions {
  /** If true, only includes files that are locally synced (have local source) */
  localOnly?: boolean;
}

/**
 * Determines if a file is viewable in a dialog (image, video, or PDF)
 * Excludes folders as they cannot be previewed in media dialogs
 */
export function isViewableFile(file: FormattedUserFile, options?: ViewableFileOptions): boolean {
  // Folders are not viewable in media dialogs
  if (file.isFolder) {
    return false;
  }

  // For private files (localOnly mode), only show files that are locally synced
  if (options?.localOnly && !isLocalFile(file.source)) {
    return false;
  }

  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  return fileType === "image" || fileType === "video" || fileType === "PDF";
}

/**
 * Get file type for navigation purposes
 */
export function getViewableFileType(file: FormattedUserFile): ViewableFileType | null {
  // Folders don't have a viewable type
  if (file.isFolder) {
    return null;
  }

  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);

  if (fileType === "image" || fileType === "video" || fileType === "PDF") {
    return fileType as ViewableFileType;
  }

  return null;
}

/**
 * Filters all viewable files from the files array (excludes folders)
 * @param options.localOnly - If true, only includes locally synced files (for private folders)
 */
export function getViewableFiles(files: FormattedUserFile[], options?: ViewableFileOptions): FormattedUserFile[] {
  return files.filter(file => isViewableFile(file, options));
}

/**
 * Creates a unique identifier for a file
 * Uses actualFileName if available, otherwise falls back to cid + name combination
 * This handles cases where multiple files might have the same CID
 */
function getFileIdentifier(file: FormattedUserFile): string {
  // actualFileName is the most reliable unique identifier
  if (file.actualFileName) {
    return file.actualFileName;
  }
  // Fallback: combine cid and name for uniqueness
  return `${file.cid}:${file.name}`;
}

/**
 * Finds the index of a file in the array using a reliable identifier
 */
function findFileIndex(files: FormattedUserFile[], targetFile: FormattedUserFile): number {
  const targetId = getFileIdentifier(targetFile);
  return files.findIndex(file => getFileIdentifier(file) === targetId);
}

/**
 * Gets the next viewable file in the sequence
 * Works across all pages, not just the current page
 * @param options.localOnly - If true, only considers locally synced files (for private folders)
 */
export function getNextViewableFile(
  currentFile: FormattedUserFile,
  allFiles: FormattedUserFile[],
  options?: ViewableFileOptions
): FormattedUserFile | null {
  const viewableFiles = getViewableFiles(allFiles, options);
  const currentIndex = findFileIndex(viewableFiles, currentFile);

  if (currentIndex === -1 || currentIndex === viewableFiles.length - 1) {
    return null;
  }

  return viewableFiles[currentIndex + 1];
}

/**
 * Gets the previous viewable file in the sequence
 * Works across all pages, not just the current page
 * @param options.localOnly - If true, only considers locally synced files (for private folders)
 */
export function getPrevViewableFile(
  currentFile: FormattedUserFile,
  allFiles: FormattedUserFile[],
  options?: ViewableFileOptions
): FormattedUserFile | null {
  const viewableFiles = getViewableFiles(allFiles, options);
  const currentIndex = findFileIndex(viewableFiles, currentFile);

  if (currentIndex <= 0) {
    return null;
  }

  return viewableFiles[currentIndex - 1];
}

/**
 * Gets the current position and total count of viewable files
 * Useful for showing "3 of 25" indicators in the UI
 * @param options.localOnly - If true, only counts locally synced files (for private folders)
 */
export function getViewableFilePosition(
  currentFile: FormattedUserFile,
  allFiles: FormattedUserFile[],
  options?: ViewableFileOptions
): { current: number; total: number } | null {
  const viewableFiles = getViewableFiles(allFiles, options);
  const currentIndex = findFileIndex(viewableFiles, currentFile);

  if (currentIndex === -1) {
    return null;
  }

  return {
    current: currentIndex + 1, // 1-based for display
    total: viewableFiles.length,
  };
}
