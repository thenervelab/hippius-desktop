"use client";

import React, { useCallback, useMemo, useState } from "react";
import { RefreshCcwDot } from "lucide-react";

import { Select } from "@/components/ui";
import useFiles from "@/app/lib/hooks/api/useFilesSize";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { cn } from "@/app/lib/utils";

import StorageBarChart from "./StorageBarChart";
import { buildStorageDeltaBars, StorageRange } from "./storageDeltaUtils";

const timeRangeOptions = [
  { value: "last7days", label: "THIS WEEK" },
  { value: "last30days", label: "LAST 30 DAYS" },
  { value: "last60days", label: "LAST 60 DAYS" },
  { value: "year", label: "1 YEAR" },
  { value: "max", label: "MAX" },
];

/**
 * One bar per day for week/30/60-day views; for year/max we render up to ~24
 * bars (monthly aggregation may compress that further). Narrow widths fall
 * back to 7 bars to keep the pills legible.
 */
function getBarCount(range: StorageRange, isNarrow: boolean): number {
  if (isNarrow) return 7;
  switch (range) {
    case "last7days":
      return 7;
    case "last30days":
      return 30;
    case "last60days":
      return 30;
    case "year":
    case "max":
      return 24;
    default:
      return 15;
  }
}

const GripIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 18 18"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <circle cx="4.5" cy="4.5" r="1" fill="currentColor" />
    <circle cx="9" cy="4.5" r="1" fill="currentColor" />
    <circle cx="13.5" cy="4.5" r="1" fill="currentColor" />
    <circle cx="4.5" cy="9" r="1" fill="currentColor" />
    <circle cx="9" cy="9" r="1" fill="currentColor" />
    <circle cx="13.5" cy="9" r="1" fill="currentColor" />
    <circle cx="4.5" cy="13.5" r="1" fill="currentColor" />
    <circle cx="9" cy="13.5" r="1" fill="currentColor" />
    <circle cx="13.5" cy="13.5" r="1" fill="currentColor" />
  </svg>
);

function useIsNarrow(threshold = 640) {
  const [isNarrow, setIsNarrow] = useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${threshold}px)`);
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [threshold]);
  return isNarrow;
}

const StorageUsageCard: React.FC<{ className?: string }> = ({ className }) => {
  const [timeRange, setTimeRange] = useState<StorageRange>("last7days");
  const { data: fileData, isLoading, isFetching, refetch } = useFiles();
  const isNarrow = useIsNarrow();

  // Show the skeleton on every fetch (initial AND refetches) so the chart
  // and headline stay in sync with what the API is doing — same UX pattern
  // as the console dashboard.
  const showSkeleton = isLoading || isFetching;

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

  const barData = useMemo(() => {
    if (!fileData?.length) return [];
    return buildStorageDeltaBars(
      fileData,
      timeRange,
      getBarCount(timeRange, isNarrow),
    );
  }, [fileData, timeRange, isNarrow]);

  // Headline + dollar estimate: derived from the latest cumulative reading.
  // Cost model mirrors the console (`totalGB * 0.003` per month) so the two
  // dashboards stay numerically consistent.
  const { totalDisplay, dollarEstimate } = useMemo(() => {
    if (!fileData?.length)
      return { totalDisplay: "0 B", dollarEstimate: "0.00" };
    const sorted = [...fileData].sort(
      (a, b) =>
        new Date(a.processed_timestamp).getTime() -
        new Date(b.processed_timestamp).getTime(),
    );
    const last = sorted[sorted.length - 1];
    const bytes = Number(last?.total_balance) || 0;
    const totalGB = bytes / (1000 * 1000 * 1000);
    const monthlyCost = totalGB * 0.003;
    return {
      totalDisplay: formatBytes(bytes),
      dollarEstimate: monthlyCost.toFixed(2),
    };
  }, [fileData]);

  return (
    <div
      className={cn(
        "flex flex-col items-center w-full rounded-[8px] border",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-300/40 dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      <div className="flex h-[46px] w-full items-center justify-center">
        <div className="flex flex-1 min-w-0 items-center justify-between pl-[14px] pr-[10px] py-2">
          <div className="flex items-center gap-1">
            <GripIcon className="size-[18px] text-primary-40 dark:text-primary-brand-dark" />
            <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
              Storage Usage
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing || isFetching}
              aria-label="Refresh storage usage"
              className={cn(
                "flex h-8 w-[33px] items-center justify-center rounded-[7px] border",
                "bg-grey-light-700 border-grey-dark-100",
                "dark:bg-black-300 dark:border-black-300",
                "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
                "disabled:cursor-not-allowed",
              )}
            >
              <RefreshCcwDot
                className={cn(
                  "size-[18px] text-black-700 dark:text-white opacity-40",
                  isRefreshing && "animate-spin opacity-100",
                )}
              />
            </button>
            <Select
              options={timeRangeOptions}
              value={timeRange}
              onValueChange={(v) => setTimeRange(v as StorageRange)}
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
      </div>

      <div
        className={cn(
          "flex flex-col items-start w-full flex-1 rounded-[8px] border",
          "bg-white border-grey-dark-100",
          "dark:bg-black-primary-bg dark:border-black-300",
        )}
      >
        <div className="flex w-full items-start justify-center gap-1 pt-3 px-4">
          <div className="flex flex-1 min-w-0 items-center justify-between gap-3">
            <div className="flex items-end gap-1">
              {showSkeleton ? (
                <div
                  className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                  aria-label="Loading storage usage"
                />
              ) : (
                <>
                  <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                    {totalDisplay}
                  </span>
                  <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-grey-dark-500 pb-[3px]">
                    Used
                  </span>
                </>
              )}
            </div>
            {showSkeleton ? (
              <div
                className="h-[20px] w-[80px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                aria-hidden="true"
              />
            ) : (
              <p className="font-geist font-medium text-[14px] leading-[20px] tracking-[-0.28px] text-primary-50 dark:text-primary-brand-dark whitespace-nowrap">
                ≈ ${dollarEstimate}
              </p>
            )}
          </div>
        </div>

        <div className="relative w-full h-[220px] px-5 py-4">
          <StorageBarChart
            data={barData}
            isLoading={showSkeleton}
            yTickFormat={(v) => formatBytes(v, 1)}
            tooltipValueLabel="Storage Used"
            formatTooltipValue={(point) => {
              const date = new Date(point.x);
              const dayName = date.toLocaleDateString("en-US", {
                weekday: "long",
              });
              const monthDay = date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              });
              return `${dayName}, ${monthDay}\n${
                point.formattedBalance ?? formatBytes(point.balance || 0)
              }`;
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default StorageUsageCard;
