import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";

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
  syncStatus?: "synced" | "pending" | "uploading" | "downloading" | "unknown" | "excluded";
  label?: string;
  fileCount?: number;
};

export interface UserFilesData {
  files: FormattedUserFile[];
  publicStorageSize: bigint;
  privateStorageSize: bigint;
  syncFolderLabels: string[];
}

export const GET_USER_IPFS_FILES_QUERY_KEY = "userIpfsFiles";

interface UserFilesResult {
  files: FormattedUserFile[];
  totalPrivateSize: string;
  syncFolderLabels: string[];
}

export function useUserFiles() {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress], [polkadotAddress]);

  // Refetch file list after sync completes
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
    queryFn: async (): Promise<UserFilesData> => {
      if (!polkadotAddress) {
        throw new Error("Wallet not connected");
      }

      // Single Rust call: fetches from all sync paths, resolves timestamps,
      // detects encrypted names, sorts. No loop or mapping in TypeScript.
      const result = await invoke<UserFilesResult>("get_user_files", {
        accountId: polkadotAddress,
      });

      return {
        files: result.files,
        publicStorageSize: BigInt(0),
        privateStorageSize: BigInt(result.totalPrivateSize || "0"),
        syncFolderLabels: result.syncFolderLabels,
      };
    },
    enabled: !!polkadotAddress,
    refetchOnMount: false,
    retry: 3,
    retryDelay: 1000,
  });
}

export default useUserFiles;
