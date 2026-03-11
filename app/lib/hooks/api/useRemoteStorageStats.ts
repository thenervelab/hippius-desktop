import { useInvokeQuery } from "./useInvokeQuery";

export const REMOTE_STORAGE_STATS_QUERY_KEY = "remote-storage-stats";

interface RemoteStorageStats {
  total_bytes: number;
  file_count: number;
}

interface FormattedStats {
  totalFiles: number;
  totalBytes: number;
}

export function useRemoteStorageStats() {
  return useInvokeQuery<RemoteStorageStats, FormattedStats>({
    command: "get_remote_storage_stats",
    queryKey: (addr) => [REMOTE_STORAGE_STATS_QUERY_KEY, addr],
    options: {
      staleTime: 60_000,
      select: (stats) => ({
        totalFiles: stats.file_count,
        totalBytes: stats.total_bytes,
      }),
    },
  });
}
