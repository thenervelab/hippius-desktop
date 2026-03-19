import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { getAllSyncPaths, SyncPathResult } from "@/lib/utils/syncPathUtils";
/**
 * Check if a filename looks like an encrypted file ID from the server.
 * Local synchronous implementation (the service version is now async via invoke).
 */
function isEncryptedFileId(fileName: string): boolean {
  if (/^file_[a-f0-9]+$/i.test(fileName)) return true;
  if (/^[a-f0-9]{20,}$/i.test(fileName)) return true;
  if (/^[a-f0-9]{8,}$/i.test(fileName) && fileName.length >= 16 && !fileName.includes('.')) return true;
  return false;
}

export type FileDetail = {
  filename: string;
  arionHash: string;
};

export type FormattedUserFile = {
  name: string;
  actualFileName?: string;
  size?: number;
  createdAt: number;
  arionHash: string;
  arionCid: string;
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
  fileCount?: number;
};

type FileEntry = {
  name: string;
  is_folder: boolean;
  size: number;
  modified: number | null;
  sync_status: "synced" | "pending" | "unknown";
  arion_hash: string;
  arion_cid: string;
  file_count: number;
  /** Server-side timestamp: when the file was first uploaded (Unix seconds, 0 if unknown) */
  uploaded_at: number;
  /** Server-side timestamp: when the file was last updated (Unix seconds, 0 if unknown) */
  updated_at: number;
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
      queryClient.refetchQueries({ queryKey });
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

            console.log(`[useUserFiles] Raw entries from list_sync_folder (label: "${label}", path: "${syncPath}"):`, JSON.stringify(entries.slice(0, 5), null, 2));

            totalPrivateSize += entries.reduce(
              (sum, entry) => sum + BigInt(entry.size),
              BigInt(0)
            );

            for (const entry of entries) {
              const localModifiedMs = (entry.modified ?? 0) * 1000;
              // Prefer server-side upload timestamp over local modified time
              const uploadedAtMs = entry.uploaded_at ? entry.uploaded_at * 1000 : 0;
              const updatedAtMs = entry.updated_at ? entry.updated_at * 1000 : 0;
              // Use server timestamp when available. For synced files where
              // the server hasn't returned a timestamp yet, fall back to local
              // modified time. Pending (not-yet-uploaded) files show "—" (0).
              const isSynced = entry.sync_status === "synced";
              const createdAtMs = uploadedAtMs || (isSynced ? localModifiedMs : 0);
              const lastChargedAtMs = updatedAtMs || uploadedAtMs || localModifiedMs;

              // Check if this is an encrypted file name and provide friendly display name
              const displayName = isEncryptedFileId(entry.name)
                ? "Encrypted file"
                : entry.name;

              allFiles.push({
                name: displayName,
                actualFileName: entry.name, // Keep original name for backend operations
                size: entry.size,
                createdAt: createdAtMs,
                arionHash: entry.arion_hash || "",
                arionCid: entry.arion_cid || "",
                source: `${syncPath}/${entry.name}`,
                minerIds: [],
                isAssigned: true,
                lastChargedAt: lastChargedAtMs,
                fileDetails: [],
                isFolder: entry.is_folder,
                type: "private",
                isErasureCoded: false,
                mainReqHash: "",
                syncStatus: entry.sync_status,
                label,
                fileCount: entry.is_folder ? entry.file_count : undefined,
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
