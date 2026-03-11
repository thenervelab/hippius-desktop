"use client";

import { useState, useEffect } from 'react';
import { parseDateAndTime } from '@/app/lib/utils/dateUtils';
import { Skeleton } from '@/components/ui';
import { invoke } from '@tauri-apps/api/core';

interface BlockTimestampProps {
    blockNumber: number;
}

// Cache for block timestamps to avoid redundant Rust calls
const blockTimestampCache: Record<number, Date> = {};

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
                if (blockTimestampCache[blockNumber]) {
                    if (isMounted) {
                        setTimestamp(blockTimestampCache[blockNumber]);
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
                blockTimestampCache[blockNumber] = date;

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
