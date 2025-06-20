import { Account } from "../types";
import { formatBalance } from "../utils";

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

// The main utility for forward-filling ChartPoint[]
export function fillDataWithCarryForward(
  rawData: ChartPoint[],
  dateRange: Date[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  const dataByDate = new Map<string, ChartPoint>();
  rawData.forEach((d) => {
    const key = d.x.toISOString().slice(0, 10);
    dataByDate.set(key, d);
  });

  // Find the last available value before the first date in dateRange
  let last: ChartPoint | null = null;
  const rangeStart = dateRange[0];

  // Go through all data points BEFORE rangeStart, set last to the most recent
  for (const d of rawData) {
    if (d.x < rangeStart && (!last || d.x > last.x)) {
      last = d;
    }
  }

  // Now do the regular carry-forward logic
  return dateRange.map((date) => {
    const key = date.toISOString().slice(0, 10);
    if (dataByDate.has(key)) {
      last = dataByDate.get(key)!;
      return {
        ...last,
        x: new Date(date),
        dayLabel: getLabel ? getLabel(date) : last.dayLabel,
      };
    }
    return {
      balance: last ? last.balance : 0,
      formattedBalance: last ? last.formattedBalance : "0",
      timestamp: last ? last.timestamp : "",
      x: new Date(date),
      dayLabel: getLabel
        ? getLabel(date)
        : date.getDate().toString().padStart(2, "0"),
    };
  });
}

export const formatAccountsForChartByRange = (
  accounts: Account[],
  range: "week" | "month" | "quarter" | "year"
): ChartPoint[] => {
  if (!accounts || accounts.length === 0) {
    return [];
  }
  const sortedAccounts = [...accounts].sort(
    (a, b) =>
      new Date(a.processed_timestamp).getTime() -
      new Date(b.processed_timestamp).getTime()
  );

  // Prepare ChartPoints
  const chartPoints: ChartPoint[] = sortedAccounts.map((acc) => {
    const d = new Date(acc.processed_timestamp);
    d.setHours(0, 0, 0, 0);
    return {
      x: d,
      balance: Number(acc.total_balance) / Math.pow(10, 18),
      formattedBalance: formatBalance(acc.total_balance, 6),
      timestamp: acc.processed_timestamp,
      dayLabel: String(d.getDate()).padStart(2, "0"),
    };
  });

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (range === "week") {
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() - (6 - i));
    return d;
  });

  return fillDataWithCarryForward(
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
    return fillDataWithCarryForward(chartPoints, monthDates, (date) =>
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
    return fillDataWithCarryForward(
      chartPoints,
      quarterDates,
      (date) =>
        `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}`
    );
  }

  if (range === "year") {
    const year = now.getFullYear();
    const start = new Date(year, 0, 1); // Always Jan 1 of this year
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build all dates from Jan 1 to today
    const yearDates = getAllDatesInRange(start, today);

    // This will fill with 0s up to the first available data, then carry forward as usual
    return fillDataWithCarryForward(
      chartPoints,
      yearDates,
      (date) => MONTHS[date.getMonth()]
    ).map((point) => ({
      ...point,
      bandLabel: MONTHS[point.x.getMonth()],
    }));
  }

  return chartPoints;
};
