import { useQuery } from "@tanstack/react-query";

interface FileRecord {
    id: number;
    cid: string;
    owner: string;
    miner1: string;
    miner2: string;
    miner3: string;
    miner4: string;
    miner5: string;
    created_at: string;
    updated_at: string;
    processed_timestamp: string;
    profile_cid: string;
    file_name: string;
    file_size_in_bytes: number;
    created_at_block: number;
    updated_at_block: number;
}

interface FilesApiResponse {
    files: FileRecord[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        total_pages: number;
    };
}

interface NodeResponse {
    nodes: string[];
}

// Hook to fetch nodes for a given CID
export const useFileNodes = (cid: string | null) => {
    return useQuery<NodeResponse, Error>({
        queryKey: ["file-nodes", cid],
        queryFn: async (): Promise<NodeResponse> => {
            if (!cid || cid === "pending") {
                throw new Error("Invalid CID");
            }

            const response = await fetch(
                `https://indexer.hippius.network/files?cid=${cid}`
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch nodes: ${response.statusText}`);
            }

            const data: FilesApiResponse = await response.json();

            // Get the first file record
            const firstFile = data.files?.[0];

            if (!firstFile) {
                return { nodes: [] };
            }

            // Extract miner IDs from miner1-miner5 fields, filtering out empty/null values
            const miners = [
                firstFile.miner1,
                firstFile.miner2,
                firstFile.miner3,
                firstFile.miner4,
                firstFile.miner5,
            ].filter(miner => miner && miner.trim() !== "");

            return { nodes: miners };
        },
        enabled: !!(cid && cid !== "pending"),
        staleTime: 5 * 60 * 1000, // 5 minutes
        retry: 2,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    });
};