/** Search, type/date/size, or the Excluded chip — flatten via recursive search. */
export function filterCriteriaAreActive(opts: {
  searchTerm?: string;
  fileExtension?: string;
  fileExtensions?: string[];
  dateRange?: { from?: string } | null;
  fileSizes?: number[];
  excludedOnly?: boolean;
}): boolean {
  return (
    Boolean(opts.searchTerm?.trim()) ||
    Boolean(opts.fileExtension) ||
    Boolean(opts.fileExtensions && opts.fileExtensions.length > 0) ||
    Boolean(opts.dateRange?.from) ||
    Boolean(opts.fileSizes && opts.fileSizes.length > 0) ||
    Boolean(opts.excludedOnly)
  );
}

/** When the files page should run the recursive disk/server search IPC. */
export function shouldUseRecursiveSearch(opts: {
  hasActiveSearchOrFilter: boolean;
  recursiveSearchLabel: string | null;
  isRecentFiles: boolean;
}): boolean {
  return (
    opts.hasActiveSearchOrFilter &&
    Boolean(opts.recursiveSearchLabel) &&
    !opts.isRecentFiles
  );
}

/** When the in-memory `filter_file_entries` IPC should run. */
export function shouldRunInMemoryFilter(opts: {
  hasActiveSearchOrFilter: boolean;
  recursiveSearchLabel: string | null;
  isRecentFiles: boolean;
}): boolean {
  return !shouldUseRecursiveSearch(opts);
}

/**
 * When the files page should search the SERVER, scoped to one drive.
 *
 * A drive this device does not sync has nothing on local disk, so the
 * recursive search returns nothing and the page falls back to filtering
 * the rows already on screen — which misses every subfolder and reads as
 * broken next to a local drive. The server-side search covers the whole
 * drive instead.
 */
export function shouldUseDriveScopedSearch(opts: {
  hasActiveSearchOrFilter: boolean;
  isRemoteView: boolean;
  remoteLabel: string | null;
  isRecentFiles: boolean;
}): boolean {
  return (
    opts.hasActiveSearchOrFilter &&
    opts.isRemoteView &&
    Boolean(opts.remoteLabel) &&
    !opts.isRecentFiles
  );
}

/**
 * Whether the Drive page is showing a folder rather than a drive's root.
 *
 * Navigation into a folder is a URL, not a route: `/files` gains
 * `folderName` and `subFolderPath`. Both are required, because one without
 * the other is a half-built link that should keep showing the root rather
 * than an empty folder.
 *
 * Shared so the page and `DriveContainer` cannot answer this differently.
 * The page hides the plan card in here, and a second definition of "inside
 * a folder" is how that would start disagreeing with what is on screen.
 */
export function isNestedFolderView(opts: {
  folderName: string | null | undefined;
  subFolderPath: string | null | undefined;
}): boolean {
  return Boolean(opts.folderName && opts.subFolderPath);
}

/**
 * Whether the Drive page is showing its list of folders, rather than the
 * inside of a drive.
 *
 * This is the drive root, and the only view the plan card belongs on.
 *
 * Deliberately not derived from the URL. Opening a synced drive from the
 * folder list is a state change in `DriveContainer`, not a navigation, so
 * `/files` stays `/files` all the way into a drive. A URL-only check reports
 * the folder list while a drive's contents are on screen.
 *
 * - `isOnLocalView` is the folder list itself, and is what a drive click
 *   clears.
 * - `isNested` covers a link opened straight into a subfolder, which arrives
 *   with `isOnLocalView` still at its initial true.
 * - `isRecentFiles` is a different listing on the same container, and is not
 *   the drive root either.
 */
export function isDriveFolderListView(opts: {
  isOnLocalView: boolean;
  isNested: boolean;
  isRecentFiles: boolean;
}): boolean {
  return opts.isOnLocalView && !opts.isNested && !opts.isRecentFiles;
}
