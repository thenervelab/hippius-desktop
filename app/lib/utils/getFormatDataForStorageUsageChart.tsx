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

// Convert cumulative storage values to daily usage values
// Input: Day1=4MB(cumulative), Day2=9MB(cumulative), Day3=19MB(cumulative)  
// Output: Day1=4MB(usage), Day2=5MB(9-4), Day3=10MB(19-9)
export function mapBytesToDateRange(
  rawData: ChartPoint[],
  dateRange: Date[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  // Step 1: Get all cumulative data points sorted by date
  const cumulativeData = rawData
    .map(d => ({
      date: normalizeDate(d.x),
      cumulative: d.balance,
      originalDate: d.x
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Create a map for quick lookups
  const cumulativeMap = new Map<string, number>();
  cumulativeData.forEach(({ date, cumulative }) => {
    cumulativeMap.set(date, cumulative);
  });

  // Step 2: For each date in range, calculate daily usage
  return dateRange.map((date) => {
    const key = normalizeDate(date);
    const currentCumulative = cumulativeMap.get(key) || 0;

    // Find the previous day's cumulative value (even if it's before our date range)
    const prevDate = new Date(date);
    prevDate.setDate(date.getDate() - 1);
    const prevKey = normalizeDate(prevDate);

    // Look for previous day's cumulative value
    let previousCumulative = 0;

    // Check if we have data for the previous day
    if (cumulativeMap.has(prevKey)) {
      previousCumulative = cumulativeMap.get(prevKey)!;
    } else {
      // If no data for previous day, find the last cumulative value before this date
      // by looking through all available data
      for (const { date: dataDate, cumulative } of cumulativeData) {
        if (dataDate < key) {
          previousCumulative = cumulative;
        } else {
          break; // Since data is sorted, we can stop here
        }
      }
    }

    // Calculate daily usage
    let dailyUsage = 0;

    if (currentCumulative > 0) {
      // If we have data for current date, calculate difference
      dailyUsage = currentCumulative - previousCumulative;
    }
    // If no data for current date, dailyUsage remains 0

    return {
      balance: Math.max(0, dailyUsage), // Ensure non-negative
      formattedBalance: formatBytes(Math.max(0, dailyUsage)),
      timestamp: cumulativeMap.has(key) ? key : "",
      x: new Date(date),
      dayLabel: getLabel
        ? getLabel(date)
        : String(date.getDate()).padStart(2, "0"),
    };
  });
}

// New function to aggregate bytes by month for year view with usage calculation
// This calculates monthly usage consumption instead of monthly deltas
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

    // Sum up all daily usage for each month
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
        dayLabel: MONTHS[month],
        bandLabel: MONTHS[month],
      };
    })
    .sort((a, b) => a.x.getTime() - b.x.getTime());
}

// Main function to format storage data for charts
// Returns daily/monthly usage consumption instead of cumulative values
// Shows how much storage was consumed (used) each day/month
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

  // Convert accounts to ChartPoints with cumulative values
  // Keep cumulative values for proper usage calculation
  const chartPoints: ChartPoint[] = sortedAccounts.map((acc) => {
    const normalizedDate = getDateFromUTCTimestamp(acc.processed_timestamp);

    return {
      x: normalizedDate,
      balance: Number(acc.total_balance), // Cumulative storage balance
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentYear = today.getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const fullYearDates = getAllDatesInRange(startOfYear, today);

    // Convert cumulative data to daily usage for the entire year
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
function aggregateBytesByMonthFullYear(
  points: ChartPoint[]
): ChartPoint[] {
  if (points.length === 0) return [];

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth(); // 0-based (0 = January, 8 = September)

  // Group daily usage by month and sum them up
  const monthlyUsage = new Map<number, number>();

  // Sum up daily usage values for each month
  points.forEach(point => {
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
      dayLabel: MONTHS[monthIndex],
      bandLabel: MONTHS[monthIndex],
    });
  }

  return monthlyData;
}
