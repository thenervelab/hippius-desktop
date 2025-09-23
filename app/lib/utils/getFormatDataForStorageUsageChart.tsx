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

// New function: map actual storage bytes to dates with usage calculation
// This calculates daily/period usage consumption (how much was used each period)
// instead of showing cumulative totals
//
// Example:
// Input: Monday 4MB (cumulative), Tuesday 9MB (cumulative), Wednesday 20MB (cumulative)
// Output: Monday 4MB (usage), Tuesday 5MB (9-4), Wednesday 11MB (20-9)
export function mapBytesToDateRange(
  rawData: ChartPoint[],
  dateRange: Date[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  const dataByDate = new Map<string, number>();

  // Map cumulative storage by date
  rawData.forEach((d) => {
    const key = normalizeDate(d.x);
    const cumulativeBytes = d.balance; // This is cumulative storage

    // Keep the latest value for each date (in case of multiple entries)
    dataByDate.set(key, cumulativeBytes);
  });

  // Convert to sorted array for proper calculation
  const sortedEntries = Array.from(dataByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  // Create a map for quick lookup
  const sortedDataMap = new Map(sortedEntries);

  // For each date in the range, calculate usage for that period
  return dateRange.map((date, index) => {
    const key = normalizeDate(date);
    const currentCumulative = sortedDataMap.get(key) || 0;

    let usageForPeriod = 0;

    if (index === 0) {
      // For the first day, show the cumulative value as usage
      usageForPeriod = currentCumulative;
    } else {
      // Find the previous day's cumulative value
      const prevDate = new Date(date);
      prevDate.setDate(date.getDate() - 1);
      const prevKey = normalizeDate(prevDate);

      // Get previous cumulative value
      let prevCumulative = sortedDataMap.get(prevKey);

      // If no data for previous day, find the last available cumulative value
      if (prevCumulative === undefined) {
        prevCumulative = findLastCumulativeValue(sortedEntries, key);
      }

      // Calculate usage: current cumulative - previous cumulative
      usageForPeriod = Math.max(0, currentCumulative - prevCumulative);
    }

    return {
      balance: usageForPeriod,
      formattedBalance: formatBytes(usageForPeriod),
      timestamp: sortedDataMap.has(key) ? key : "",
      x: new Date(date),
      dayLabel: getLabel
        ? getLabel(date)
        : String(date.getDate()).padStart(2, "0"),
    };
  });
}

// Helper function to find the last available cumulative value before a given date
function findLastCumulativeValue(sortedEntries: [string, number][], currentDateKey: string): number {
  let lastCumulative = 0;

  for (const [dateKey, cumulative] of sortedEntries) {
    if (dateKey < currentDateKey) {
      lastCumulative = cumulative;
    } else {
      break;
    }
  }

  return lastCumulative;
}

// New function to aggregate bytes by month for year view with usage calculation
// This calculates monthly usage consumption instead of monthly deltas
export function aggregateBytesByMonth(chartPoints: ChartPoint[]): ChartPoint[] {
  if (!chartPoints || chartPoints.length === 0) {
    return [];
  }

  // Group cumulative storage by month (using the last day's value of each month)
  const monthlyCumulative = new Map<string, { cumulative: number; date: Date; month: number; year: number }>();

  chartPoints.forEach((point) => {
    const month = point.x.getMonth();
    const year = point.x.getFullYear();
    const key = `${year}-${month}`;

    // Always keep the latest value for each month (forward-filled data ensures this is the end-of-month value)
    const existing = monthlyCumulative.get(key);
    if (!existing || point.x.getTime() >= existing.date.getTime()) {
      monthlyCumulative.set(key, {
        cumulative: point.balance,
        date: point.x,
        month,
        year
      });
    }
  });

  // Convert to array and sort for proper calculation
  const sortedMonths = Array.from(monthlyCumulative.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, data]) => data.cumulative > 0); // Only include months with actual data

  // Calculate monthly usage consumption
  return sortedMonths.map(([, data], index) => {
    let monthlyUsage = data.cumulative;
    if (index > 0) {
      const prevCumulative = sortedMonths[index - 1][1].cumulative;
      monthlyUsage = Math.max(0, data.cumulative - prevCumulative);
    }

    return {
      balance: monthlyUsage,
      formattedBalance: formatBytes(monthlyUsage),
      timestamp: "",
      x: new Date(data.year, data.month, 1), // Use actual year and month from data
      dayLabel: MONTHS[data.month],
      bandLabel: MONTHS[data.month],
    };
  });
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

    // Create a map of actual data points
    const cumulativeByDate = new Map<string, number>();

    // Fill the map with only real data points
    chartPoints.forEach((point) => {
      const key = normalizeDate(point.x);
      cumulativeByDate.set(key, point.balance);
    });

    // Always show full year timeline from January to current month
    const startOfYear = new Date(currentYear, 0, 1);
    const fullYearDates = getAllDatesInRange(startOfYear, today);

    // Forward-fill cumulative values properly through the year
    let lastKnownCumulative = 0;
    let hasDataStarted = false;

    // Create daily chart points for the entire year
    const dailyCumulativePoints = fullYearDates.map((date) => {
      const key = normalizeDate(date);

      // If we have actual data for this date, use it
      if (cumulativeByDate.has(key)) {
        lastKnownCumulative = cumulativeByDate.get(key)!;
        hasDataStarted = true;
      }

      // Before data starts, use 0. After data starts, forward-fill
      const cumulativeValue = hasDataStarted ? lastKnownCumulative : 0;

      return {
        x: date,
        balance: cumulativeValue,
        formattedBalance: formatBytes(cumulativeValue),
        timestamp: key,
        dayLabel: MONTHS[date.getMonth()],
      };
    });

    // Aggregate by month - this will show all months from Jan to current month
    return aggregateBytesByMonthFullYear(dailyCumulativePoints);
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

  // Create monthly aggregation for all months from January to current month
  const monthlyData: ChartPoint[] = [];

  for (let monthIndex = 0; monthIndex <= currentMonth; monthIndex++) {
    // Find the last day of this month that has data
    const monthPoints = points.filter(point => point.x.getMonth() === monthIndex);

    if (monthPoints.length > 0) {
      // Use the last point of the month (highest cumulative value)
      const lastPointOfMonth = monthPoints[monthPoints.length - 1];

      // Calculate consumption for this month
      const prevMonthIndex = monthIndex - 1;
      let prevMonthCumulative = 0;

      if (prevMonthIndex >= 0) {
        const prevMonthPoints = points.filter(point => point.x.getMonth() === prevMonthIndex);
        if (prevMonthPoints.length > 0) {
          prevMonthCumulative = prevMonthPoints[prevMonthPoints.length - 1].balance;
        }
      }

      const consumption = lastPointOfMonth.balance - prevMonthCumulative;

      monthlyData.push({
        x: new Date(currentYear, monthIndex, 1),
        balance: Math.max(0, consumption), // Ensure non-negative consumption
        formattedBalance: formatBytes(Math.max(0, consumption)),
        timestamp: normalizeDate(new Date(currentYear, monthIndex, 1)),
        dayLabel: MONTHS[monthIndex],
      });
    } else {
      // No data for this month, show zero consumption
      monthlyData.push({
        x: new Date(currentYear, monthIndex, 1),
        balance: 0,
        formattedBalance: formatBytes(0),
        timestamp: normalizeDate(new Date(currentYear, monthIndex, 1)),
        dayLabel: MONTHS[monthIndex],
      });
    }
  }

  return monthlyData;
}
