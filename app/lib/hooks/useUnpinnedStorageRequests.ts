import { useQuery } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { hexToCid } from "@/lib/utils/hexToCid";
import { UserProfileFile } from "./use-user-ipfs-files";
import { FileDetail } from "@/app/(pages)/UnpinFilesDialog";

export const useUnpinnedStorageRequests = () => {
  const { polkadotAddress } = useWalletAuth();
  const queryKey = ["pinning-files", polkadotAddress];

  return useQuery({
    queryKey,
    refetchInterval: 1080000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    staleTime: 30000,
    notifyOnChangeProps: "all",
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("Wallet not connected");
      }

      try {
        // Fetch files from local database
        const dbFiles = await invoke<UserProfileFile[]>(
          "get_user_synced_files",
          {
            owner: polkadotAddress,
          }
        );

        const unassignedRequests = dbFiles.filter((req) => !req.isAssigned);

        // Format the data to match what the UI expects
        const formattedFiles = unassignedRequests.map(
          (
            file
          ): FileDetail & {
            createdAt: number;
            lastChargedAt: number;
          } => {
            const isErasureCodedFolder = file.fileName.endsWith(
              ".folder.ec_metadata"
            );
            const isErasureCoded =
              !isErasureCodedFolder && file.fileName.endsWith(".ec_metadata");
            const isFolder =
              !isErasureCodedFolder && file.fileName.endsWith(".folder");

            let displayName = file.fileName;
            if (isErasureCodedFolder) {
              displayName = file.fileName.slice(
                0,
                -".folder.ec_metadata".length
              );
            } else if (isErasureCoded) {
              displayName = file.fileName.slice(0, -".ec_metadata".length);
            } else if (isFolder) {
              displayName = file.fileName.slice(0, -".folder".length);
            }

            return {
              filename: displayName || "Unnamed File",
              createdAt: file.createdAt,
              cid: hexToCid(file.fileHash) ?? "",
              lastChargedAt: file.lastChargedAt,
              type: file.type,
            };
          }
        );

        formattedFiles.sort((a, b) => b.lastChargedAt - a.lastChargedAt);

        return [...formattedFiles];
      } catch (error) {
        console.error("Error fetching user files from DB:", error);
        throw new Error("Failed to retrieve your files");
      }
    },
    enabled: !!polkadotAddress,
    refetchOnMount: false,
    retry: 3,
    retryDelay: 1000,
  });
};

export default useUnpinnedStorageRequests;
