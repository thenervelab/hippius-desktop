"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

// Matches the Rust SyncActivityRow from sync_status.rs
export type SyncActivityRow = {
  id: string;
  file_name: string;
  raw_name: string;
  status: "pending" | "uploading" | "uploaded" | "deleted" | "failed";
  size: number;
  timestamp?: number;
  deleted: boolean;
};

// Keep for backwards compatibility with components that import this type
export type SyncActivityItem = {
  file_name: string;
  action: string;
  timestamp: number;
  size_bytes: number;
  label: string;
};

const useSyncActivity = () => {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["sync-activity", polkadotAddress],
    queryFn: async (): Promise<SyncActivityRow[]> => {
      if (!polkadotAddress) {
        return [];
      }

      try {
        return await invoke<SyncActivityRow[]>(
          "get_sync_activity_rows",
          { limit: 50 }
        );
      } catch (error) {
        console.error("Error fetching sync activity:", error);
        return [];
      }
    },
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    staleTime: 15000,
    enabled: !!polkadotAddress,
    notifyOnChangeProps: ["data", "dataUpdatedAt"],
  });
};

export default useSyncActivity;
