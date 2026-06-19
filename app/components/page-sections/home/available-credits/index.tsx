"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { RefreshButton, Select } from "@/components/ui";
import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import {
  useDriveCreditsChart,
  CreditsChartRange,
} from "@/app/lib/hooks/api/useDriveCreditsChart";
import { cn } from "@/app/lib/utils";

import AvailableCreditsChart from "./AvailableCreditsChart";

// Drive credit history only exists from the endpoint's first event onward, so
// longer fixed windows (60 days, 1 year) would render mostly flat-zero before
// the data begins. We offer just these three; MAX clamps to the first real
// event in Rust (`build_credits_chart`) and auto-grows as the span lengthens,
// so this set stays correct in future years without per-year special-casing.
const timeRangeOptions = [
  { value: "last7days", label: "THIS WEEK" },
  { value: "last30days", label: "LAST 30 DAYS" },
  { value: "max", label: "MAX" },
];

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

const AvailableCreditsCard: React.FC<{ className?: string }> = ({
  className,
}) => {
  const [timeRange, setTimeRange] = useState<CreditsChartRange>("last7days");

  const {
    data: credits,
    isLoading: creditsLoading,
    isFetching: creditsFetching,
    refetch: refetchCredits,
  } = useUserCredits();
  const {
    data: chartData,
    isLoading: chartLoading,
    isFetching: chartFetching,
    refetch: refetchChart,
  } = useDriveCreditsChart(timeRange);

  // Show the skeleton on every fetch (initial AND refetches), matching the
  // console dashboard. The chart/headline always reflect what the API is
  // currently doing.
  const isFetchingAny = creditsFetching || chartFetching;

  // Manual refresh spins the icon, re-fires both queries in parallel, and
  // surfaces toast feedback so refresh always confirms.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (isRefreshing || creditsFetching || chartFetching) return;
    setIsRefreshing(true);
    try {
      await Promise.all([refetchCredits(), refetchChart()]);
      toast.success("Credits refreshed successfully!");
    } catch (error) {
      console.error("Failed to refresh credits:", error);
      toast.error("Failed to refresh credits");
    } finally {
      setIsRefreshing(false);
    }
  }, [
    isRefreshing,
    creditsFetching,
    chartFetching,
    refetchCredits,
    refetchChart,
  ]);

  const isLoading = creditsLoading || chartLoading;
  const showSkeleton = isLoading || isFetchingAny;

  const balanceDisplay = useMemo(() => {
    if (creditsLoading) return null;
    return credits?.hip ?? "0";
  }, [credits, creditsLoading]);

  // Blue dollar estimate next to the headline. 1 credit ≈ $1 (matches the
  // console's `getDollarValue`), shown to two decimals.
  const dollarValue = useMemo(() => {
    const num = Number(credits?.hip ?? 0);
    return Number.isFinite(num) ? num.toFixed(2) : "0.00";
  }, [credits?.hip]);

  // Storage capacity equivalent for the credit balance, computed in Rust.
  const [storageDisplay, setStorageDisplay] = useState<string>("");
  useEffect(() => {
    const num = Number(credits?.hip ?? 0);
    if (!Number.isFinite(num) || num <= 0) {
      setStorageDisplay("");
      return;
    }
    invoke<Array<{ storageDisplay: string }>>("calculate_storage_capacity", {
      creditsPerMonth: [num],
    })
      .then((results) => setStorageDisplay(results[0]?.storageDisplay ?? ""))
      .catch(() => setStorageDisplay(""));
  }, [credits?.hip]);

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
              Available Credits
            </p>
            {/* The usage chart below is DRIVE-scoped (source:
                `/user-credits-by-storage-history?storage_type=drive`), unlike the
                web console / the Billing page, which show wallet-wide usage. The
                info tooltip makes that scope explicit so the per-day values don't
                read as "wrong" against those wallet-wide views. */}
            <CustomTooltip2
              side="top"
              showInfo
              iconSize={3.5}
              iconColor="text-primary-40 dark:text-primary-brand-dark"
              tooltipContent="This chart shows credits consumed by Drive storage only. Your total credit usage across all Hippius products is shown on the web console."
            />
          </div>
          <div className="flex items-center gap-2.5">
            <RefreshButton
              onClick={handleRefresh}
              refetching={isRefreshing || creditsFetching || chartFetching}
              ariaLabel="Refresh available credits"
            />
            <Select
              options={timeRangeOptions}
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
              {showSkeleton ? (
                <div
                  className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                  aria-label="Loading available credits"
                />
              ) : (
                <>
                  <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                    {balanceDisplay}
                  </span>
                  <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                    credits
                  </span>
                </>
              )}
            </div>
            {showSkeleton ? (
              <div
                className="h-[20px] w-[160px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                aria-hidden="true"
              />
            ) : (
              <div className="flex items-baseline gap-0.5 min-w-0">
                <p className="font-geist font-medium text-[14px] leading-[20px] tracking-[-0.28px] text-primary-50 dark:text-primary-brand-dark whitespace-nowrap">
                  ≈ ${dollarValue}
                </p>
                {storageDisplay && (
                  <p className="hidden @lg:block font-geist font-medium text-[11px] leading-[16px] tracking-[-0.22px] text-grey-50 dark:text-grey-dark-500 truncate">
                    {storageDisplay}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="relative w-full h-[220px] px-5 py-4">
          <AvailableCreditsChart
            data={chartData ?? []}
            color="#3167DD"
            height="100%"
            isLoading={showSkeleton}
            tooltipValueLabel="Drive credits used"
            formatTooltipValue={(point) => {
              const date = new Date(point.x);
              const dayName = date.toLocaleDateString("en-US", {
                weekday: "long",
              });
              const monthDay = date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });
              return `${dayName}, ${monthDay}\n${
                point.formattedBalance ?? point.balance
              }`;
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default AvailableCreditsCard;
