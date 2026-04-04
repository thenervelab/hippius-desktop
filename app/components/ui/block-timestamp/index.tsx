"use client";

import { useState, useEffect } from 'react';
import { parseDateAndTime } from '@/app/lib/utils/dateUtils';
import { Skeleton } from '@/components/ui';
import { invoke } from '@tauri-apps/api/core';

interface BlockTimestampProps {
    blockNumber: number;
}

// Cache for block timestamps with LRU eviction (max 500 entries)
const MAX_CACHE_SIZE = 500;
const blockTimestampCache = new Map<number, Date>();
function cacheSet(key: number, value: Date) {
    if (blockTimestampCache.size >= MAX_CACHE_SIZE) {
        // Evict oldest entry (first key in Map insertion order)
        const firstKey = blockTimestampCache.keys().next().value;
        if (firstKey !== undefined) blockTimestampCache.delete(firstKey);
    }
    blockTimestampCache.set(key, value);
}

const BlockTimestamp: React.FC<BlockTimestampProps> = ({ blockNumber }) => {
    const [timestamp, setTimestamp] = useState<Date | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let isMounted = true;

        const fetchTimestamp = async () => {
            try {
                setIsLoading(true);

                // Check cache first
                const cached = blockTimestampCache.get(blockNumber);
                if (cached) {
                    if (isMounted) {
                        setTimestamp(cached);
                        setIsLoading(false);
                    }
                    return;
                }

                const result = await invoke<{ timestamp: number }>(
                    'get_block_timestamp',
                    { blockNumber }
                );
                const date = new Date(result.timestamp);

                // Cache the result
                cacheSet(blockNumber, date);

                if (isMounted) {
                    setTimestamp(date);
                    setIsLoading(false);
                }
            } catch (err) {
                if (isMounted) {
                    console.error('Block timestamp fetch failed:', err);
                    setError(true);
                    setIsLoading(false);
                }
            }
        };

        if (blockNumber) {
            fetchTimestamp();
        }

        return () => {
            isMounted = false;
        };
    }, [blockNumber]);

    if (isLoading) {
        return (
            <div className="text-grey-20">
                <Skeleton height={20} width={150} />
            </div>
        );
    }

    if ((error || !timestamp) && !isLoading) {
        return <span className="text-grey-50">—</span>;
    }

    if (!timestamp) {
        return <span className="text-grey-50">—</span>;
    }
    const { date, time } = parseDateAndTime(timestamp.toISOString());

    return (
        <div className="text-left text-base font-medium text-grey-60 self-start">
            <div>{date}{" "}{time}</div>
        </div>
    );
};

export default BlockTimestamp;
