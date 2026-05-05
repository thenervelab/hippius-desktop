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
 * indexer. Replaces the previous two-IPC pair (`get_files_size` for size,
 * `get_files_count` for count) with one round-trip whose values are
 * guaranteed to be from the same snapshot — the old pair could disagree
 * because each had its own stale-time clock and could land on different
 * rows.
 */
export function useDriveStorageStats() {
  return useInvokeQuery<DriveStorageStats>({
    command: "get_drive_storage_stats",
    queryKey: (addr) => [DRIVE_STORAGE_STATS_QUERY_KEY, addr],
    options: {
      staleTime: 60_000,
    },
  });
}
