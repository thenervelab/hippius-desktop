"use client";

import { FC, useMemo } from "react";
import { cn } from "@/lib/utils";
import useCredits from "@/app/lib/hooks/api/useCredits";
import CreditsTrends from "./credits-trends";

interface CreditGraphProps {
    className?: string;
}

const CreditGraph: FC<CreditGraphProps> = ({ className }) => {
    const { data: creditsDaily, isLoading: isCreditsLoading } = useCredits();

    const chartData = useMemo(() => {
        const rows = creditsDaily ?? [];
        return rows.map((r) => {
            return {
                processed_timestamp: r.date,
                credit: r.amount,
                total_balance: "0",
            };
        });
    }, [creditsDaily]);

    return (
        <div className={cn("grid ", className)}>
            <CreditsTrends
                className="min-w-0 border border-grey-80 rounded-lg"
                chartData={chartData}
                isLoading={isCreditsLoading}
            />
        </div>
    );
};

export default CreditGraph;
