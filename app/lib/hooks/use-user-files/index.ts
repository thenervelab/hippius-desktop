import { useQuery } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";

export type FileDetail = {
  filename: string;
  cid: string;
};

export type FormattedUserFile = {
  name: string;
  actualFileName?: string;
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
  mainReqHash: string;
};

type FileEntry = {
  name: string;
  is_folder: boolean;
  size: number;
  modified: number | null;
};

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

export const useUserFiles = () => {
  const { polkadotAddress } = useWalletAuth();
  const queryKey = [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress];

  return useQuery({
    queryKey,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    staleTime: 5000,
    notifyOnChangeProps: "all",
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("Wallet not connected");
      }

      try {
        const syncPath = await getPrivateSyncPath(polkadotAddress);

        const entries = await invoke<FileEntry[]>("list_sync_folder", {
          syncPath,
          subfolder: null,
        });

        console.log("Fetched file entries from sync folder:", entries);

        const privateStorageSize = entries.reduce(
          (sum, entry) => sum + BigInt(entry.size),
          BigInt(0)
        );

        const formattedFiles: FormattedUserFile[] = entries.map((entry) => {
          const modifiedMs = (entry.modified ?? 0) * 1000;
          return {
            name: entry.name,
            actualFileName: entry.name,
            size: entry.size,
            createdAt: modifiedMs,
            cid: "",
            source: "local",
            minerIds: [],
            isAssigned: true,
            lastChargedAt: modifiedMs,
            fileDetails: [],
            isFolder: entry.is_folder,
            type: "private",
            isErasureCoded: false,
            mainReqHash: "",
          };
        });

        formattedFiles.sort((a, b) => b.lastChargedAt - a.lastChargedAt);

        return {
          files: formattedFiles,
          publicStorageSize: BigInt(0),
          privateStorageSize,
        };
      } catch (error) {
        console.error("Error fetching files from sync folder:", error);
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
        length: data.files.length,
      };
    },
  });
};

export default useUserFiles;
