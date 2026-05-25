"use client";

import React, { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import MiniBarChart, { type ChartDataPoint } from "./MiniBarChart";
import Skeleton from "@/components/ui/SkeletonLoader";
import HomepageChartSelect from "@/components/ui/HomepageChartSelect";

/* Single stat card on the referrals dashboard. Composed of a label +
 * value + range-filter dropdown on the left and a MiniBarChart on the
 * right. Ported from hippius-web with the time-range options pinned to
 * the same five buckets web uses. */

const TIME_RANGE_OPTIONS = [
  { value: "last7days", label: "THIS WEEK" },
  { value: "last30days", label: "LAST 30 DAYS" },
  { value: "last60days", label: "LAST 60 DAYS" },
  { value: "year", label: "1 YEAR" },
  { value: "max", label: "MAX" },
];

/** Build date-bucketed chart data from raw seed values based on the
 *  selected range. Mirrors web's buildChartData exactly so the same
 *  PLACEHOLDER_CHART seeds produce identical labels across both
 *  clients. */
function buildChartData(
  seedValues: number[],
  timeRange: string,
): ChartDataPoint[] {
  const now = new Date();

  let bucketCount: number;
  let getDate: (index: number, total: number) => Date;
  let formatLabel: (d: Date) => string;

  switch (timeRange) {
    case "last7days": {
      bucketCount = 7;
      getDate = (i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (bucketCount - 1 - i));
        return d;
      };
      formatLabel = (d) =>
        `${d.toLocaleDateString("en-US", { weekday: "long" })}, ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
      break;
    }
    case "last30days": {
      bucketCount = 30;
      getDate = (i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (bucketCount - 1 - i));
        return d;
      };
      formatLabel = (d) =>
        d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      break;
    }
    case "last60days": {
      bucketCount = 30; // 2-day buckets
      getDate = (i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (bucketCount - 1 - i) * 2);
        return d;
      };
      formatLabel = (d) =>
        d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      break;
    }
    case "year": {
      bucketCount = 12;
      getDate = (i) => {
        const d = new Date(now);
        d.setMonth(d.getMonth() - (bucketCount - 1 - i));
        d.setDate(1);
        return d;
      };
      formatLabel = (d) =>
        d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      break;
    }
    default: {
      // "max" — use all seed values, spread over months
      bucketCount = seedValues.length;
      getDate = (i) => {
        const d = new Date(now);
        d.setMonth(d.getMonth() - (bucketCount - 1 - i));
        d.setDate(1);
        return d;
      };
      formatLabel = (d) =>
        d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      break;
    }
  }

  const result: ChartDataPoint[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const date = getDate(i, bucketCount);
    const seedIdx = i % seedValues.length;
    result.push({
      value: seedValues[seedIdx],
      label: formatLabel(date),
    });
  }
  return result;
}

interface ReferralStatCardProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  unit: string;
  chartData: number[];
  isLoading?: boolean;
  className?: string;
}

const ReferralStatCard: React.FC<ReferralStatCardProps> = ({
  icon,
  label,
  value,
  unit,
  chartData,
  isLoading = false,
  className,
}) => {
  const [timeRange, setTimeRange] = useState("max");

  const dateChartData = useMemo(
    () => buildChartData(chartData, timeRange),
    [chartData, timeRange],
  );

  return (
    <div
      className={cn(
        "relative flex flex-col justify-between border-b xl:border-b-0 xl:border-r border-grey-dark-100 dark:border-black-900 last:border-b-0 xl:last:border-r-0 p-3 sm:px-5 sm:py-4",
        className,
      )}
    >
      {/* Header — Icon + Label left, Date filter right */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-primary-50 dark:text-primary-brand-dark [&>svg]:size-[18px]">
            {icon}
          </span>
          <p className="font-geist-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-50 dark:text-primary-brand-dark">
            {label}
          </p>
        </div>
        <HomepageChartSelect
          options={TIME_RANGE_OPTIONS}
          value={timeRange}
          onValueChange={setTimeRange}
        />
      </div>

      {/* Content: value left, chart right */}
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="flex flex-col items-start justify-end gap-[2px] shrink-0">
          {isLoading ? (
            <div className="flex h-[79px] flex-col justify-end gap-[6px]">
              <Skeleton width={72} height={16} className="rounded-md" />
              <Skeleton width={100} height={36} className="rounded-md" />
            </div>
          ) : value !== null && value !== undefined && value !== "" ? (
            <div className="relative">
              <span className="text-[40px] font-medium leading-[48px] tracking-[-0.8px] text-grey-10 dark:text-grey-light-100 font-geist">
                {value}
              </span>
              {unit && (
                <span className="ml-1 text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-grey-10 dark:text-grey-light-100">
                  {unit}
                </span>
              )}
            </div>
          ) : null}
        </div>

        <MiniBarChart
          data={dateChartData}
          height={79}
          isLoading={isLoading}
          tooltipLabel={label}
          className="max-w-[50%] flex-1"
        />
      </div>
    </div>
  );
};

export default ReferralStatCard;
