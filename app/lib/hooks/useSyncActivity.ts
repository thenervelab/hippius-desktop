import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { hexToCid } from "@/lib/utils/hexToCid";
import { useState } from "react";
import { parseMinerIds } from "@/lib/hooks/use-user-ipfs-files";

export type BackendActivityItem = {
    name: string;
    path: string;
    scope: string; // "public" | "private" | etc.
    action: "uploaded" | "deleted" | "uploading";
    kind: "file" | "folder" | string;
    size?: number;
    created_at?: string;
    file_hash?: string;
    miner_ids?: string | string[];
};

export type SyncActivityResponse = {
    recent?: BackendActivityItem[];
    uploading?: BackendActivityItem[];
};

export function useSyncActivity() {
    const [manualRefreshTrigger, setManualRefreshTrigger] = useState(0);

    // Manual refresh function for components to call
    const triggerRefresh = () => {
        setManualRefreshTrigger(prev => prev + 1);
    };

    // Use TanStack Query to fetch and cache the data with automatic polling
    const { data, isLoading, error } = useQuery({
        queryKey: ['sync-activity', manualRefreshTrigger],
        queryFn: async () => {
            console.log("Fetching sync activity data...");
            const response = await invoke<SyncActivityResponse>("get_sync_activity");
            console.log("Sync activity data received:", response);
            return response || { recent: [], uploading: [] };
        },
        refetchInterval: 10000, // Refresh every 10 seconds
        staleTime: 5000,
    });

    // Convert backend activity items to the standard FormattedUserIpfsFile format
    const convertToFormattedFiles = (items: BackendActivityItem[] = []): FormattedUserIpfsFile[] => {
        return items.map(item => {
            const isErasureCodedFolder = item.name.endsWith(".folder.ec_metadata");
            const isErasureCoded = !isErasureCodedFolder && item.name.endsWith(".ec_metadata");
            const isFolder = !isErasureCodedFolder && (item.name.endsWith(".folder") || item.kind === "folder");

            let displayName = item.name;
            if (isErasureCodedFolder) {
                displayName = item.name.slice(0, -".folder.ec_metadata".length);
            } else if (isErasureCoded) {
                displayName = item.name.slice(0, -".ec_metadata".length);
            } else if (isFolder && displayName.endsWith(".folder")) {
                displayName = item.name.slice(0, -".folder".length);
            }

            // Generate a CID from file_hash if available, otherwise use a placeholder
            const cid = item.file_hash ? (hexToCid(item.file_hash) || "placeholder-cid") : "placeholder-cid";

            return {
                name: displayName || "Unnamed File",
                actualFileName: item.name,
                size: item.size || 0,
                createdAt: item.created_at ? Number(item.created_at) : Date.now(),
                cid,
                source: item.path || "Unknown",
                minerIds: item.miner_ids ? parseMinerIds(item.miner_ids) : [],
                isAssigned: true, // Assume all sync files are assigned
                lastChargedAt: item.created_at ? Number(item.created_at) : Date.now(),
                isErasureCoded,
                isFolder: isFolder,
                type: item.scope?.toLowerCase() || "unknown", // Use scope as type (private/public)
            };
        });
    };

    // Convert both recent and uploading files
    const formattedRecentFiles = convertToFormattedFiles(data?.recent);
    const formattedUploadingFiles = convertToFormattedFiles(data?.uploading);

    // Combine all files for a complete recent activity view
    const allActivityFiles = [...formattedUploadingFiles, ...formattedRecentFiles];

    // Count files by type for navigation logic
    const fileCountByType = {
        private: allActivityFiles.filter(file => file.type === "private").length,
        public: allActivityFiles.filter(file => file.type === "public").length
    };

    return {
        recentFiles: formattedRecentFiles,
        uploadingFiles: formattedUploadingFiles,
        allActivityFiles,
        fileCountByType,
        isLoading,
        error,
        triggerRefresh
    };
}
