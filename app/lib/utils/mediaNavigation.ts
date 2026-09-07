import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { derivePreviewType, type PreviewType } from "./filePreviewType";
import { isLocalFile } from "./fileUrlResolver";

/**
 * A file's viewer category. Delegated to the central classifier so the
 * gallery — the thumbnail rail and prev/next — walks exactly the set the
 * unified dialog can open. When the two disagreed, a newly supported format
 * opened fine but was skipped by the arrow keys and missing from the rail.
 */
export type ViewableFileType = PreviewType;

/**
 * Options for filtering viewable files
 */
export interface ViewableFileOptions {
  /** If true, only includes files that are locally synced (have local source) */
  localOnly?: boolean;
}

/**
 * Determines if a file can be opened in the unified viewer.
 * Folders are excluded — they navigate rather than preview.
 */
export function isViewableFile(file: FormattedUserFile, options?: ViewableFileOptions): boolean {
  return getViewableFileType(file, options) !== null;
}

/**
 * Get a file's viewer category, or `null` when nothing can render it.
 */
export function getViewableFileType(
  file: FormattedUserFile,
  options?: ViewableFileOptions,
): ViewableFileType | null {
  if (file.isFolder) {
    return null;
  }

  // For private files (localOnly mode), only show files that are locally synced
  if (options?.localOnly && !isLocalFile(file.source)) {
    return null;
  }

  return derivePreviewType(file.name);
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
 * Uses actualFileName if available, otherwise falls back to arionHash + name combination
 * This handles cases where multiple files might have the same Arion Hash
 */
function getFileIdentifier(file: FormattedUserFile): string {
  // actualFileName is the most reliable unique identifier
  if (file.actualFileName) {
    return file.actualFileName;
  }
  // Fallback: combine arionHash and name for uniqueness
  return `${file.arionHash}:${file.name}`;
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
