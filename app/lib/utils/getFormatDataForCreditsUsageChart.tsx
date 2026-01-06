import { Account } from "@/lib/types";
import { formatBalance } from "./formatters/formatBalance";

export interface ChartPoint {
  x: Date; // Date/day label for x-axis
  balance: number; // Numerical balance for y-axis calculations
  formattedBalance: string; // User-friendly formatted balance
  timestamp: string; // Original timestamp (or "")
  dayLabel: string; // "Monday", ...
  bandLabel?: string;
}

export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const MONTHS = [
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

export const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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

// New function: map actual credit usage to dates
export function mapCreditsToDateRange(
  rawData: ChartPoint[],
  dateRange: Date[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  const dataByDate = new Map<string, ChartPoint>();

  // Map data by date (rawData already contains cumulative values)
  rawData.forEach((d) => {
    const key = normalizeDate(d.x);
    dataByDate.set(key, d);
  });

  // For each date in the range, use actual cumulative data or carry forward previous day's value
  let lastKnownBalance = 0;
  return dateRange.map((date) => {
    const key = normalizeDate(date);
    const hasData = dataByDate.has(key);

    // If we have data for this date, use it (it's already cumulative)
    if (hasData) {
      lastKnownBalance = dataByDate.get(key)!.balance;
    }
    // If no data, carry forward the previous cumulative balance

    return {
      balance: lastKnownBalance,
      formattedBalance: formatBalance(
        (lastKnownBalance * Math.pow(10, 18)).toString(),
        6
      ),
      timestamp: hasData ? key : "",
      x: new Date(date),
      dayLabel: getLabel
        ? getLabel(date)
        : String(date.getDate()).padStart(2, "0"),
    };
  });
}

// New function to aggregate credits by month for year view
// Takes the LAST cumulative value from each month (not sum)
// Ensures all 12 months are represented even if some have no data
export function aggregateCreditsByMonth(
  chartPoints: ChartPoint[]
): ChartPoint[] {
  if (!chartPoints || chartPoints.length === 0) {
    return [];
  }

  const today = new Date();

  // Group by month-year and keep track of the LAST (cumulative) value for each month
  const monthlyLastValues = new Map<string, number>();

  chartPoints.forEach((point) => {
    const month = point.x.getMonth();
    const year = point.x.getFullYear();
    const key = `${year}-${String(month).padStart(2, "0")}`;

    // Always update to the latest point in this month (which has cumulative value)
    monthlyLastValues.set(key, point.balance);
  });

  // Generate exactly 12 months of data, going back from today
  const monthlyData: ChartPoint[] = [];
  let lastKnownBalance = 0;

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
    if (monthlyLastValues.has(key)) {
      lastKnownBalance = monthlyLastValues.get(key)!;
    }

    const monthLabel = MONTHS[targetMonth];
    const monthDate = new Date(targetYear, targetMonth, 1);

    monthlyData.push({
      balance: lastKnownBalance,
      formattedBalance: formatBalance(
        (lastKnownBalance * Math.pow(10, 18)).toString(),
        6
      ),
      timestamp: "",
      x: monthDate,
      dayLabel: monthLabel,
      bandLabel: monthLabel,
    });
  }

  return monthlyData;
}

export const formatAccountsForChartByRange = (
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
      balance: Number(acc.total_balance) / Math.pow(10, 18), // Actual credits used
      formattedBalance: formatBalance(acc.total_balance, 6),
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

    return mapCreditsToDateRange(
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
    return mapCreditsToDateRange(
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
    return mapCreditsToDateRange(
      chartPoints,
      sixtyDaysDates,
      (date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`
    );
  }

  if (range === "year") {
    // Last exactly 12 months from today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const twelveMonthsAgo = new Date(today);
    twelveMonthsAgo.setFullYear(today.getFullYear() - 1);

    // Get all daily data for the last 12 months
    const last12MonthsDates = getAllDatesInRange(twelveMonthsAgo, today);
    const dailyChartPoints = mapCreditsToDateRange(
      chartPoints,
      last12MonthsDates,
      (date) => MONTHS[date.getMonth()]
    );

    // Aggregate by month for year view
    return aggregateCreditsByMonth(dailyChartPoints);
  }

  return chartPoints;
};
