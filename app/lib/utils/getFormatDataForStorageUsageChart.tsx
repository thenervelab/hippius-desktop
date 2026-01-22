import { getHippiusCreationDate } from "@/lib/constants/hippius-dates";
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
  allHistoricalData: ChartPoint[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  if (!dateRange.length) {
    return [];
  }

  // Create a map of date -> usage for quick lookups
  const usageMap = new Map<string, number>();
  rawData.forEach((point) => {
    const key = normalizeDate(point.x);
    usageMap.set(key, point.balance);
  });

  const firstDateKey = normalizeDate(dateRange[0]);
  let lastKnownValue = 0;

  for (const point of allHistoricalData) {
    const pointKey = normalizeDate(point.x);
    if (pointKey <= firstDateKey) {
      lastKnownValue = Math.max(lastKnownValue, point.balance);
    }
  }

  // Map each date in range
  return dateRange.map((date) => {
    const key = normalizeDate(date);

    if (usageMap.has(key)) {
      // Data exists for this date, use it
      const usage = usageMap.get(key) || 0;
      lastKnownValue = usage;

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
      return {
        balance: lastKnownValue,
        formattedBalance: formatBytes(lastKnownValue),
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
  range: "last7days" | "last30days" | "last60days" | "year" | "max"
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
      chartPoints,
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
      chartPoints,
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
      chartPoints,
      (date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`
    );
  }

  if (range === "year") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lastYear = new Date(today);
    lastYear.setFullYear(today.getFullYear() - 1);

    const yearDates = getAllDatesInRange(lastYear, today);
    return mapBytesToDateRange(
      chartPoints,
      yearDates,
      chartPoints,
      (date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`
    );
  }

  if (range === "max") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startDate = getHippiusCreationDate();
    const maxDates = getAllDatesInRange(startDate, today);
    return mapBytesToDateRange(
      chartPoints,
      maxDates,
      chartPoints,
      (date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`
    );
  }

  return chartPoints;
};

// Get the last (most recent) value for each month for the last 12 months
// Ensures all 12 months are represented even if some have no data
function aggregateBytesByMonthLast12Months(points: ChartPoint[]): ChartPoint[] {
  if (points.length === 0) return [];

  const today = new Date();

  // Store the last value seen for each month
  const monthlyLastValue = new Map<string, number>();

  points.forEach((point) => {
    const month = point.x.getMonth();
    const year = point.x.getFullYear();
    const key = `${year}-${String(month).padStart(2, "0")}`;
    // Always update with the current value - the last iteration will be the latest day
    monthlyLastValue.set(key, point.balance);
  });

  // Generate exactly 12 months of data, going back from today
  const monthlyData: ChartPoint[] = [];
  let lastKnownValue = 0;

  for (let i = 11; i >= 0; i--) {
    // Calculate date by working with year and month separately
    let targetYear = today.getFullYear();
    let targetMonth = today.getMonth() - i;

    // Handle month wrapping across year boundaries
    if (targetMonth < 0) {
      targetYear += Math.floor(targetMonth / 12);
      targetMonth = targetMonth % 12;
      if (targetMonth < 0) targetMonth += 12;
    }

    const key = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;

    // Use actual value if available, otherwise carry forward last known
    if (monthlyLastValue.has(key)) {
      lastKnownValue = monthlyLastValue.get(key)!;
    }

    const monthLabel = MONTHS[targetMonth];
    const monthDate = new Date(targetYear, targetMonth, 1);

    monthlyData.push({
      x: monthDate,
      balance: lastKnownValue,
      formattedBalance: formatBytes(lastKnownValue),
      timestamp: normalizeDate(monthDate),
      dayLabel: monthLabel,
      bandLabel: monthLabel,
    });
  }

  return monthlyData;
}
