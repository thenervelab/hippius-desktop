import { Account } from "@/lib/types";
import { formatBytes } from "./formatBytes";

import {
  WEEKDAYS_FULL,
  ChartPoint,
  MONTHS,
  MONTHS_FULL,
} from "./getFormatDataForCreditsUsageChart";

// Helper: get all dates in a range (inclusive)
export function getAllDatesInRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const curr = new Date(start);
  curr.setHours(0, 0, 0, 0);
  while (curr <= end) {
    dates.push(new Date(curr));
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

// Helper function to normalize a date to YYYY-MM-DD format for consistent comparison
function normalizeDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

// Map daily usage data to date range
// - If data exists for a day, use it
// - If no data for a day, use the last known value (forward-fill)
// - If date is before first data point, use 0
export function mapBytesToDateRange(
  rawData: ChartPoint[],
  dateRange: Date[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  // Create a map of date -> usage for quick lookups
  const usageMap = new Map<string, number>();
  rawData.forEach((point) => {
    const key = normalizeDate(point.x);
    usageMap.set(key, point.balance);
  });

  // Track the last known value for forward-filling
  let lastKnownValue = 0;
  let hasSeenData = false;

  // Map each date in range
  return dateRange.map((date) => {
    const key = normalizeDate(date);

    if (usageMap.has(key)) {
      // Data exists for this date, use it
      const usage = usageMap.get(key) || 0;
      lastKnownValue = usage;
      hasSeenData = true;

      return {
        balance: usage,
        formattedBalance: formatBytes(usage),
        timestamp: key,
        x: new Date(date),
        dayLabel: getLabel
          ? getLabel(date)
          : String(date.getDate()).padStart(2, "0"),
      };
    } else {
      // No data for this date
      // If we've seen data before, forward-fill with last known value
      // Otherwise, use 0 (dates before first data point)
      const valueToUse = hasSeenData ? lastKnownValue : 0;

      return {
        balance: valueToUse,
        formattedBalance: formatBytes(valueToUse),
        timestamp: "",
        x: new Date(date),
        dayLabel: getLabel
          ? getLabel(date)
          : String(date.getDate()).padStart(2, "0"),
      };
    }
  });
}

// Aggregate daily usage by month
export function aggregateBytesByMonth(chartPoints: ChartPoint[]): ChartPoint[] {
  if (!chartPoints || chartPoints.length === 0) {
    return [];
  }

  // Group daily usage by month and sum them up
  const monthlyUsage = new Map<string, number>();

  chartPoints.forEach((point) => {
    const month = point.x.getMonth();
    const year = point.x.getFullYear();
    const key = `${year}-${month}`;

    const currentUsage = monthlyUsage.get(key) || 0;
    monthlyUsage.set(key, currentUsage + point.balance);
  });

  // Convert to ChartPoint array and sort
  return Array.from(monthlyUsage.entries())
    .map(([key, totalUsage]) => {
      const [year, month] = key.split("-").map(Number);
      return {
        balance: totalUsage,
        formattedBalance: formatBytes(totalUsage),
        timestamp: "",
        x: new Date(year, month, 1),
        dayLabel: MONTHS_FULL[month],
        bandLabel: MONTHS_FULL[month],
      };
    })
    .sort((a, b) => a.x.getTime() - b.x.getTime());
}

// Main function to format storage data for charts
// Data is already daily usage per row, just filter by range and fill missing days with zero
export const formatStorageForChartByRange = (
  accounts: Account[],
  range: "last7days" | "last30days" | "last60days" | "year"
): ChartPoint[] => {
  if (!accounts || accounts.length === 0) {
    return [];
  }

  // Convert accounts to ChartPoints (data is already daily usage, date is already UTC)
  const chartPoints: ChartPoint[] = accounts.map((acc) => {
    const date = new Date(acc.processed_timestamp);

    return {
      x: date,
      balance: Number(acc.total_balance),
      formattedBalance: formatBytes(Number(acc.total_balance)),
      timestamp: acc.processed_timestamp,
      dayLabel: String(date.getUTCDate()).padStart(2, "0"),
    };
  });

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (range === "last7days") {
    const last7Days = new Date(now);
    last7Days.setDate(now.getDate() - 6);
    last7Days.setHours(0, 0, 0, 0);

    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(last7Days);
      d.setDate(last7Days.getDate() + i);
      return d;
    });

    return mapBytesToDateRange(
      chartPoints,
      weekDates,
      (date) => WEEKDAYS_FULL[date.getDay()]
    ).map((point) => ({
      ...point,
      bandLabel: WEEKDAYS_FULL[point.x.getDay()],
    }));
  }

  if (range === "last30days") {
    const last30Days = new Date(now);
    last30Days.setDate(now.getDate() - 29);
    last30Days.setHours(0, 0, 0, 0);

    const thirtyDaysDates = getAllDatesInRange(last30Days, now);
    return mapBytesToDateRange(
      chartPoints,
      thirtyDaysDates,
      (date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`
    );
  }

  if (range === "last60days") {
    const last60Days = new Date(now);
    last60Days.setDate(now.getDate() - 59);
    last60Days.setHours(0, 0, 0, 0);

    const sixtyDaysDates = getAllDatesInRange(last60Days, now);
    return mapBytesToDateRange(
      chartPoints,
      sixtyDaysDates,
      (date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`
    );
  }

  if (range === "year") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentYear = today.getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const fullYearDates = getAllDatesInRange(startOfYear, today);

    // Map daily usage data to full year dates (fill missing days with zero)
    const dailyUsagePoints = mapBytesToDateRange(
      chartPoints,
      fullYearDates,
      (date) => MONTHS[date.getMonth()]
    );

    // Aggregate daily usage by month
    return aggregateBytesByMonthFullYear(dailyUsagePoints);
  }

  return chartPoints;
};

// Get the last (most recent) value for each month - no summing
function aggregateBytesByMonthFullYear(points: ChartPoint[]): ChartPoint[] {
  if (points.length === 0) return [];

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth();

  // Store the last value seen for each month (latest day of the month)
  const monthlyLastValue = new Map<number, number>();

  points.forEach((point) => {
    const month = point.x.getMonth();
    // Always update with the current value - the last iteration will be the latest day
    monthlyLastValue.set(month, point.balance);
  });

  // Create monthly data for all months from January to current month
  const monthlyData: ChartPoint[] = [];
  let lastKnownValue = 0;

  for (let monthIndex = 0; monthIndex <= currentMonth; monthIndex++) {
    // Use the last value of the month if available, otherwise forward-fill
    const monthValue = monthlyLastValue.has(monthIndex)
      ? monthlyLastValue.get(monthIndex)!
      : lastKnownValue;

    lastKnownValue = monthValue;

    monthlyData.push({
      x: new Date(currentYear, monthIndex, 1),
      balance: monthValue,
      formattedBalance: formatBytes(monthValue),
      timestamp: normalizeDate(new Date(currentYear, monthIndex, 1)),
      dayLabel: MONTHS_FULL[monthIndex],
      bandLabel: MONTHS_FULL[monthIndex],
    });
  }

  return monthlyData;
}
