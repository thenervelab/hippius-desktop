import { useQuery } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";

export const REMOTE_STORAGE_STATS_QUERY_KEY = "remote-storage-stats";

interface RemoteStorageStats {
  total_bytes: number;
  file_count: number;
}

export function useRemoteStorageStats() {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY, polkadotAddress],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("Wallet not connected");
      }

      const stats = await invoke<RemoteStorageStats>(
        "get_remote_storage_stats",
        { accountId: polkadotAddress },
      );

      return {
        totalFiles: stats.file_count,
        totalBytes: stats.total_bytes,
      };
    },
    enabled: !!polkadotAddress,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
