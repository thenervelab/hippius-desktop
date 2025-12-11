import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFilePartsFromFileName } from "./getFilePartsFromFileName";
import { getFileTypeFromExtension } from "./getTileTypeFromExtension";

export type ViewableFileType = "image" | "video" | "PDF";

/**
 * Determines if a file is viewable in a dialog (image, video, or PDF)
 */
export function isViewableFile(file: FormattedUserFile): boolean {
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  return fileType === "image" || fileType === "video" || fileType === "PDF";
}

/**
 * Get file type for navigation purposes
 */
export function getViewableFileType(file: FormattedUserFile): ViewableFileType | null {
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);

  if (fileType === "image" || fileType === "video" || fileType === "PDF") {
    return fileType as ViewableFileType;
  }

  return null;
}

/**
 * Filters all viewable files from the files array
 */
export function getViewableFiles(files: FormattedUserFile[]): FormattedUserFile[] {
  return files.filter(isViewableFile);
}

/**
 * Gets the next viewable file in the sequence
 */
export function getNextViewableFile(
  currentFile: FormattedUserFile,
  allFiles: FormattedUserFile[]
): FormattedUserFile | null {
  const viewableFiles = getViewableFiles(allFiles);
  const currentIndex = viewableFiles.findIndex(file => file.cid === currentFile.cid);

  if (currentIndex === -1 || currentIndex === viewableFiles.length - 1) {
    return null;
  }

  return viewableFiles[currentIndex + 1];
}

/**
 * Gets the previous viewable file in the sequence
 */
export function getPrevViewableFile(
  currentFile: FormattedUserFile,
  allFiles: FormattedUserFile[]
): FormattedUserFile | null {
  const viewableFiles = getViewableFiles(allFiles);
  const currentIndex = viewableFiles.findIndex(file => file.cid === currentFile.cid);

  if (currentIndex <= 0) {
    return null;
  }

  return viewableFiles[currentIndex - 1];
}
