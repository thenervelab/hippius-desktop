"use client";

import { FC, useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import AvailableCreditsChart from "@/components/page-sections/home/available-credits/AvailableCreditsChart";
import { formatCreditsForChart, totalCreditsUsed, CreditChartRange } from "@/lib/utils/formatCreditChart";
import { Select, RefreshButton } from "@/components/ui";
import { GripIcon } from "@/components/ui/icons";

const TIME_RANGE_OPTIONS = [
  { value: "last7days", label: "THIS WEEK" },
  { value: "last30days", label: "LAST 30 DAYS" },
  { value: "last60days", label: "LAST 60 DAYS" },
  { value: "year", label: "1 YEAR" },
  { value: "max", label: "MAX" },
];

interface CreditGraphProps {
  className?: string;
}

const CreditGraph: FC<CreditGraphProps> = ({ className }) => {
  const [timeRange, setTimeRange] = useState<CreditChartRange>("last7days");
  const {
    data: credits,
    isLoading,
    isFetching,
    refetch,
  } = useMarketplaceCredits();

  // isLoading: true only on the first fetch when no data is cached yet.
  // isFetching: true on every background poll (every LIVE_DATA_REFRESH_MS).
  // The skeleton must follow isLoading only — keepPreviousData already
  // preserves the chart while a poll is in flight, so reacting to
  // isFetching here would flash the skeleton every 6 s and look like
  // the chart is stuck "loading". The RefreshButton still surfaces
  // isFetching so users can see when a background refresh is happening.
  const hasData = Array.isArray(credits);
  const showSkeleton = isLoading && !hasData;

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (isRefreshing || isFetching) return;
    setIsRefreshing(true);
    try {
      await refetch();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, isFetching, refetch]);

  const chartData = useMemo(
    () => formatCreditsForChart(credits ?? [], timeRange),
    [credits, timeRange],
  );

  const usedTotal = useMemo(() => totalCreditsUsed(credits ?? []), [credits]);

  return (
    <div
      className={cn(
        "flex flex-col items-center w-full rounded-[8px] border overflow-hidden",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {/* Header row */}
      <div className="flex h-[46px] w-full items-center justify-between pl-[14px] pr-[10px]">
        <div className="flex items-center gap-1">
          <GripIcon className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Credit Overview
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <RefreshButton
            onClick={handleRefresh}
            refetching={isRefreshing || isFetching}
            ariaLabel="Refresh credit overview"
          />
          <Select
            options={TIME_RANGE_OPTIONS}
            value={timeRange}
            onValueChange={(v) => setTimeRange(v as CreditChartRange)}
            triggerClassName={cn(
              "h-auto min-h-0 px-2 py-1.5 rounded-[7px]",
              "font-mono font-medium text-[12px] leading-5 tracking-[-0.24px] uppercase",
              "bg-white border-grey-dark-100 text-black-700",
              "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
              "dark:bg-black-300 dark:border-black-300 dark:text-white",
              "dark:shadow-[0px_5px_2.3px_0px_rgba(255,255,255,0.02),0px_1px_1.9px_0px_rgba(255,255,255,0.08),0px_0px_1px_0px_rgba(255,255,255,0.1)]",
              "[&_svg]:size-[14px] [&_svg]:text-black-700 dark:[&_svg]:text-white",
            )}
            contentClassName="min-w-[160px]"
          />
        </div>
      </div>

      {/* Inner panel — fully rounded with border; outer overflow-hidden clips the bottom corners flush */}
      <div className={cn(
        "flex flex-col w-full flex-1",
        "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
        "bg-white dark:bg-black-600 dark:border-black-300",
      )}>
        {/* Headline stat */}
        <div className="flex items-end gap-1 pt-3 px-4">
          {showSkeleton ? (
            <div className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
          ) : (
            <>
              <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                {usedTotal >= 1e6
                  ? `${(usedTotal / 1e6).toFixed(1)}M`
                  : usedTotal >= 1e3
                    ? `${(usedTotal / 1e3).toFixed(1)}K`
                    : usedTotal.toFixed(usedTotal < 0.01 && usedTotal > 0 ? 4 : 2)}
              </span>
              <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                credits used
              </span>
            </>
          )}
        </div>

        {/* Chart */}
        <div className="relative w-full h-[180px] px-4 py-3">
          {!showSkeleton && chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <span className="text-[13px] text-grey-dark-600 font-medium">No credits data available</span>
            </div>
          ) : (
            <AvailableCreditsChart
              data={chartData}
              color="#3167DD"
              height="100%"
              isLoading={showSkeleton}
              tooltipValueLabel="Credits Used"
              formatTooltipValue={(point) => {
                const date = new Date(point.x);
                const dayName = date.toLocaleDateString("en-US", { weekday: "long" });
                const monthDay = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                return `${dayName}, ${monthDay}\n${point.formattedBalance ?? point.balance}`;
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default CreditGraph;
