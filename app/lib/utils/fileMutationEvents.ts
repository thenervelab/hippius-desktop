// Window event fired after an in-app mutation (rename today) changes file
// names/paths OUTSIDE the TanStack-cached lists. The nested-folder listings
// (`useNestedFolderListing` in DriveContainer and ExpandedFolderRows) are
// plain useState + invoke, so a query-cache refetch never reaches them —
// they refresh on `sync_files_completed_changed`, which only fires when a
// whole sync cycle ends, seconds after the on-disk change. This event closes
// that gap; it deliberately does NOT reuse the sync-completed event name,
// because no sync has completed.
export const FILES_MUTATED_EVENT = "hippius:files-mutated";

export function dispatchFilesMutated(): void {
  window.dispatchEvent(new CustomEvent(FILES_MUTATED_EVENT));
}
