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

export interface LabelStats {
  totalBytes: number;
  fileCount: number;
}

export interface UserFilesData {
  files: FormattedUserFile[];
  publicStorageSize: bigint;
  privateStorageSize: bigint;
  syncFolderLabels: string[];
  labelStats: Record<string, LabelStats>;
}

export const GET_USER_IPFS_FILES_QUERY_KEY = "userIpfsFiles";

interface UserFilesResult {
  files: FormattedUserFile[];
  totalPrivateSize: string;
  syncFolderLabels: string[];
  labelStats: Record<string, LabelStats>;
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
      //
      // A 15s wall-clock cap guards against the files page spinning
      // forever when a downstream call inside `get_user_files` stalls
      // (e.g. `tokio::fs::read_dir` on a path the app has lost
      // permission for, or a drive registry lock held by a sync loop
      // that is itself wedged). TanStack Query's `retry: 3` below
      // retries on timeout, and the FE surfaces `error` via the files
      // container when all retries are exhausted — instead of the
      // indefinite spinner the bug report surfaced.
      //
      // The timer is cleared in `finally` so the happy path doesn't
      // keep a 15s timer alive (and its closure) per fetch — TanStack
      // Query refetches keep arriving on events, so the leak would
      // accumulate noticeably.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("get_user_files timed out")), 15_000);
      });
      let result: UserFilesResult;
      try {
        result = await Promise.race([
          invoke<UserFilesResult>("get_user_files", { accountId: polkadotAddress }),
          timeout,
        ]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }

      return {
        files: result.files,
        publicStorageSize: BigInt(0),
        privateStorageSize: BigInt(result.totalPrivateSize || "0"),
        syncFolderLabels: result.syncFolderLabels,
        labelStats: result.labelStats ?? {},
      };
    },
    enabled: !!polkadotAddress,
    refetchOnMount: false,
    retry: 3,
    retryDelay: 1000,
  });
}

export default useUserFiles;
