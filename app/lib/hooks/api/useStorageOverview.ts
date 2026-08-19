import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
import { useInvokeQuery } from "./useInvokeQuery";

/**
 * TanStack Query key for the home page's simple storage card, exported so
 * sync flows can invalidate it alongside `DRIVE_STORAGE_STATS_QUERY_KEY`
 * when uploads/deletes change the stored total.
 */
export const STORAGE_OVERVIEW_QUERY_KEY = "storage-overview";

/** Shape returned by the Rust `get_storage_overview` IPC (camelCase). */
export interface StorageOverview {
  usedBytes: number;
  /** Plan allowance in bytes; 0 when there is no active plan. */
  totalBytes: number;
  /** used/total * 100, clamped to [0, 100] in Rust; 0 when no plan. */
  percent: number;
  hasPlan: boolean;
  planName: string | null;
}

/**
 * Plan-aware storage overview: bytes used vs the subscription plan's
 * allowance, composed in one Rust round-trip (`billing/storage_overview.rs`).
 * Capacity is subscription-only by design — no credits-derived fallback.
 *
 * Polling mirrors `useDriveStorageStats`: the indexer ingests asynchronously,
 * so a block-cadence refetch keeps the card converging without ever being
 * the bottleneck once the indexer catches up.
 */
export function useStorageOverview() {
  return useInvokeQuery<StorageOverview>({
    command: "get_storage_overview",
    queryKey: (addr) => [STORAGE_OVERVIEW_QUERY_KEY, addr],
    options: {
      staleTime: LIVE_DATA_REFRESH_MS,
      refetchOnWindowFocus: true,
      refetchInterval: LIVE_DATA_REFRESH_MS,
    },
  });
}
