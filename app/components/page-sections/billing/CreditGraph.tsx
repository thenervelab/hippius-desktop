"use client";

import { FC, useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  useDriveCreditsChart,
  CreditsChartRange,
} from "@/app/lib/hooks/api/useDriveCreditsChart";
import AvailableCreditsChart from "@/components/page-sections/home/available-credits/AvailableCreditsChart";
import { Select, RefreshButton } from "@/components/ui";
import CustomTooltip2 from "@/components/ui/CustomTooltip2";
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
  const [timeRange, setTimeRange] = useState<CreditsChartRange>("last7days");
  // Drive-scoped usage, identical source to the home page's Available Credits
  // chart (`/user-credits-by-storage-history?storage_type=drive`). Previously
  // this page used the wallet-wide marketplace feed, which showed a LARGER
  // per-day value than home and confused users — both desktop charts now show
  // the same "credits used by Drive storage" figure. Wallet-wide / all-product
  // usage lives on the web console; see the title's info tooltip.
  const {
    data: chartData,
    isLoading,
    refetch,
  } = useDriveCreditsChart(timeRange);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refetch();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, refetch]);

  // Skeleton shows on (1) the first fetch when no data is cached yet, and
  // (2) while the user-triggered refresh is in flight. Background isFetching is
  // intentionally ignored — there's no automatic polling on this page.
  const hasData = Array.isArray(chartData);
  const showSkeleton = (isLoading && !hasData) || isRefreshing;

  const points = useMemo(() => chartData ?? [], [chartData]);

  // The chart is cumulative and seeded by all spend strictly before the
  // window, so its LAST point is the all-time drive credits-used total —
  // range-independent and guaranteed to agree with the chart line. No
  // separate total fetch needed.
  const usedTotal = points.length ? points[points.length - 1].balance : 0;

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
            Drive Credit Usage
          </p>
          {/* Same clarifier as the home Available Credits card: this chart is
              DRIVE-scoped, unlike the web console's wallet-wide usage view. */}
          <CustomTooltip2
            side="top"
            showInfo
            iconSize={3.5}
            iconColor="text-primary-40 dark:text-primary-brand-dark"
            tooltipContent="This chart shows credits consumed by Drive storage only, the same figure as the home page. Your total credit usage across all Hippius products is shown on the web console."
          />
        </div>
        <div className="flex items-center gap-2.5">
          <RefreshButton
            onClick={handleRefresh}
            refetching={isRefreshing}
            ariaLabel="Refresh drive credit usage"
          />
          <Select
            options={TIME_RANGE_OPTIONS}
            value={timeRange}
            onValueChange={(v) => setTimeRange(v as CreditsChartRange)}
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
                drive credits used
              </span>
            </>
          )}
        </div>

        {/* Chart */}
        <div className="relative w-full h-[180px] px-4 py-3">
          {!showSkeleton && points.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <span className="text-[13px] text-grey-dark-600 font-medium">No credits data available</span>
            </div>
          ) : (
            <AvailableCreditsChart
              data={points}
              color="#3167DD"
              height="100%"
              isLoading={showSkeleton}
              tooltipValueLabel="Drive credits used"
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
