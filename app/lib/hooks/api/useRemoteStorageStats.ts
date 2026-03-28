import { useInvokeQuery } from "./useInvokeQuery";

export const REMOTE_STORAGE_STATS_QUERY_KEY = "remote-storage-stats";

interface FileSizeEvent {
  total_files_size: string;
}

interface FileSizeResponse {
  data: FileSizeEvent[];
}

interface FormattedStats {
  totalBytes: number;
}

export function useRemoteStorageStats() {
  return useInvokeQuery<FileSizeResponse, FormattedStats>({
    command: "get_files_size",
    queryKey: (addr) => [REMOTE_STORAGE_STATS_QUERY_KEY, addr],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      daysAgo: 1,
    }),
    options: {
      staleTime: 60_000,
      select: (data) => {
        if (!data?.data?.length) return { totalBytes: 0 };
        // Latest entry = current total storage
        const latest = data.data[0];
        return {
          totalBytes: parseInt(latest.total_files_size, 10) || 0,
        };
      },
    },
  });
}
