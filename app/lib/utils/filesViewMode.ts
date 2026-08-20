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
