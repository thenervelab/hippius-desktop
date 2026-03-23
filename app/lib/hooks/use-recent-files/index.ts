import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  FormattedUserFile,
} from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useRef, useEffect } from "react";
import { SyncActivityItem } from "../useSyncActivity";
import { getAllSyncPaths, SyncPathResult } from "@/lib/utils/syncPathUtils";

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
        `${f.arionHash}|${f.name}|${f.lastChargedAt}|${f.size}|${f.isFolder ? 1 : 0
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
        // Fetch sync paths and activity items in parallel
        const [items, syncPaths] = await Promise.all([
          invoke<SyncActivityItem[]>("get_sync_activity", { limit: 50 }),
          getAllSyncPaths(polkadotAddress).catch((err: unknown) => { console.warn("getAllSyncPaths failed:", err); return [] as SyncPathResult[]; }),
        ]);

        if (!items || items.length === 0) {
          return [];
        }

        // Build label → folder path lookup
        const labelToPath = new Map<string, string>();
        for (const sp of syncPaths) {
          if (sp.path && sp.label) {
            labelToPath.set(sp.label, sp.path);
          }
        }

        // Fetch arion hashes, CIDs, and server timestamps from sync state.
        // Uses get_synced_file_metadata which returns a flat list of ALL
        // synced files (including subfolders) without reading the filesystem.
        const arionHashMap = new Map<string, string>();
        const arionCidMap = new Map<string, string>();
        const uploadedAtMap = new Map<string, number>();
        const updatedAtMap = new Map<string, number>();
        try {
          const metadata = await invoke<{ file_name: string; label: string; arion_hash: string; arion_cid: string; uploaded_at: number; updated_at: number }[]>("get_synced_file_metadata");
          for (const entry of metadata) {
            const key = `${entry.file_name}::${entry.label}`;
            if (entry.arion_hash) {
              arionHashMap.set(key, entry.arion_hash);
            }
            if (entry.arion_cid) {
              arionCidMap.set(key, entry.arion_cid);
            }
            if (entry.uploaded_at) {
              uploadedAtMap.set(key, entry.uploaded_at);
            }
            if (entry.updated_at) {
              updatedAtMap.set(key, entry.updated_at);
            }
          }
        } catch {
          // Ignore - supplementary data
        }

        // Collect names of files that have been deleted — these should
        // not appear in recent files even if an older "uploaded" entry
        // exists. The Rust remove_file command records "deleted" entries
        // in the activity ring buffer when a label is provided.
        const deletedNames = new Set(
          items
            .filter((item) => item.action === "deleted")
            .map((item) => `${item.file_name}::${item.label}`)
        );

        const nonDeletedItems = items.filter(
          (item) =>
            item.action !== "deleted" &&
            !deletedNames.has(`${item.file_name}::${item.label}`)
        );

        if (nonDeletedItems.length === 0) {
          return [];
        }

        // Format SyncActivityItem[] to FormattedUserFile[]
        const formattedFiles = nonDeletedItems.map(
          (item): FormattedUserFile => {
            // Resolve the local file path from the sync folder for this label
            const syncFolderPath = labelToPath.get(item.label);
            const source = syncFolderPath && item.file_name
              ? `${syncFolderPath}/${item.file_name}`
              : "";

            const key = `${item.file_name}::${item.label}`;
            const activityMs = item.timestamp ? item.timestamp * 1000 : Date.now();
            // Prefer server-side upload timestamp over activity timestamp
            const uploadedAtSec = uploadedAtMap.get(key) ?? 0;
            const updatedAtSec = updatedAtMap.get(key) ?? 0;
            // Recent files were already uploaded — use server timestamp,
            // or fall back to activity timestamp if server hasn't returned it yet.
            const createdAtMs = uploadedAtSec ? uploadedAtSec * 1000 : activityMs;
            const lastChargedAtMs = updatedAtSec ? updatedAtSec * 1000 : (uploadedAtSec ? uploadedAtSec * 1000 : activityMs);

            return {
              name: item.file_name || "Unknown",
              actualFileName: item.file_name,
              size: item.size_bytes,
              createdAt: createdAtMs,
              arionHash: arionHashMap.get(key) || "",
              arionCid: arionCidMap.get(key) || "",
              source,
              minerIds: [],
              isAssigned: true,
              lastChargedAt: lastChargedAtMs,
              fileHash: "",
              isFolder: false,
              type: item.action.charAt(0).toUpperCase() + item.action.slice(1),
              isErasureCoded: false,
              mainReqHash: "",
              label: item.label,
            };
          }
        );

        // Remove duplicates based on name
        const uniqueFiles = formattedFiles.filter(
          (file, index, self) =>
            index ===
            self.findIndex(
              (f) => f.name === file.name && f.label === file.label
            )
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
    staleTime: 0, // Always refetch - updates driven by sync_files_completed_changed event
    enabled: !!polkadotAddress,
    notifyOnChangeProps: ["data", "dataUpdatedAt"],
    structuralSharing: false,
  });
};

export default useRecentFiles;
