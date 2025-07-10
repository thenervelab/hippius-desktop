import { useQuery } from "@tanstack/react-query";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { hexToAsciiString } from "@/lib/utils/hexToAsciiString";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { invoke } from "@tauri-apps/api/core";

export type FileDetail = {
    filename: string;
    cid: string;
};

export type FormattedUserIpfsFile = {
    name: string;
    size?: number;
    createdAt: number;
    cid: string;
    minerIds: string[];
    isAssigned: boolean;
    lastChargedAt: number;
    tempData?: {
        uploadTime: number;
    };
    deleted?: boolean;
    fileHash?: string | number[] | Uint8Array;
    fileDetails?: FileDetail[];
};

// Add new type for database results
type DbUserFile = {
    id: number;
    owner: string;
    cid: string;
    file_hash: string;
    file_name: string;
    file_size_in_bytes: number;
    is_assigned: boolean;
    last_charged_at: number;
    created_at: number;
    main_req_hash: string;
    selected_validator: string;
    total_replicas: number;
    profile_cid: string;
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
};

export const GET_USER_IPFS_FILES_QUERY_KEY = "get-user-ipfs-files";

export const useUserIpfsFiles = () => {
    const { api, isConnected } = usePolkadotApi();
    const { polkadotAddress } = useWalletAuth();
    const queryKey = [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress];

    return useQuery({
        queryKey,
        refetchInterval: 180000,
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
                        if (userTotalStorageResult.isSome) {
                            totalStorageSize = userTotalStorageResult.unwrap().toBigInt();
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
                    cid: file.cid || file.fileHash,
                    minerIds: file.selectedValidator ? [file.selectedValidator] : [],
                    isAssigned: file.isAssigned,
                    lastChargedAt: file.lastChargedAt,
                    fileHash: file.fileHash,
                    fileDetails: []
                }));

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
