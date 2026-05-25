"use client";

import { FC, useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Select, RefreshButton } from "@/components/ui";
import { GripIcon } from "@/components/ui/icons";
import AvailableCreditsChart from "@/components/page-sections/home/available-credits/AvailableCreditsChart";
import useSystemBalance, {
  BalanceObject,
} from "@/app/lib/hooks/api/useSystemBalance";
import type { ChartPoint } from "@/lib/types/chartTypes";

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function normalizeDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatBalanceLabel(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(value < 0.01 && value > 0 ? 4 : 2);
}

/* TRANSACTION OVERVIEW chart panel.
 *
 * Mirrors the billing-page CreditGraph chrome (outer rounded card +
 * gray header strip + inner white panel) so the wallet page reads as
 * a sibling of billing. Data comes from get_system_balance — the same
 * Rust IPC the legacy BalanceTrends used — so this is purely a visual
 * restyle, not a wiring change.
 *
 * Polling is intentionally disabled on the billing-page pattern (the
 * RefreshButton is the only re-fetch trigger) to keep the chart from
 * flashing the skeleton on a timer. See the matching commit on
 * CreditGraph for the rationale. */

const TIME_RANGE_OPTIONS = [
  { value: "last7days", label: "THIS WEEK" },
  { value: "last30days", label: "LAST 30 DAYS" },
  { value: "last60days", label: "LAST 60 DAYS" },
  { value: "year", label: "1 YEAR" },
  { value: "max", label: "MAX" },
];

type TimeRange = (typeof TIME_RANGE_OPTIONS)[number]["value"];

interface TransactionOverviewGraphProps {
  className?: string;
}

// Trims the balance feed to the requested window and emits the
// canonical ChartPoint shape consumed by AvailableCreditsChart.
//
// Mirrors hippius-web's formatAccountsForChartByRange so both clients
// render the same balance trend:
//   - planck → HIP (divide by 1e18) so the y-axis is in human units;
//   - carry-forward fill: every day in the requested range emits a
//     point, defaulting to the most recent prior balance (or 0). This
//     is why a freshly funded wallet shows a flat zero line up until
//     the funding day instead of a blank 0-100 axis.
function formatBalanceForChart(
  rows: BalanceObject[],
  range: TimeRange,
): ChartPoint[] {
  if (!rows.length) return [];

  // Oldest-first so the carry-forward walk picks up the prior balance
  // correctly.
  const sorted = [...rows].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const addDays = (base: Date, n: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
  };

  const earliestRow = new Date(sorted[0].timestamp);
  earliestRow.setHours(0, 0, 0, 0);

  const isLongRange = range === "last30days" ||
    range === "last60days" ||
    range === "year" ||
    range === "max";

  const rangeStart = (() => {
    switch (range) {
      case "last7days":
        return addDays(now, -6);
      case "last30days":
        return addDays(now, -29);
      case "last60days":
        return addDays(now, -59);
      case "year": {
        const d = new Date(now);
        d.setFullYear(d.getFullYear() - 1);
        return d;
      }
      case "max":
      default:
        // No hard "Hippius creation date" constant on desktop; the
        // earliest known row is the natural floor for the max range.
        return earliestRow;
    }
  })();

  const getLabel = (d: Date) =>
    isLongRange
      ? `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
      : WEEKDAYS_SHORT[d.getDay()];

  // Bucket the day-last reading per local day. Rust's IPC already
  // dedupes per UTC day, but bucketing here on local time keeps the
  // chart axis aligned with the user's clock — same as hippius-web.
  const byDay = new Map<string, { ts: number; balance: number }>();
  for (const row of sorted) {
    const ts = new Date(row.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const key = normalizeDate(new Date(ts));
    const prev = byDay.get(key);
    if (!prev || ts > prev.ts) {
      byDay.set(key, { ts, balance: Number(row.totalBalance) / 1e18 });
    }
  }

  // Seed the carry-forward with the latest reading before rangeStart so
  // a chart that opens "in the middle" of the user's history starts at
  // the right baseline instead of zero.
  let last: { ts: number; balance: number } | null = null;
  for (const row of sorted) {
    const ts = new Date(row.timestamp).getTime();
    const day = new Date(ts);
    day.setHours(0, 0, 0, 0);
    if (day < rangeStart && (!last || ts > last.ts)) {
      last = { ts, balance: Number(row.totalBalance) / 1e18 };
    }
  }

  const points: ChartPoint[] = [];
  for (
    let date = new Date(rangeStart);
    date <= now;
    date = addDays(date, 1)
  ) {
    const key = normalizeDate(date);
    const today = byDay.get(key);
    if (today) last = today;
    const balance = last?.balance ?? 0;
    points.push({
      x: key,
      balance,
      formattedBalance: formatBalanceLabel(balance),
      timestamp: last ? new Date(last.ts).toISOString() : "",
      dayLabel: getLabel(date),
    });
  }
  return points;
}

const TransactionOverviewGraph: FC<TransactionOverviewGraphProps> = ({
  className,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRange>("last7days");
  const {
    data: balances,
    isLoading,
    isPlaceholderData,
    refetch,
  } = useSystemBalance(undefined, { refetchInterval: false });

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

  const chartData = useMemo(
    () => formatBalanceForChart(balances ?? [], timeRange),
    [balances, timeRange],
  );

  const latestBalance = useMemo(() => {
    if (!chartData.length) return 0;
    return chartData[chartData.length - 1]?.balance ?? 0;
  }, [chartData]);

  // Skeleton triggers on: initial load (isLoading + no data), explicit
  // refresh click (isRefreshing), or a wallet switch — the latter is
  // surfaced via `isPlaceholderData` because `useSystemBalance` uses
  // `keepPreviousData`, so `isLoading` stays false while the new
  // wallet's series is being fetched.
  const hasData = Array.isArray(balances);
  const showSkeleton =
    (isLoading && !hasData) || isRefreshing || isPlaceholderData;

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
      {/* Header */}
      <div className="flex h-[46px] w-full items-center justify-between pl-[14px] pr-[10px]">
        <div className="flex items-center gap-1">
          <GripIcon className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Transaction Overview
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <RefreshButton
            onClick={handleRefresh}
            refetching={isRefreshing}
            ariaLabel="Refresh transaction overview"
          />
          <Select
            options={TIME_RANGE_OPTIONS}
            value={timeRange}
            onValueChange={(v) => setTimeRange(v as TimeRange)}
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

      {/* Inner panel */}
      <div
        className={cn(
          "flex flex-col w-full flex-1",
          "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
        )}
      >
        <div className="flex items-end gap-1 pt-3 px-4">
          {showSkeleton ? (
            <div className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
          ) : (
            <>
              <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                {latestBalance >= 1e6
                  ? `${(latestBalance / 1e6).toFixed(1)}M`
                  : latestBalance >= 1e3
                    ? `${(latestBalance / 1e3).toFixed(1)}K`
                    : latestBalance.toFixed(
                        latestBalance < 0.01 && latestBalance > 0 ? 4 : 2,
                      )}
              </span>
              <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                hALPHA balance
              </span>
            </>
          )}
        </div>

        <div className="relative w-full h-[180px] px-4 py-3">
          {/* Empty state is handled by AvailableCreditsChart itself —
              it paints axis labels, day ticks and dashed grid lines
              against an empty series, matching the home-page Available
              Credits card. Don't intercept with a "no data" message —
              that hides the chart chrome the user expects. */}
          <AvailableCreditsChart
            data={chartData}
            color="#3167DD"
            height="100%"
            isLoading={showSkeleton}
            tooltipValueLabel="Balance"
            formatTooltipValue={(point) => {
              const date = new Date(point.x);
              const dayName = date.toLocaleDateString("en-US", {
                weekday: "long",
              });
              const monthDay = date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });
              return `${dayName}, ${monthDay}\n${point.formattedBalance ?? point.balance}`;
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default TransactionOverviewGraph;
