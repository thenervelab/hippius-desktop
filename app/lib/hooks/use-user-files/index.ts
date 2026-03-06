import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { getAllSyncPaths, SyncPathResult } from "@/lib/utils/syncPathUtils";

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
  syncStatus?: "synced" | "pending" | "unknown";
  label?: string;
};

type FileEntry = {
  name: string;
  is_folder: boolean;
  size: number;
  modified: number | null;
  sync_status: "synced" | "pending" | "unknown";
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
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress],
    [polkadotAddress]
  );

  // Refetch file list after sync completes so sync_status updates
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey });
    };
    window.addEventListener("sync_files_completed_changed", handler);
    return () => window.removeEventListener("sync_files_completed_changed", handler);
  }, [queryClient, queryKey]);

  return useQuery({
    queryKey,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    notifyOnChangeProps: "all",
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("Wallet not connected");
      }

      try {
        const syncPaths: SyncPathResult[] = await getAllSyncPaths(polkadotAddress);

        if (syncPaths.length === 0) {
          return {
            files: [],
            publicStorageSize: BigInt(0),
            privateStorageSize: BigInt(0),
            syncFolderLabels: [],
          };
        }

        const allFiles: FormattedUserFile[] = [];
        let totalPrivateSize = BigInt(0);

        for (const { path: syncPath, label } of syncPaths) {
          if (!syncPath) continue;
          try {
            const entries = await invoke<FileEntry[]>("list_sync_folder", {
              syncPath,
              subfolder: null,
              label,
            });

            totalPrivateSize += entries.reduce(
              (sum, entry) => sum + BigInt(entry.size),
              BigInt(0)
            );

            for (const entry of entries) {
              const modifiedMs = (entry.modified ?? 0) * 1000;
              allFiles.push({
                name: entry.name,
                actualFileName: entry.name,
                size: entry.size,
                createdAt: modifiedMs,
                cid: "",
                source: `${syncPath}/${entry.name}`,
                minerIds: [],
                isAssigned: true,
                lastChargedAt: modifiedMs,
                fileDetails: [],
                isFolder: entry.is_folder,
                type: "private",
                isErasureCoded: false,
                mainReqHash: "",
                syncStatus: entry.sync_status,
                label,
              });
            }
          } catch (err) {
            console.warn(`Failed to list files for label "${label}":`, err);
          }
        }

        allFiles.sort((a, b) => b.lastChargedAt - a.lastChargedAt);

        const syncFolderLabels = syncPaths
          .filter((sp) => !!sp.path)
          .map((sp) => sp.label);

        return {
          files: allFiles,
          publicStorageSize: BigInt(0),
          privateStorageSize: totalPrivateSize,
          syncFolderLabels,
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
