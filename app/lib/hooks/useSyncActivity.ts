/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";
// import { toast } from "sonner";

// Sync Activity types based on useTraySync.ts
export type SyncActivityItem = {
  name: string;
  path: string;
  scope: string;
  action: "uploaded" | "deleted" | "uploading";
  kind: "file" | "folder" | string;
  timestamp?: number;
  file_type?: string;
  fileSizeInBytes: number;
  deleted: boolean;
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
  size: number;
  deleted: boolean;
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
    deleted: boolean;
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
    deleted: boolean;
  }>;
  total_files: number;
  processed_files: number;
  in_progress: boolean;
};

export type SyncActivityData = {
  rows: SyncActivityRow[];
  totalFiles: number;
  processedFiles: number;
  inProgress: boolean;
};

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
    scope: file.type || (file.source?.includes("private") ? "private" : "public"),
    action,
    fileSizeInBytes: file.fileSizeInBytes || 0,
    kind: file.isFolder ? "folder" : "file",
    timestamp: file.createdAt ? file.createdAt * 1000 : Date.now(),
    file_type: file.type || (file.source?.includes("private") ? "private" : "public"),
    deleted: file.deleted || false,
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

    rows.push({
      id,
      rawName,
      fileName,
      scope: item.scope || "",
      status,
      fileType: item.file_type || item.scope,
      size: item.fileSizeInBytes,
      timestamp: item.timestamp,
      rawPath: item.path,
      deleted: item.deleted || false,
    });
  }

  return rows;
}

const useSyncActivity = () => {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["sync-activity", polkadotAddress],
    queryFn: async (): Promise<SyncActivityData> => {
      if (!polkadotAddress) {
        return { rows: [], totalFiles: 0, processedFiles: 0, inProgress: false };
      }

      try {
        const response = await invoke<SyncActivityResponse>(
          "get_sync_activity",
          {
            accountId: polkadotAddress,
          }
        );
        console.log("response 0", response);
        if (
          !response ||
          (!response.recent?.length && !response.uploading?.length)
        ) {
          return { rows: [], totalFiles: 0, processedFiles: 0, inProgress: false };
        }
        console.log("response 1", response);

        // toast.success(`Files: ${JSON.stringify(response)}`, {
        //   action: {
        //     label: "Copy",
        //     onClick: () =>
        //       navigator.clipboard.writeText(JSON.stringify(response, null, 2)),
        //   },
        // });

        const processedFiles = new Map<string, SyncActivityItem>();

        if (response.uploading) {
          for (const file of response.uploading) {
            const key =
              file.fileHash || `${file.fileName}-${file.fileSizeInBytes}`;
            processedFiles.set(key, processFile(file, "uploading"));
          }
        }

        if (response.recent) {
          for (const file of response.recent) {
            const key =
              file.fileHash || `${file.fileName}-${file.fileSizeInBytes}`;
            if (!processedFiles.has(key)) {
              processedFiles.set(key, processFile(file, "uploaded"));
            }
          }
        }

        const activityItems = Array.from(processedFiles.values());
        const rows = normalizeActivityToRows(activityItems);

        // Sort by timestamp (newest first)
        console.log("rows", rows);
        // Sort by timestamp (newest first)
        console.log("rows", rows);
        const sortedRows = rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        return {
          rows: sortedRows,
          totalFiles: response.total_files || 0,
          processedFiles: response.processed_files || 0,
          inProgress: response.in_progress || false
        };
      } catch (error) {
        console.error("Error fetching sync activity:", error);
        return { rows: [], totalFiles: 0, processedFiles: 0, inProgress: false };
      }
    },
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    staleTime: 2000,
    enabled: !!polkadotAddress,
    notifyOnChangeProps: ["data", "dataUpdatedAt"],
  });
};

export default useSyncActivity;
