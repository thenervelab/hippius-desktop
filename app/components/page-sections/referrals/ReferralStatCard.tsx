"use client";

import React, { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import MiniBarChart, { type ChartDataPoint } from "./MiniBarChart";
import Skeleton from "@/components/ui/SkeletonLoader";
import HomepageChartSelect from "@/components/ui/HomepageChartSelect";

/* Single stat card on the referrals dashboard. Restyled to match the
 * desktop card shell used by the wallet / billing widget cards:
 * rounded-[8px] outer border + mono uppercase header strip in
 * primary-40 + inner white panel with rounded top corners. */

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
      bucketCount = 30;
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
        "flex flex-col items-center w-full rounded-[8px] border overflow-hidden",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {/* Header strip — icon + uppercase label + range filter on the
          right. Mirrors the SettingsCard header dimensions. */}
      <div className="flex h-[38px] w-full items-center justify-between gap-2 pl-[14px] pr-[10px]">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-primary-40 dark:text-primary-brand-dark flex-shrink-0 inline-flex [&>svg]:size-[14px]">
            {icon}
          </span>
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase truncate">
            {label}
          </p>
        </div>
        <HomepageChartSelect
          options={TIME_RANGE_OPTIONS}
          value={timeRange}
          onValueChange={setTimeRange}
        />
      </div>

      {/* Inner white panel — number on the left, sparkline on the
          right, both aligned to the bottom edge so the headline reads
          like the wallet/billing balance cards. */}
      <div
        className={cn(
          "flex w-full flex-1 items-end justify-between gap-3",
          "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
          "p-3",
        )}
      >
        <div className="flex flex-col items-start justify-end gap-[2px] shrink-0">
          {isLoading ? (
            <div className="flex h-[79px] flex-col justify-end gap-[6px]">
              <Skeleton width={72} height={16} className="rounded-md" />
              <Skeleton width={100} height={36} className="rounded-md" />
            </div>
          ) : value !== null && value !== undefined && value !== "" ? (
            <div className="relative">
              <span className="font-mono font-medium text-[40px] leading-[48px] tracking-[-0.8px] text-grey-10 dark:text-white">
                {value}
              </span>
              {unit && (
                <span className="ml-1 font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50">
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
          className="max-w-[55%] flex-1"
        />
      </div>
    </div>
  );
};

export default ReferralStatCard;
