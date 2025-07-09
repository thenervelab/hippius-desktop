import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { getFileNameFromBytes } from "@/lib/utils/getFileNameFromBytes";
import { IpfsUserFileCollectionDataResponse } from "@/lib/types/ipfsUserFileCollectionData";
import { hexToAsciiString } from "@/lib/utils/hexToAsciiString";
import { hexToCid } from "@/lib/utils/hexToCid";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";

export type FileDetail = {
    filename: string;
    cid: string;
};

type StorageRequestJson = {
    fileName: string | number[] | Uint8Array;
    fileHash: string | number[] | Uint8Array;
    createdAt: number;
    isAssigned: boolean;
    lastChargedAt: number;
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

// Add new type to include total storage size and length
export type UserIpfsResponse = {
    files: FormattedUserIpfsFile[];
    totalStorageSize: bigint;
    length: number;
};

export const GET_USER_IPFS_FILES_QUERY_KEY = "get-user-ipfs-files";

const IPFS_GATEWAY = "https://get.hippius.network/ipfs/";

export const useUserIpfsFiles = () => {
    const { api, isConnected } = usePolkadotApi();
    const { polkadotAddress } = useWalletAuth();
    const queryClient = useQueryClient();
    const queryKey = [GET_USER_IPFS_FILES_QUERY_KEY, polkadotAddress];

    return useQuery({
        queryKey,
        refetchInterval: 180000,
        refetchIntervalInBackground: true,
        refetchOnWindowFocus: false,
        staleTime: 30000,
        notifyOnChangeProps: 'all',
        queryFn: async () => {
            if (!api || !isConnected || !polkadotAddress) {
                throw new Error("Failed to get your files");
            }

            try {
                let totalStorageSize = BigInt(0);
                try {
                    const userTotalStorageResult = await api.query.ipfsPallet.userTotalFilesSize(polkadotAddress);
                    if (userTotalStorageResult.isSome) {
                        totalStorageSize = userTotalStorageResult.unwrap().toBigInt();
                    }
                } catch (error) {
                    console.error("Error fetching total storage size:", error);
                }

                let storageRequestsData = [];
                try {
                    storageRequestsData = await fetchStorageRequests();
                } catch (error) {
                    console.error("Error fetching storage requests:", error);
                    return {
                        files: [],
                        totalStorageSize
                    };
                }

                let profileCid = null;
                try {
                    const { profileCid: fetchedCid } = await fetchProfileData();
                    profileCid = fetchedCid;
                } catch (error) {
                    console.error("Error fetching profile data:", error);
                }

                if (profileCid) {
                    try {
                        const collections = await fetchCollectionsData(profileCid);

                        const files = mergeAndSortData(storageRequestsData, collections);

                        return {
                            files,
                            totalStorageSize
                        };
                    } catch (error) {
                        console.error("Error fetching collections data:", error);
                        console.log("Falling back to storage requests only:", storageRequestsData.length);
                        return {
                            files: sortByDate(storageRequestsData),
                            totalStorageSize
                        };
                    }
                }

                return {
                    files: sortByDate(storageRequestsData),
                    totalStorageSize
                };
            } catch (error) {
                console.error("Fatal error in useUserIpfsFiles:", error);
                throw new Error("Failed to retrieve your files");
            }
        },
        enabled: !!api && isConnected && !!polkadotAddress,
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

    async function fetchStorageRequests() {
        if (!api) {
            throw new Error("API not initialized");
        }

        const resultsList = await api.query.ipfsPallet.userStorageRequests.entries(
            polkadotAddress
        );

        const storageRequests = resultsList.map(([, result]) =>
            result.toJSON?.() ?? result
        ) as StorageRequestJson[];

        const formattedRequests = storageRequests.map((request) => ({
            minerIds: [],
            name: formatFileName(request.fileName),
            cid: hexToCid(request.fileHash),
            fileHash: request.fileHash,
            createdAt: request.createdAt,
            isAssigned: request.isAssigned,
            lastChargedAt: request.lastChargedAt,
            fileDetails: [] // Default empty file details
        })) as FormattedUserIpfsFile[];

        const assignedRequests = formattedRequests.filter(req => req.isAssigned);
        const unassignedRequests = formattedRequests.filter(req => !req.isAssigned);

        const expandedFiles: FormattedUserIpfsFile[] = [];

        for (const request of unassignedRequests) {
            try {
                const res = await fetch(`${IPFS_GATEWAY}${decodeHexCid(request.cid)}`, {
                    cache: 'no-store',
                    signal: AbortSignal.timeout(120000)
                });

                if (!res.ok) {
                    console.warn(`Couldn't fetch details for ${request.cid}: ${res.status} ${res.statusText}`);
                    expandedFiles.push(request);
                    continue;
                }

                const data = await res.json();
                const innerFiles = Array.isArray(data) ? data : [data];

                if (!innerFiles.length) {
                    expandedFiles.push(request);
                    continue;
                }

                for (const innerFile of innerFiles) {
                    expandedFiles.push({
                        minerIds: request.minerIds,
                        createdAt: request.createdAt,
                        lastChargedAt: request.lastChargedAt,
                        isAssigned: false,
                        fileHash: request.fileHash,
                        name: innerFile.filename || request.name,
                        cid: innerFile.cid || request.cid,
                        size: innerFile.sizeBytes || innerFile.size,
                    });
                }
            } catch (error) {
                console.error(`Error fetching details for ${request.cid}:`, error);
                expandedFiles.push(request);
            }
        }
        return [...assignedRequests, ...expandedFiles];
    }

    function formatFileName(fileName: string | number[] | Uint8Array): string {
        if (Array.isArray(fileName)) {
            return getFileNameFromBytes(fileName);
        }
        return fileName ? hexToAsciiString(fileName.toString()) : "Unnamed File";
    }

    async function fetchProfileData() {
        if (!api) {
            throw new Error("API not initialized");
        }
        const profileData = await api.query.ipfsPallet.userProfile(polkadotAddress);

        if (!profileData) {
            return { profileData: null, profileCid: null };
        }

        const profileCid = extractCidFromHex(profileData.toString());
        return { profileData, profileCid };
    }

    function extractCidFromHex(hexValue: string): string | null {
        // If it starts with 0x, strip that prefix
        const hexString = hexValue.startsWith("0x") ? hexValue.slice(2) : hexValue;

        try {
            const hexBytes = hexString.match(/.{1,2}/g);
            if (!hexBytes) return null;

            const ascii = hexBytes
                .map((byte) => String.fromCharCode(parseInt(byte, 16)))
                .join("");

            return (ascii.startsWith("baf") || ascii.startsWith("Qm")) ? ascii : null;
        } catch {
            return null;
        }
    }

    async function fetchCollectionsData(cid: string) {
        try {
            const response = await fetch(`${IPFS_GATEWAY}${cid}`, {
                cache: 'no-store',
                signal: AbortSignal.timeout(120000)
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch profile: ${response.status} ${response.statusText}`);
            }

            const userData = (await response.json()) as IpfsUserFileCollectionDataResponse;
            const collections = Array.isArray(userData) ? userData : [userData];

            let oldFilesMap: Record<string, FormattedUserIpfsFile> = {};
            try {
                const queryData = queryClient.getQueryData(queryKey);
                if (queryData && typeof queryData === 'object' && 'files' in queryData) {
                    const oldQueryData = (queryData as { files: FormattedUserIpfsFile[] }).files || [];
                    oldFilesMap = oldQueryData.reduce((acc: Record<string, FormattedUserIpfsFile>, curr: FormattedUserIpfsFile) => {
                        if (curr && curr.cid) {
                            acc[curr.cid] = curr;
                        }
                        return acc;
                    }, {});
                }
            } catch (err) {
                console.error("Error accessing query cache:", err);
            }

            const formattedCollections = collections
                .map((collection) => {
                    if (!collection || !collection.file_hash) {
                        return null;
                    }

                    try {
                        const fileCID = Array.isArray(collection.file_hash)
                            ? String.fromCharCode(...collection.file_hash)
                            : collection.file_hash;

                        // Check if we already have this file in cache
                        const existingData = oldFilesMap[fileCID];

                        return {
                            minerIds: collection.miner_ids || [],
                            fileHash: collection.file_hash || "",
                            name: Array.isArray(collection.file_name)
                                ? getFileNameFromBytes(collection.file_name)
                                : collection.file_name || "Unnamed File",
                            cid: fileCID,
                            createdAt: collection.created_at || 0,
                            size: collection.file_size_in_bytes || 0,
                            isAssigned: collection.is_assigned || false,
                            lastChargedAt: collection.last_charged_at || 0,
                            fileDetails: existingData?.fileDetails || []
                        };
                    } catch (error) {
                        console.error("Error formatting collection:", error);
                        return null;
                    }
                })
                .filter(Boolean) as FormattedUserIpfsFile[];

            return formattedCollections;
        } catch (error) {
            console.error(`Error in fetchCollectionsData for CID ${cid}:`, error);
            throw error;
        }
    }

    function mergeAndSortData(
        storageRequests: FormattedUserIpfsFile[],
        collections: FormattedUserIpfsFile[]
    ) {
        const requestsMap = storageRequests.reduce((acc, req) => {
            acc[req.cid] = true;
            return acc;
        }, {} as Record<string, boolean>);

        const uniqueCollections = collections.filter((col) => !requestsMap[col.cid]);

        return [...sortByDate(storageRequests), ...sortByDate(uniqueCollections)];
    }

    function sortByDate(data: FormattedUserIpfsFile[]) {
        return [...data].sort((a, b) => b.createdAt - a.createdAt);
    }
};

export default useUserIpfsFiles;
