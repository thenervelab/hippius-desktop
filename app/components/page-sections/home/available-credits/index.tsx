"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCcwDot } from "lucide-react";

import { Select } from "@/components/ui";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import useMarketplaceCredits from "@/app/lib/hooks/api/useMarketplaceCredits";
import { Account } from "@/app/lib/types/accounts";
import { ChartPoint } from "@/lib/types/chartTypes";
import { cn } from "@/app/lib/utils";

import AvailableCreditsChart from "./AvailableCreditsChart";

const timeRangeOptions = [
  { value: "last7days", label: "THIS WEEK" },
  { value: "last30days", label: "LAST 30 DAYS" },
  { value: "last60days", label: "LAST 60 DAYS" },
  { value: "year", label: "1 YEAR" },
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
  const [timeRange, setTimeRange] = useState<string>("last7days");

  const {
    data: credits,
    isLoading: creditsLoading,
    isFetching: creditsFetching,
    refetch: refetchCredits,
  } = useUserCredits();
  const {
    data: marketplaceCredits,
    isLoading: chartLoading,
    isFetching: marketplaceFetching,
    refetch: refetchMarketplace,
  } = useMarketplaceCredits();

  // Show the skeleton on every fetch (initial AND refetches), matching the
  // console dashboard. The chart/headline always reflect what the API is
  // currently doing.
  const isFetchingAny = creditsFetching || marketplaceFetching;

  // Manual refresh spins the icon and re-fires both queries in parallel.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (isRefreshing || creditsFetching || marketplaceFetching) return;
    setIsRefreshing(true);
    try {
      await Promise.all([refetchCredits(), refetchMarketplace()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [
    isRefreshing,
    creditsFetching,
    marketplaceFetching,
    refetchCredits,
    refetchMarketplace,
  ]);

  const [transformedData, setTransformedData] = useState<Account[]>([]);
  useEffect(() => {
    if (!marketplaceCredits?.length) {
      setTransformedData([]);
      return;
    }
    invoke<Account[]>("transform_marketplace_credits", {
      credits: marketplaceCredits,
    })
      .then(setTransformedData)
      .catch(() => setTransformedData([]));
  }, [marketplaceCredits]);

  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  useEffect(() => {
    if (!transformedData.length) {
      setChartData([]);
      return;
    }
    invoke<ChartPoint[]>("format_credits_chart", {
      accounts: transformedData,
      range: timeRange,
    })
      .then(setChartData)
      .catch(() => setChartData([]));
  }, [transformedData, timeRange]);

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
              Available Credits
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing || creditsFetching || marketplaceFetching}
              aria-label="Refresh available credits"
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
              onValueChange={setTimeRange}
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
                  aria-label="Loading available credits"
                />
              ) : (
                <>
                  <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                    {balanceDisplay}
                  </span>
                  <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-grey-dark-500 pb-[3px]">
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
            data={chartData}
            color="#3167DD"
            height="100%"
            isLoading={showSkeleton}
            tooltipValueLabel="Credits"
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
