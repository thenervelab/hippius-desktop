import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { getFilePartsFromFileName } from "./getFilePartsFromFileName";
import { getFileTypeFromExtension } from "./getTileTypeFromExtension";

export type ViewableFileType = "image" | "video" | "pdfDocument";

/**
 * Determines if a file is viewable in a dialog (image, video, or PDF)
 */
export function isViewableFile(file: FormattedUserIpfsFile): boolean {
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  return fileType === "image" || fileType === "video" || fileType === "pdfDocument";
}

/**
 * Get file type for navigation purposes
 */
export function getViewableFileType(file: FormattedUserIpfsFile): ViewableFileType | null {
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);

  if (fileType === "image" || fileType === "video" || fileType === "pdfDocument") {
    return fileType as ViewableFileType;
  }

  return null;
}

/**
 * Filters all viewable files from the files array
 */
export function getViewableFiles(files: FormattedUserIpfsFile[]): FormattedUserIpfsFile[] {
  return files.filter(isViewableFile);
}

/**
 * Gets the next viewable file in the sequence
 */
export function getNextViewableFile(
  currentFile: FormattedUserIpfsFile,
  allFiles: FormattedUserIpfsFile[]
): FormattedUserIpfsFile | null {
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
  currentFile: FormattedUserIpfsFile,
  allFiles: FormattedUserIpfsFile[]
): FormattedUserIpfsFile | null {
  const viewableFiles = getViewableFiles(allFiles);
  const currentIndex = viewableFiles.findIndex(file => file.cid === currentFile.cid);

  if (currentIndex <= 0) {
    return null;
  }

  return viewableFiles[currentIndex - 1];
}
