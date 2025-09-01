import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserIpfsFile, parseMinerIds } from "@/lib/hooks/use-user-ipfs-files";
import { hexToCid } from "@/lib/utils/hexToCid";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useRef } from "react";

// Match the structure from get_user_synced_files
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
};

// Use the same response structure as useUserIpfsFiles
export type RecentFilesResponse = {
    recent?: UserProfileFile[];
    uploading?: UserProfileFile[];
};

// Remove fastHash and implement a compact deterministic signature for the formatted files
function makeFilesSignature(files: Array<FormattedUserIpfsFile>): string {
    // Only include the fields that affect rendering and ordering
    // Sorting by lastChargedAt desc is already applied before this signature
    return files
        .map(
            f =>
                `${f.cid}|${f.name}|${f.lastChargedAt}|${f.size}|${f.isFolder ? 1 : 0}|${f.type}|${f.isAssigned ? 1 : 0}`
        )
        .join("||");
}

const useRecentFiles = () => {
    const { polkadotAddress } = useWalletAuth();
    const queryKey = ["recent-files", polkadotAddress];

    // Track last signature and last data reference to preserve referential equality
    const lastSignatureRef = useRef<string>("");
    const lastDataRef = useRef<Array<FormattedUserIpfsFile>>([]);

    return useQuery({
        queryKey,
        queryFn: async (): Promise<Array<FormattedUserIpfsFile>> => {
            if (!polkadotAddress) {
                console.log("No wallet connected, returning empty recent files array");
                return [];
            }

            try {
                // Use the same invoke pattern as useUserIpfsFiles
                const response = await invoke<RecentFilesResponse>("get_sync_activity", {
                    accountId: polkadotAddress
                });

                // console.log("Recent files from get_sync_activity:", response);

                // Combine recent and uploading items (if any)
                const combinedFiles = [
                    ...(response.recent || [])
                ];

                if (combinedFiles.length === 0) {
                    return [];
                }

                // Format the data exactly like useUserIpfsFiles does
                const formattedFiles = combinedFiles.map((file): FormattedUserIpfsFile => {
                    const isErasureCodedFolder = file.fileName?.endsWith(".folder.ec_metadata");
                    const isErasureCoded = !isErasureCodedFolder && file.fileName?.endsWith(".ec_metadata");
                    const isFolder = !isErasureCodedFolder && (file.isFolder || file.fileName?.endsWith(".folder"));

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
                        actualFileName: file.fileName,
                        size: file.fileSizeInBytes,
                        createdAt: file.createdAt || Date.now(),
                        cid: hexToCid(file.fileHash) ?? "",
                        source: file.source || "Unknown",
                        minerIds: parseMinerIds(file.minerIds || "[]"),
                        isAssigned: file.isAssigned !== undefined ? file.isAssigned : true,
                        lastChargedAt: file.lastChargedAt || file.createdAt || Date.now(),
                        fileHash: file.fileHash,
                        isFolder: isFolder || file.isFolder || false,
                        type: file.type || (file.source === "private" ? "Private" : "Public"),
                        isErasureCoded: isErasureCoded || false
                    };
                });

                // Sort by timestamp (newest first) - same as useUserIpfsFiles
                return formattedFiles.sort((a, b) => b.lastChargedAt - a.lastChargedAt);
            } catch (error) {
                console.error("Error fetching recent files:", error);
                return [];
            }
        },
        // Preserve referential equality when no meaningful changes occur
        select: (newData) => {
            const newSignature = makeFilesSignature(newData);
            if (lastSignatureRef.current === newSignature && lastDataRef.current.length > 0) {
                // Data identical; reuse previous array reference
                return lastDataRef.current;
            }
            // Data changed; update signature and reference
            lastSignatureRef.current = newSignature;
            lastDataRef.current = newData;
            return newData;
        },
        // Poll frequently, but only notify components when data actually changes
        refetchInterval: 10000,
        refetchOnWindowFocus: true,
        staleTime: 5000,
        enabled: !!polkadotAddress,
        // Only notify on data changes to avoid re-renders from isFetching toggles
        notifyOnChangeProps: ["data", "dataUpdatedAt"],
        // We are returning the previous array reference manually when unchanged
        structuralSharing: false
    });
};

export default useRecentFiles;
