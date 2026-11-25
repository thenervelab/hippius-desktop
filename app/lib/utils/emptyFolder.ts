/**
 * A folder known to hold no files: its file count is 0, as the server (or the
 * walk of a synced folder) reports for an empty folder. Its size shows as
 * "0 B", as on the web; a size of 0 anywhere else, or a folder whose count
 * is not known, still reads "Unknown".
 */
export function isKnownEmptyFolder(file: {
  isFolder?: boolean;
  fileCount?: number | null;
}): boolean {
  return file.isFolder === true && file.fileCount === 0;
}
