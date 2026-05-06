import { useInvokeQuery } from "./useInvokeQuery";

/**
 * TanStack Query key for the drive-only "Total Credit Used" tile.
 *
 * Exported so any flow that knows about a fresh charge (sync events,
 * subscription renewals) can invalidate the tile without re-importing
 * the hook.
 */
export const DRIVE_CREDITS_TOTAL_QUERY_KEY = "drive-credits-total";

/**
 * All-time drive credit usage for the current account, in HIP.
 *
 * Backed by `/user-credits-by-storage-history?storage_type=drive` on
 * the indexer (filtered to `CreditsConsumed` rows server-side via
 * `get_drive_credits_total`). The same endpoint feeds
 * `get_drive_credits_chart`, so the home page's "Total Credit Used"
 * card and Credit Usage chart are guaranteed to agree on scope.
 */
export function useDriveCreditsTotal() {
  return useInvokeQuery<number>({
    command: "get_drive_credits_total",
    queryKey: (addr) => [DRIVE_CREDITS_TOTAL_QUERY_KEY, addr],
    options: {
      staleTime: 60_000,
    },
  });
}
