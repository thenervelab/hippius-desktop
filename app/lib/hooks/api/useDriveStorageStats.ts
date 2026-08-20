import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
import { useInvokeQuery } from "./useInvokeQuery";

/**
 * TanStack Query key for the drive-scoped storage header card.
 *
 * Exported so any flow that mutates drive contents (uploads, deletes,
 * sync events) can invalidate the header without re-importing the hook.
 */
export const DRIVE_STORAGE_STATS_QUERY_KEY = "drive-storage-stats";

/** Shape returned by the Rust `get_drive_storage_stats` IPC. Both fields camelCased. */
interface DriveStorageStats {
  totalBytes: number;
  fileCount: number;
}

/**
 * Latest drive-only storage totals (size + count) for the current account.
 *
 * Backed by `/user-extended-storage-metrics?storage=drive&limit=1` on the
 * indexer. Replaces a previous two-IPC pair (one for size, one for
 * count) with one round-trip whose values are guaranteed to be from
 * the same snapshot — the old pair could disagree because each had
 * its own stale-time clock and could land on different rows.
 */
export function useDriveStorageStats() {
  return useInvokeQuery<DriveStorageStats>({
    command: "get_drive_storage_stats",
    queryKey: (addr) => [DRIVE_STORAGE_STATS_QUERY_KEY, addr],
    options: {
      // The indexer ingests new shards asynchronously and can run hours
      // behind the chain when load spikes (observed 26h on 2026-05-06).
      // We can't fix the lag, but the tile must never be the bottleneck
      // once the indexer catches up: staleTime matches the poll so a
      // remount inside the interval does not refetch, focus refetch
      // for the desktop-resume case, and a block-cadence poll so an
      // idle home page shows new totals within one interval of the
      // indexer catching up.
      staleTime: LIVE_DATA_REFRESH_MS,
      refetchOnWindowFocus: true,
      refetchInterval: LIVE_DATA_REFRESH_MS,
    },
  });
}
