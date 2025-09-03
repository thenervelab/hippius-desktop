import { Account } from "@/lib/types";
import { formatBytes } from "./formatBytes";

import {
  WEEKDAYS_SHORT,
  ChartPoint,
  MONTHS,
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

// Helper function to extract date from UTC timestamp string
function getDateFromUTCTimestamp(timestamp: string): Date {
  const utcDate = new Date(timestamp);
  // Extract just the date parts from the UTC timestamp
  return new Date(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth(),
    utcDate.getUTCDate()
  );
}

// New function: map actual storage bytes to dates
export function mapBytesToDateRange(
  rawData: ChartPoint[],
  dateRange: Date[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  const dataByDate = new Map<string, number>();

  // Map actual bytes used by date
  rawData.forEach((d) => {
    const key = normalizeDate(d.x);
    const bytes = d.balance; // This is the actual bytes used

    if (dataByDate.has(key)) {
      // If multiple entries for same date, sum them
      dataByDate.set(key, dataByDate.get(key)! + bytes);
    } else {
      dataByDate.set(key, bytes);
    }
  });

  // For each date in the range, use actual data or zero
  return dateRange.map((date) => {
    const key = normalizeDate(date);
    const bytes = dataByDate.get(key) || 0;

    return {
      balance: bytes,
      formattedBalance: formatBytes(bytes),
      timestamp: dataByDate.has(key) ? key : "",
      x: new Date(date),
      dayLabel: getLabel
        ? getLabel(date)
        : String(date.getDate()).padStart(2, "0"),
    };
  });
}

// New function to aggregate bytes by month for year view
export function aggregateBytesByMonth(chartPoints: ChartPoint[]): ChartPoint[] {
  if (!chartPoints || chartPoints.length === 0) {
    return [];
  }

  // Group bytes by month
  const monthlyBytes = new Map<string, number>();

  chartPoints.forEach((point) => {
    const month = point.x.getMonth();
    const year = point.x.getFullYear();
    const key = `${year}-${month}`;

    const currentBytes = monthlyBytes.get(key) || 0;
    monthlyBytes.set(key, currentBytes + point.balance);
  });

  // Convert to ChartPoint array
  return Array.from(monthlyBytes.entries())
    .map(([key, totalBytes]) => {
      const [year, month] = key.split("-").map(Number);
      return {
        balance: totalBytes,
        formattedBalance: formatBytes(totalBytes),
        timestamp: "",
        x: new Date(year, month, 1),
        dayLabel: MONTHS[month],
        bandLabel: MONTHS[month],
      };
    })
    .sort((a, b) => a.x.getTime() - b.x.getTime());
}

export const formatStorageForChartByRange = (
  accounts: Account[],
  range: "last7days" | "last30days" | "last60days" | "year"
): ChartPoint[] => {
  if (!accounts || accounts.length === 0) {
    return [];
  }

  const sortedAccounts = [...accounts].sort(
    (a, b) =>
      new Date(a.processed_timestamp).getTime() -
      new Date(b.processed_timestamp).getTime()
  );

  // Convert accounts to ChartPoints with proper date extraction
  const chartPoints: ChartPoint[] = sortedAccounts.map((acc) => {
    // Use the new helper to properly extract date from UTC timestamp
    const normalizedDate = getDateFromUTCTimestamp(acc.processed_timestamp);

    return {
      x: normalizedDate,
      balance: Number(acc.total_balance), // Using the raw bytes value
      formattedBalance: formatBytes(Number(acc.total_balance)),
      timestamp: acc.processed_timestamp,
      dayLabel: String(normalizedDate.getDate()).padStart(2, "0"),
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
      (date) => WEEKDAYS_SHORT[date.getDay()]
    ).map((point) => ({
      ...point,
      bandLabel: WEEKDAYS_SHORT[point.x.getDay()],
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
    const year = now.getFullYear();
    const start = new Date(year, 0, 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all daily data for the year
    const yearDates = getAllDatesInRange(start, today);
    const dailyChartPoints = mapBytesToDateRange(
      chartPoints,
      yearDates,
      (date) => MONTHS[date.getMonth()]
    );

    // Aggregate by month for year view
    return aggregateBytesByMonth(dailyChartPoints);
  }

  return chartPoints;
};
