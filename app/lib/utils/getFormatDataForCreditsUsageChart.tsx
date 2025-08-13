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
  const dataByDate = new Map<string, number>();

  // Map actual credits used by date
  rawData.forEach((d) => {
    const key = normalizeDate(d.x);
    const credits = d.balance; // This is the actual credits used

    if (dataByDate.has(key)) {
      // If multiple entries for same date, sum them
      dataByDate.set(key, dataByDate.get(key)! + credits);
    } else {
      dataByDate.set(key, credits);
    }
  });

  // For each date in the range, use actual data or zero
  return dateRange.map((date) => {
    const key = normalizeDate(date);
    const credits = dataByDate.get(key) || 0;

    return {
      balance: credits,
      formattedBalance: formatBalance(
        (credits * Math.pow(10, 18)).toString(),
        6
      ),
      timestamp: dataByDate.has(key) ? key : "",
      x: new Date(date),
      dayLabel: getLabel
        ? getLabel(date)
        : String(date.getDate()).padStart(2, "0"),
    };
  });
}

// New function to aggregate credits by month for year view
export function aggregateCreditsByMonth(
  chartPoints: ChartPoint[]
): ChartPoint[] {
  if (!chartPoints || chartPoints.length === 0) {
    return [];
  }

  // Group credits by month
  const monthlyCredits = new Map<string, number>();

  chartPoints.forEach((point) => {
    const month = point.x.getMonth();
    const year = point.x.getFullYear();
    const key = `${year}-${month}`;

    const currentCredits = monthlyCredits.get(key) || 0;
    monthlyCredits.set(key, currentCredits + point.balance);
  });

  // Convert to ChartPoint array
  return Array.from(monthlyCredits.entries())
    .map(([key, totalCredits]) => {
      const [year, month] = key.split("-").map(Number);
      return {
        balance: totalCredits,
        formattedBalance: formatBalance(
          (totalCredits * Math.pow(10, 18)).toString(),
          6
        ),
        timestamp: "",
        x: new Date(year, month, 1),
        dayLabel: MONTHS[month],
        bandLabel: MONTHS[month],
      };
    })
    .sort((a, b) => a.x.getTime() - b.x.getTime());
}

export const formatAccountsForChartByRange = (
  accounts: Account[],
  range: "week" | "month" | "lastMonth" | "quarter" | "year"
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

  if (range === "week") {
    const currentDay = now.getDay(); // 0 is Sunday, 1 is Monday, etc.
    const diff = now.getDate() - currentDay + (currentDay === 0 ? -6 : 1); // Adjust when day is Sunday
    const monday = new Date(now);
    monday.setDate(diff);
    monday.setHours(0, 0, 0, 0);

    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });

    return mapCreditsToDateRange(
      chartPoints,
      weekDates,
      (date) => WEEKDAYS_SHORT[date.getDay()]
    ).map((point) => ({
      ...point,
      bandLabel: WEEKDAYS_SHORT[point.x.getDay()],
    }));
  }

  if (range === "month") {
    const year = now.getFullYear();
    const month = now.getMonth();
    const today = now.getDate();
    const monthDates = Array.from(
      { length: today },
      (_, i) => new Date(year, month, i + 1)
    );
    return mapCreditsToDateRange(chartPoints, monthDates, (date) =>
      String(date.getDate()).padStart(2, "0")
    );
  }

  if (range === "lastMonth") {
    const lastMonth = new Date(now);
    lastMonth.setMonth(now.getMonth() - 1);

    const year = lastMonth.getFullYear();
    const month = lastMonth.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const monthDates = Array.from(
      { length: daysInMonth },
      (_, i) => new Date(year, month, i + 1)
    );

    return mapCreditsToDateRange(chartPoints, monthDates, (date) =>
      String(date.getDate()).padStart(2, "0")
    );
  }

  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const startMonth = q * 3;
    const year = now.getFullYear();
    const start = new Date(year, startMonth, 1);
    const end = new Date(year, startMonth + 3, 0);
    const quarterDates = getAllDatesInRange(start, end);
    return mapCreditsToDateRange(
      chartPoints,
      quarterDates,
      (date) =>
        `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}`
    );
  }

  if (range === "year") {
    const year = now.getFullYear();
    const start = new Date(year, 0, 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all daily data for the year
    const yearDates = getAllDatesInRange(start, today);
    const dailyChartPoints = mapCreditsToDateRange(
      chartPoints,
      yearDates,
      (date) => MONTHS[date.getMonth()]
    );

    // Aggregate by month for year view
    return aggregateCreditsByMonth(dailyChartPoints);
  }

  return chartPoints;
};
