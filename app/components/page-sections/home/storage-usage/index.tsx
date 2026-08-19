"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";

import { toast } from "sonner";

import { RefreshButton, Select } from "@/components/ui";
import {
  useDriveStorageChart,
  type StorageRange,
} from "@/app/lib/hooks/api/useDriveStorageChart";
import { useDriveStorageStats } from "@/app/lib/hooks/api/useDriveStorageStats";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { cn } from "@/app/lib/utils";

import StorageBarChart from "./StorageBarChart";
import { sampleCumulativeBars, getBarCount } from "./storageBarData";
import { nextSkeletonState } from "@/lib/utils/skeletonGate";

const timeRangeOptions = [
  { value: "last7days", label: "THIS WEEK" },
  { value: "last30days", label: "LAST 30 DAYS" },
  { value: "last60days", label: "LAST 60 DAYS" },
  { value: "year", label: "1 YEAR" },
  { value: "max", label: "MAX" },
];

function useIsNarrow(threshold = 640) {
  const [isNarrow, setIsNarrow] = useState(false);
  React.useEffect(() => {
    // matchMedia is absent under jsdom; the wide-layout default is fine there.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    const mq = window.matchMedia(`(max-width: ${threshold}px)`);
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [threshold]);
  return isNarrow;
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

const StorageUsageCard: React.FC<{ className?: string }> = ({ className }) => {
  const [timeRange, setTimeRange] = useState<StorageRange>("last7days");
  const {
    data: chartData,
    isLoading: chartLoading,
    isFetching: chartFetching,
    refetch: refetchChart,
  } = useDriveStorageChart(timeRange);
  const {
    data: storageStats,
    isLoading: statsLoading,
    isFetching: statsFetching,
    refetch: refetchStats,
  } = useDriveStorageStats();
  const isNarrow = useIsNarrow();

  // Skeletons show ONLY until each query first settles, then never again — even
  // while a background refetch is in flight. Two independent latches, because
  // the chart and the headline are fed by two different queries:
  //
  //   • the chart bars come from `useDriveStorageChart` (chartLoading)
  //   • the headline total/$ come from `useDriveStorageStats` (statsLoading)
  //
  // `useDriveStorageStats` runs with `staleTime: 0` + a 6s `refetchInterval`
  // against the indexer, which can lag/stay pending — so its `isLoading`
  // OSCILLATES true↔false on every poll and never settles. The old
  // `showSkeleton = chartLoading || statsLoading` piped that oscillation into
  // the CHART's skeleton, so the bars+labels unmounted→remounted every ~6s and
  // replayed their entrance animation (and flashed the skeleton placeholders).
  // Decoupling the chart from the stats query — and latching each skeleton to
  // its first settle — keeps the card visually static across refreshes; the
  // entrance animation now plays only on real mount (page transition) and on a
  // user range switch.
  const chartSettledRef = useRef(false);
  const chartGate = nextSkeletonState(chartSettledRef.current, chartLoading);
  chartSettledRef.current = chartGate.settled;
  const chartSkeleton = chartGate.showSkeleton;

  const statsSettledRef = useRef(false);
  const statsGate = nextSkeletonState(statsSettledRef.current, statsLoading);
  statsSettledRef.current = statsGate.settled;
  const headlineSkeleton = statsGate.showSkeleton;

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (isRefreshing || chartFetching || statsFetching) return;
    setIsRefreshing(true);
    try {
      await Promise.all([refetchChart(), refetchStats()]);
      toast.success("Storage usage refreshed successfully!");
    } catch (error) {
      console.error("Failed to refresh storage usage:", error);
      toast.error("Failed to refresh storage usage");
    } finally {
      setIsRefreshing(false);
    }
  }, [
    isRefreshing,
    chartFetching,
    statsFetching,
    refetchChart,
    refetchStats,
  ]);

  // Each bar is a raw reading from `get_drive_storage_chart`'s cumulative
  // series (latest snapshot of each day, carry-forwarded), so the last bar
  // equals the "Used" headline. This used to be diffed back into per-day
  // "bytes added" bars, which is why the card contradicted its own headline —
  // the headline is a running total and the bars were deltas. Do not
  // reintroduce a diff here; `sampleCumulativeBars` only picks WHICH days get
  // a bar on long ranges and never transforms values (pinned by
  // `__tests__/storageUsageCard.test.tsx`).
  const barData = useMemo(
    () =>
      sampleCumulativeBars(chartData ?? [], getBarCount(timeRange, isNarrow)),
    [chartData, timeRange, isNarrow],
  );

  // Headline + dollar estimate: sourced from `useDriveStorageStats` (the
  // dedicated tile IPC `get_drive_storage_stats`) instead of the chart's
  // last point, so the headline reflects the freshest snapshot
  // independent of the chart range. Cost model mirrors the console
  // (`totalGB * 0.003` per month).
  const { totalDisplay, dollarEstimate } = useMemo(() => {
    const bytes = storageStats?.totalBytes ?? 0;
    if (!bytes) return { totalDisplay: "0 B", dollarEstimate: "0.00" };
    const totalGB = bytes / (1000 * 1000 * 1000);
    const monthlyCost = totalGB * 0.003;
    return {
      totalDisplay: formatBytes(bytes),
      dollarEstimate: monthlyCost.toFixed(2),
    };
  }, [storageStats]);

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
      <div className="flex h-[46px] w-full items-center justify-center">
        <div className="flex flex-1 min-w-0 items-center justify-between pl-[14px] pr-[10px] py-2">
          <div className="flex items-center gap-1">
            <GripIcon className="size-[18px] text-primary-40 dark:text-primary-brand-dark" />
            <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
              Storage Usage
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <RefreshButton
              onClick={handleRefresh}
              refetching={isRefreshing}
              ariaLabel="Refresh storage usage"
            />
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
          "flex flex-col items-start w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white",
          "dark:bg-black-600 dark:border-black-300",
        )}
      >
        <div className="flex w-full items-start justify-center gap-1 pt-3 px-4">
          <div className="flex flex-1 min-w-0 items-center justify-between gap-3">
            <div className="flex items-end gap-1">
              {headlineSkeleton ? (
                <div
                  className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                  aria-label="Loading storage usage"
                />
              ) : (
                <>
                  <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                    {totalDisplay}
                  </span>
                  <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                    Used
                  </span>
                </>
              )}
            </div>
            {headlineSkeleton ? (
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
            isLoading={chartSkeleton}
            yTickFormat={(v) => formatBytes(v, 1)}
            tooltipValueLabel="Total stored"
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
