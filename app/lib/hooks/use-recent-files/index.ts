import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useRef, useEffect } from "react";

// Re-export types for backward compatibility
export type UserProfileFile = {
  fileName: string;
  fileSizeInBytes: number;
  lastChargedAt: number;
  arionHash?: string;
  createdAt: number;
  fileHash: string;
  selectedValidator?: string;
  isAssigned: boolean;
  source: string;
  minerIds: string;
  isFolder: boolean;
  type: string;
  mainReqHash: string;
  deleted: boolean;
};

export type RecentFilesResponse = {
  recent?: UserProfileFile[];
  uploading?: UserProfileFile[];
};

function makeFilesSignature(files: Array<FormattedUserFile>): string {
  return files
    .map(
      (f) =>
        `${f.arionHash}|${f.name}|${f.lastChargedAt}|${f.size}|${f.isFolder ? 1 : 0}|${f.type}|${f.isAssigned ? 1 : 0}`
    )
    .join("||");
}

const useRecentFiles = () => {
  const { polkadotAddress } = useWalletAuth();
  const queryKey = ["recent-files", polkadotAddress];
  const queryClient = useQueryClient();

  const lastSignatureRef = useRef<string>("");
  const lastDataRef = useRef<Array<FormattedUserFile>>([]);

  // Listen for sync file completion events to trigger refetch
  useEffect(() => {
    const handleFilesCompleted = () => {
      queryClient.refetchQueries({ queryKey: ["recent-files"] });
    };

    window.addEventListener("sync_files_completed_changed", handleFilesCompleted);
    return () => {
      window.removeEventListener("sync_files_completed_changed", handleFilesCompleted);
    };
  }, [queryClient]);

  return useQuery({
    queryKey,
    queryFn: async (): Promise<Array<FormattedUserFile>> => {
      if (!polkadotAddress) return [];

      // Single Rust call handles ALL joining, filtering, dedup, and sorting.
      const files = await invoke<FormattedUserFile[]>("get_recent_files", {
        accountId: polkadotAddress,
        limit: 50,
      });

      return files;
    },
    select: (newData) => {
      // Structural stability: return the same reference if data hasn't changed
      const newSignature = makeFilesSignature(newData);
      if (lastSignatureRef.current === newSignature && lastDataRef.current.length > 0) {
        return lastDataRef.current;
      }
      lastSignatureRef.current = newSignature;
      lastDataRef.current = newData;
      return newData;
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
    enabled: !!polkadotAddress,
    notifyOnChangeProps: ["data", "dataUpdatedAt"],
    structuralSharing: false,
  });
};

export default useRecentFiles;
