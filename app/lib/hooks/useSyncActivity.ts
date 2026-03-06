/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

// Matches the Rust SyncActivityItem from sync_shared.rs
export type SyncActivityItem = {
  file_name: string;
  action: string; // "uploaded", "downloaded", "deleted", "conflict"
  timestamp: number;
  size_bytes: number;
  label: string;
};

export type SyncActivityRow = {
  id: string;
  fileName: string;
  rawName: string;
  scope: string;
  status: "uploading" | "uploaded" | "deleted" | "failed";
  fileType: string;
  timestamp?: number;
  rawPath?: string;
  size: number;
  deleted: boolean;
  error?: string; // Error message for failed files
};

function hashId(item: SyncActivityItem): string {
  return `${item.action}:${item.file_name}`;
}

function shortenName(name: string): string {
  if (!name) return name;
  if (name.length <= 30) return name;
  const head = name.slice(0, 15);
  const tail = name.slice(-12);
  return `${head}…${tail}`;
}

function normalizeActivityToRows(items: SyncActivityItem[]): SyncActivityRow[] {
  const rows: SyncActivityRow[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const status: "uploading" | "uploaded" | "deleted" =
      item.action === "deleted"
        ? "deleted"
        : item.action === "uploading"
          ? "uploading"
          : "uploaded";

    const id = hashId(item);
    if (seen.has(id)) continue;
    seen.add(id);

    const rawName = item.file_name || "Unknown";
    const fileName = shortenName(rawName);

    rows.push({
      id,
      rawName,
      fileName,
      scope: "",
      status,
      fileType: "file",
      size: item.size_bytes,
      timestamp: item.timestamp,
      rawPath: undefined,
      deleted: item.action === "deleted",
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
        const response = await invoke<SyncActivityItem[]>(
          "get_sync_activity",
          { limit: 50 }
        );

        if (!response || response.length === 0) {
          return [];
        }

        const rows = normalizeActivityToRows(response);

        // Sort by timestamp (newest first)
        return rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      } catch (error) {
        console.error("Error fetching sync activity:", error);
        return [];
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
