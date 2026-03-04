import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  FormattedUserFile,
} from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useRef, useEffect } from "react";
import { SyncActivityItem } from "../useSyncActivity";

// Re-export types for backward compatibility
export type UserProfileFile = {
  fileName: string;
  fileSizeInBytes: number;
  lastChargedAt: number;
  cid?: string;
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
        `${f.cid}|${f.name}|${f.lastChargedAt}|${f.size}|${f.isFolder ? 1 : 0
        }|${f.type}|${f.isAssigned ? 1 : 0}`
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
      console.log("[useRecentFiles] Files completed, invalidating and refetching query");
      // Use refetch instead of invalidate for immediate data refresh
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
      if (!polkadotAddress) {
        return [];
      }

      try {
        // New API returns SyncActivityItem[] directly
        const items = await invoke<SyncActivityItem[]>(
          "get_sync_activity",
          { limit: 50 }
        );

        if (!items || items.length === 0) {
          return [];
        }

        // Filter out deleted items
        const nonDeletedItems = items.filter((item) => item.action !== "deleted");

        if (nonDeletedItems.length === 0) {
          return [];
        }

        // Format SyncActivityItem[] to FormattedUserFile[]
        const formattedFiles = nonDeletedItems.map(
          (item): FormattedUserFile => {
            return {
              name: item.file_name || "Unknown",
              actualFileName: item.file_name,
              size: item.size_bytes,
              createdAt: item.timestamp ? item.timestamp * 1000 : Date.now(),
              cid: "",
              source: "",
              minerIds: [],
              isAssigned: true,
              lastChargedAt: item.timestamp ? item.timestamp * 1000 : Date.now(),
              fileHash: "",
              isFolder: false,
              type: item.action === "uploaded" ? "Uploaded" : item.action,
              isErasureCoded: false,
              mainReqHash: "",
            };
          }
        );

        // Remove duplicates based on name
        const uniqueFiles = formattedFiles.filter(
          (file, index, self) =>
            index === self.findIndex((f) => f.name === file.name)
        );

        // Sort by timestamp (newest first)
        return uniqueFiles.sort((a, b) => b.lastChargedAt - a.lastChargedAt);
      } catch (error) {
        console.error("Error fetching recent files:", error);
        return [];
      }
    },
    select: (newData) => {
      const newSignature = makeFilesSignature(newData);
      if (
        lastSignatureRef.current === newSignature &&
        lastDataRef.current.length > 0
      ) {
        return lastDataRef.current;
      }
      lastSignatureRef.current = newSignature;
      lastDataRef.current = newData;
      return newData;
    },
    refetchOnWindowFocus: false,
    staleTime: 30000, // 30 seconds - allow periodic refresh
    enabled: !!polkadotAddress,
    notifyOnChangeProps: ["data", "dataUpdatedAt"],
    structuralSharing: false,
  });
};

export default useRecentFiles;
