import { useQuery } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { listRemoteFolders } from "@/lib/utils/restoreUtils";

export const REMOTE_STORAGE_STATS_QUERY_KEY = "remote-storage-stats";

export function useRemoteStorageStats() {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY, polkadotAddress],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("Wallet not connected");
      }

      const folders = await listRemoteFolders(polkadotAddress);

      let totalFiles = 0;
      let totalBytes = 0;
      for (const folder of folders) {
        totalFiles += folder.file_count;
        totalBytes += folder.total_bytes;
      }

      return { totalFiles, totalBytes };
    },
    enabled: !!polkadotAddress,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
