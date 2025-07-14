"use client";

import { useState, useEffect } from 'react';
import { parseDateAndTime } from '@/app/lib/utils/dateUtils';
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { Skeleton } from '@/components/ui';

interface BlockTimestampProps {
    blockNumber: number;
}

const BlockTimestamp: React.FC<BlockTimestampProps> = ({ blockNumber }) => {
    const { api, isConnected } = usePolkadotApi();
    const [timestamp, setTimestamp] = useState<Date | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(false);
    const blockTimestampCache: Record<number, Date> = {};

    const getBlockTimestamp = async (blockNumber: number): Promise<Date | null> => {
        try {
            if (!api || !isConnected) {
                return null;
            }

            if (blockTimestampCache[blockNumber]) {
                return blockTimestampCache[blockNumber];
            }

            const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
            const timestamp = await api.query.timestamp.now.at(blockHash);
            const date = new Date(Number(timestamp.toString()));

            blockTimestampCache[blockNumber] = date;
            return date;
        } catch (error) {
            console.log('Error fetching block timestamp:', error);
            return null;
        }
    }

    useEffect(() => {
        let isMounted = true;

        const fetchTimestamp = async () => {
            try {
                setIsLoading(true);
                const date = await getBlockTimestamp(blockNumber);

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
    }, [blockNumber, api, isConnected]);

    if (isLoading || !isConnected) {
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
            {/* <div>{time}</div> */}
        </div>
    );
};

export default BlockTimestamp;
