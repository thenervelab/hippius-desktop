import { useQuery } from "@tanstack/react-query";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { hexToCid } from "../../utils/hexToCid";

export type FileDetail = {
    filename: string;
    cid: string;
};

export type FormattedUserIpfsFile = {
    name: string;
    size?: number;
    createdAt: number;
    cid: string;
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
};

// Add new type to include total storage size and length
export type UserIpfsResponse = {
    files: FormattedUserIpfsFile[];
    totalStorageSize: bigint;
    length: number;
};

type UserProfileFile = {
    fileName: string;
    fileSizeInBytes: number;
    lastChargedAt: number;
    cid?: string;
    fileHash: string;
    selectedValidator?: string;
    isAssigned: boolean;
    source: string;
    minerIds: string;
    isFolder: boolean;
    type: string;
};

export const GET_USER_IPFS_FILES_QUERY_KEY = "get-user-ipfs-files";

const parseMinerIds = (minerIds: string | string[]): string[] => {
    // If it's already an array, return it
    if (Array.isArray(minerIds)) {
        return minerIds;
    }

    if (typeof minerIds === 'string') {
        try {
            if (minerIds.trim().startsWith('[') && minerIds.trim().endsWith(']')) {
                return JSON.parse(minerIds);
            }
        } catch (error) {
            console.error("Error parsing minerIds JSON:", error);
        }

        return [minerIds];
    }

    return [];
};

export const useUserIpfsFiles = () => {
    const { api, isConnected } = usePolkadotApi();
    const { polkadotAddress } = useWalletAuth();
    const queryKey = [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress];

    return useQuery({
        queryKey,
        refetchInterval: 1080000,
        refetchIntervalInBackground: true,
        refetchOnWindowFocus: false,
        staleTime: 30000,
        notifyOnChangeProps: 'all',
        queryFn: async () => {
            if (!polkadotAddress) {
                throw new Error("Wallet not connected");
            }

            try {
                // Get total storage size from blockchain (still needed)
                let totalStorageSize = BigInt(0);
                if (api && isConnected) {
                    try {
                        const userTotalStorageResult = await api.query.ipfsPallet.userTotalFilesSize(polkadotAddress);
                        // Check if Option has a value using .isEmpty (for Option<Balance>), otherwise assign directly
                        if (userTotalStorageResult && !userTotalStorageResult.isEmpty) {
                            totalStorageSize = BigInt(userTotalStorageResult.toString());
                        }
                    } catch (error) {
                        console.error("Error fetching total storage size:", error);
                    }
                }

                // Fetch files from local database using updated Tauri command
                const dbFiles = await invoke<UserProfileFile[]>("get_user_synced_files", {
                    owner: polkadotAddress,
                });

                console.log("Fetched files from DB:", dbFiles);

                // Format the data to match what the UI expects
                const formattedFiles = dbFiles.map((file): FormattedUserIpfsFile => ({
                    name: file.fileName || "Unnamed File",
                    size: file.fileSizeInBytes,
                    createdAt: file.lastChargedAt,
                    cid: hexToCid(file.fileHash) ?? "",
                    source: file.source || "Unknown",
                    minerIds: parseMinerIds(file.minerIds),
                    isAssigned: file.isAssigned,
                    lastChargedAt: file.lastChargedAt,
                    fileHash: file.fileHash,
                    fileDetails: [],
                    isFolder: file.isFolder,
                    type: file.type,
                }));


                formattedFiles.sort((a, b) => b.lastChargedAt - a.lastChargedAt);

                return {
                    files: formattedFiles,
                    totalStorageSize
                };
            } catch (error) {
                console.error("Error fetching user files from DB:", error);
                throw new Error("Failed to retrieve your files");
            }
        },
        enabled: !!polkadotAddress,
        refetchOnMount: false,
        retry: 3,
        retryDelay: 1000,
        select: (data) => {
            return {
                ...data,
                length: data.files.length,
            };
        }
    });
};

export default useUserIpfsFiles;
