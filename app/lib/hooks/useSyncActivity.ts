"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

// Sync Activity types based on useTraySync.ts
export type SyncActivityItem = {
  name: string;
  path: string;
  scope: string;
  action: "uploaded" | "deleted" | "uploading";
  kind: "file" | "folder" | string;
  timestamp?: number;
  file_type?: string;
};

export type SyncActivityRow = {
  id: string;
  fileName: string;
  rawName: string;
  scope: string;
  status: "uploading" | "uploaded" | "deleted";
  fileType: string;
  timestamp?: number;
  rawPath?: string;
};

// Response from get_sync_activity
export type SyncActivityResponse = {
  recent?: Array<{
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
  }>;
  uploading?: Array<{
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
  }>;
};

// Helper functions (from useTraySync.ts)
function hashId(item: SyncActivityItem): string {
  return `${item.action}:${item.path || item.name}`;
}

function shortenName(name: string): string {
  if (!name) return name;
  if (name.length <= 30) return name;
  const head = name.slice(0, 15);
  const tail = name.slice(-12);
  return `${head}…${tail}`;
}

function getFileType(path: string, kind?: string): string {
  if (kind === "folder") return "folder";
  const ext = path.split(".").pop()?.toLowerCase();
  return ext && ext !== path ? ext : kind || "file";
}

function processFile(
  file: any,
  action: "uploading" | "uploaded" | "deleted"
): SyncActivityItem {
  const isErasureCodedFolder = file.fileName?.endsWith(".folder.ec_metadata");
  const isErasureCoded =
    !isErasureCodedFolder && file.fileName?.endsWith(".ec_metadata");
  const isFolder =
    !isErasureCodedFolder &&
    (file.isFolder || file.fileName?.endsWith(".folder"));

  let displayName = file.fileName;
  if (isErasureCodedFolder) {
    displayName = file.fileName.slice(0, -".folder.ec_metadata".length);
  } else if (isErasureCoded) {
    displayName = file.fileName.slice(0, -".ec_metadata".length);
  } else if (isFolder && displayName?.endsWith(".folder")) {
    displayName = file.fileName.slice(0, -".folder".length);
  }

  return {
    name: displayName || "Unnamed File",
    path: file.source || "",
    scope: file.source || "",
    action,
    kind: file.isFolder ? "folder" : "file",
    timestamp: file.createdAt || Date.now(),
    file_type: file.type || (file.source === "private" ? "Private" : "Public"),
  };
}

function normalizeActivityToRows(items: SyncActivityItem[]): SyncActivityRow[] {
  const rows: SyncActivityRow[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const status: "uploading" | "uploaded" | "deleted" =
      item.action === "uploading"
        ? "uploading"
        : item.action === "deleted"
        ? "deleted"
        : "uploaded";

    const id = hashId(item);
    if (seen.has(id)) continue;
    seen.add(id);

    const rawName = item.name || "Unknown";
    const fileName = shortenName(rawName);
    const fileType = getFileType(
      item.file_type || item.path || item.name,
      item.kind
    );

    rows.push({
      id,
      rawName,
      fileName,
      scope: item.scope || "",
      status,
      fileType,
      timestamp: item.timestamp,
      rawPath: item.path,
    });
  }

  return rows;
}

const useSyncActivity = () => {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["sync-activity", polkadotAddress],
    queryFn: async (): Promise<SyncActivityRow[]> => {
      if (!polkadotAddress) {
        return [];
      }

      try {
        const response = await invoke<SyncActivityResponse>(
          "get_sync_activity",
          {
            accountId: polkadotAddress,
          }
        );

        if (
          !response ||
          (!response.recent?.length && !response.uploading?.length)
        ) {
          return [];
        }

        // Track processed files with a Map using fileHash as key to avoid duplicates
        const processedFiles = new Map<string, SyncActivityItem>();

        // Process uploading files first (priority)
        if (response.uploading) {
          for (const file of response.uploading) {
            const key =
              file.fileHash || `${file.fileName}-${file.fileSizeInBytes}`;
            processedFiles.set(key, processFile(file, "uploading"));
          }
        }

        // Process recent files, skipping any duplicates
        if (response.recent) {
          for (const file of response.recent) {
            const key =
              file.fileHash || `${file.fileName}-${file.fileSizeInBytes}`;
            if (!processedFiles.has(key)) {
              processedFiles.set(key, processFile(file, "uploaded"));
            }
          }
        }

        // Convert Map to array
        const activityItems = Array.from(processedFiles.values());
        const rows = normalizeActivityToRows(activityItems);

        // Sort by timestamp (newest first)
        return rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      } catch (error) {
        console.error("Error fetching sync activity:", error);
        return [];
      }
    },
    refetchInterval: 3000, // Match the tray sync interval
    refetchOnWindowFocus: true,
    staleTime: 2000,
    enabled: !!polkadotAddress,
    notifyOnChangeProps: ["data", "dataUpdatedAt"],
  });
};

export default useSyncActivity;
