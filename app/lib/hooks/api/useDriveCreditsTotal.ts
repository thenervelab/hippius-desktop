import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
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
 * card and Credit Usage chart are guaranteed to agree on scope when
 * `DRIVE_SCOPED_CREDITS_ENABLED` is on.
 *
 * Pass `{ enabled: false }` to suppress the IPC entirely — the home
 * page does this while the gate is off so the only credit fetch in
 * flight is the wallet-wide marketplace one feeding both chart and
 * tile.
 */
export function useDriveCreditsTotal(options?: { enabled?: boolean }) {
  return useInvokeQuery<number>({
    command: "get_drive_credits_total",
    queryKey: (addr) => [DRIVE_CREDITS_TOTAL_QUERY_KEY, addr],
    options: {
      // Credits are consumed on-chain every block; staleTime 0 + a
      // block-cadence poll keeps the "Total Credit Used" tile in step
      // with the storage tile so the home page never shows a stale
      // total next to a fresh size.
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchInterval: LIVE_DATA_REFRESH_MS,
      enabled: options?.enabled ?? true,
    },
  });
}
