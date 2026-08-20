import type { QueryClient } from "@tanstack/react-query";
import { GET_USER_IPFS_FILES_QUERY_KEY } from "@/app/lib/hooks/use-user-files";

// Window event fired after an in-app mutation (delete, rename) changes file
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

/**
 * The single invalidation funnel every in-app file mutation must call on
 * success: it wakes BOTH the TanStack-cached lists and the non-cached nested
 * listings.
 *
 * It exists because those two audiences are refreshed by different mechanisms,
 * and hand-rolling the pair per mutation is how they drift: delete refetched
 * the queries but never dispatched the event, so deleting the last entry of a
 * folder left the nested view showing the deleted row. That case can't
 * self-heal on `sync_files_completed_changed` either — a delete with no file
 * content to propagate ends the cycle `NoChanges`, which emits no
 * `SyncCompleted`. Route new mutations through here rather than adding a
 * fourth private copy of the set.
 */
export async function notifyFilesMutated(
  queryClient: QueryClient,
  polkadotAddress: string | null | undefined,
): Promise<void> {
  dispatchFilesMutated();

  await Promise.all([
    queryClient.refetchQueries({
      queryKey: [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
    }),
    queryClient.refetchQueries({
      queryKey: ["recent-files"],
    }),
  ]);
}
