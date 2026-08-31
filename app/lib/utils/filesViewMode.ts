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
