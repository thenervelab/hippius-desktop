import { useQuery } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { hexToCid } from "../../utils/hexToCid";

export type FileDetail = {
  filename: string;
  cid: string;
};

export type FormattedUserIpfsFile = {
  name: string;
  size?: number;
  createdAt: number;
  cid: string;
  minerIds: string | string[];
  isAssigned: boolean;
  lastChargedAt: number;
  tempData?: {
    uploadTime: number;
  };
  deleted?: boolean;
  fileHash?: string | number[] | Uint8Array;
  fileDetails?: FileDetail[];
  source?: string;
  isFolder?: boolean;
  type?: string;
  isErasureCoded: boolean;
  parentFolderId?: string;
  parentFolderName?: string;
};

// Updated to include file size breakdown
export type UserIpfsResponse = {
  files: FormattedUserIpfsFile[];
  publicStorageSize: bigint;
  privateStorageSize: bigint;
  totalStorageSize: bigint;
  length: number;
};

type UserProfileFile = {
  fileName: string;
  fileSizeInBytes: number;
  lastChargedAt: number;
  cid?: string;
  fileHash: string;
  selectedValidator?: string;
  isAssigned: boolean;
  source: string;
  minerIds: string;
  isFolder: boolean;
  type: string;
};

interface FileSizeBreakdown {
  publicSize: number;
  privateSize: number;
}

export const GET_USER_IPFS_FILES_QUERY_KEY = "get-user-ipfs-files";

export const parseMinerIds = (minerIds: string | string[]): string[] => {
  // If it's already an array, return it
  if (Array.isArray(minerIds)) {
    return minerIds;
  }

  if (typeof minerIds === "string") {
    try {
      if (minerIds.trim().startsWith("[") && minerIds.trim().endsWith("]")) {
        return JSON.parse(minerIds);
      }
    } catch (error) {
      console.error("Error parsing minerIds JSON:", error);
    }

    return [minerIds];
  }

  return [];
};

export const useUserIpfsFiles = () => {
  const { polkadotAddress } = useWalletAuth();
  const queryKey = [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress];

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
        let publicStorageSize = BigInt(0);
        let privateStorageSize = BigInt(0);

        try {
          const sizeBreakdown = await invoke<FileSizeBreakdown>(
            "get_user_total_file_size",
            {
              owner: polkadotAddress
            }
          );

          publicStorageSize = BigInt(sizeBreakdown.publicSize);
          privateStorageSize = BigInt(sizeBreakdown.privateSize);
        } catch (error) {
          console.error(
            "Error fetching storage size breakdown from DB:",
            error
          );
        }

        // Fetch files from local database
        const dbFiles = await invoke<UserProfileFile[]>(
          "get_user_synced_files",
          {
            owner: polkadotAddress
          }
        );

        console.log("Fetched files from DB:", dbFiles);

        // Format the data to match what the UI expects
        const formattedFiles = dbFiles.map(
          (file): FormattedUserIpfsFile & { isErasureCoded: boolean } => {
            const isErasureCoded = file.fileName.endsWith(".ec_metadata");
            const displayName = isErasureCoded
              ? file.fileName.slice(0, -".ec_metadata".length)
              : file.fileName;
            return {
              name: displayName || "Unnamed File",
              size: file.fileSizeInBytes,
              createdAt: file.lastChargedAt,
              cid: hexToCid(file.fileHash) ?? "",
              source: file.source || "Unknown",
              minerIds: parseMinerIds(file.minerIds),
              isAssigned: file.isAssigned,
              lastChargedAt: file.lastChargedAt,
              fileHash: file.fileHash,
              fileDetails: [],
              isFolder: file.isFolder,
              type: file.type,
              isErasureCoded
            };
          }
        );

        formattedFiles.sort((a, b) => b.lastChargedAt - a.lastChargedAt);

        return {
          files: formattedFiles,
          publicStorageSize,
          privateStorageSize
        };
      } catch (error) {
        console.error("Error fetching user files from DB:", error);
        throw new Error("Failed to retrieve your files");
      }
    },
    enabled: !!polkadotAddress,
    refetchOnMount: false,
    retry: 3,
    retryDelay: 1000,
    select: (data) => {
      return {
        ...data,
        length: data.files.length
      };
    }
  });
};

export default useUserIpfsFiles;
