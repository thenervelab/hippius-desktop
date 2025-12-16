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

// Map daily usage data to date range, filling missing days with zero
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

  // Map each date in range, using actual data or zero for missing days
  return dateRange.map((date) => {
    const key = normalizeDate(date);
    const usage = usageMap.get(key) || 0;

    return {
      balance: usage,
      formattedBalance: formatBytes(usage),
      timestamp: usageMap.has(key) ? key : "",
      x: new Date(date),
      dayLabel: getLabel
        ? getLabel(date)
        : String(date.getDate()).padStart(2, "0"),
    };
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

// Aggregate by month but always show full year (Jan to current month)
function aggregateBytesByMonthFullYear(points: ChartPoint[]): ChartPoint[] {
  if (points.length === 0) return [];

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth();

  // Group daily usage by month and sum them up
  const monthlyUsage = new Map<number, number>();

  points.forEach((point) => {
    const month = point.x.getMonth();
    const currentUsage = monthlyUsage.get(month) || 0;
    monthlyUsage.set(month, currentUsage + point.balance);
  });

  // Create monthly data for all months from January to current month
  const monthlyData: ChartPoint[] = [];

  for (let monthIndex = 0; monthIndex <= currentMonth; monthIndex++) {
    const totalUsage = monthlyUsage.get(monthIndex) || 0;

    monthlyData.push({
      x: new Date(currentYear, monthIndex, 1),
      balance: totalUsage,
      formattedBalance: formatBytes(totalUsage),
      timestamp: normalizeDate(new Date(currentYear, monthIndex, 1)),
      dayLabel: MONTHS_FULL[monthIndex],
      bandLabel: MONTHS_FULL[monthIndex],
    });
  }

  return monthlyData;
}
