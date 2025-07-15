/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Utility functions for handling block timestamps
 */
// Import the type for the API context
import type { ApiPromise } from "@polkadot/api";

// Cache for block timestamps to avoid redundant API calls
const blockTimestampCache: Record<number, Date> = {};

/**
 * Get a timestamp for a given block number
 */
export async function getBlockTimestamp(
    api: ApiPromise | null,
    blockNumber: number
): Promise<Date | null> {
    try {
        if (!api || !api.isConnected) {
            return null;
        }

        // Return from cache if available
        if (blockTimestampCache[blockNumber]) {
            return blockTimestampCache[blockNumber];
        }

        const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
        const timestamp = await api.query.timestamp.now.at(blockHash);
        const date = new Date(Number(timestamp.toString()));

        // Cache the result
        blockTimestampCache[blockNumber] = date;
        return date;
    } catch (error) {
        console.log('Error fetching block timestamp:', error);
        return null;
    }
}

/**
 * Convert a list of files with block numbers to files with timestamp dates
 */
export async function enrichFilesWithTimestamps(
    api: ApiPromise | null,
    files: Array<{ createdAt: number;[key: string]: any }>
): Promise<Array<{ createdAt: number; timestamp: Date | null;[key: string]: any }>> {
    if (!api || !api.isConnected) {
        return files.map(file => ({ ...file, timestamp: null }));
    }

    // Get unique block numbers
    const blockNumbers = [...new Set(files.map(file => file.createdAt))];

    // Fetch timestamps for all unique block numbers
    const timestampPromises = blockNumbers.map(async blockNumber => {
        const timestamp = await getBlockTimestamp(api, blockNumber);
        return { blockNumber, timestamp };
    });

    const blockTimestamps = await Promise.all(timestampPromises);

    // Create a lookup map
    const timestampMap = blockTimestamps.reduce((map, { blockNumber, timestamp }) => {
        map[blockNumber] = timestamp;
        return map;
    }, {} as Record<number, Date | null>);

    // Enrich files with timestamps
    return files.map(file => ({
        ...file,
        timestamp: timestampMap[file.createdAt]
    }));
}
