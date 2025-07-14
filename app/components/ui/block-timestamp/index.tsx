"use client";

import { useState, useEffect } from 'react';
import { parseDateAndTime } from '@/app/lib/utils/dateUtils';
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { Skeleton } from '@/components/ui';
import { getBlockTimestamp } from '@/lib/utils/blockTimestampUtils';

interface BlockTimestampProps {
    blockNumber: number;
}

const BlockTimestamp: React.FC<BlockTimestampProps> = ({ blockNumber }) => {
    const { api } = usePolkadotApi();
    const [timestamp, setTimestamp] = useState<Date | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let isMounted = true;

        const fetchTimestamp = async () => {
            try {
                setIsLoading(true);
                const date = await getBlockTimestamp(api, blockNumber);

                if (isMounted) {
                    setTimestamp(date);
                    setIsLoading(false);
                }
            } catch (err) {
                if (isMounted && err instanceof Error) {
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
    }, [blockNumber, api]);

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
        <div className="text-left text-base font-medium text-grey-20 self-start">
            <div>{date}{" "}{time}</div>
        </div>
    );
};

export default BlockTimestamp;
