// getFormatDataForAccountsChart.tsx
import { Account } from "@/lib/types";
import { formatBalance } from "./formatters/formatBalance";

export interface ChartPoint {
  x: Date;
  balance: number;
  formattedBalance: string;
  credit: number;
  formattedCredit: string;
  timestamp: string;
  dayLabel: string;
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

export function fillDataWithCarryForward(
  rawData: ChartPoint[],
  dateRange: Date[],
  getLabel?: (date: Date) => string
): ChartPoint[] {
  const dataByDate = new Map<string, ChartPoint>();
  rawData.forEach((d) => {
    dataByDate.set(d.x.toISOString().slice(0, 10), d);
  });

  let last: ChartPoint | null = null;
  const rangeStart = dateRange[0];
  for (const d of rawData) {
    if (d.x < rangeStart && (!last || d.x > last.x)) last = d;
  }

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
      credit: last ? last.credit : 0,
      formattedCredit: last ? last.formattedCredit : "0",
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
  if (!accounts?.length) return [];

  const sorted = [...accounts].sort(
    (a, b) =>
      new Date(a.processed_timestamp).getTime() -
      new Date(b.processed_timestamp).getTime()
  );

  const chartPoints: ChartPoint[] = sorted.map((acc) => {
    const d = new Date(acc.processed_timestamp);
    d.setHours(0, 0, 0, 0);
    return {
      x: d,
      balance: Number(acc.total_balance) / 1e18,
      formattedBalance: formatBalance(acc.total_balance, 6),
      credit: acc.credit ? Number(acc.credit) / 1e18 : 0,
      formattedCredit: acc.credit
        ? formatBalance(acc.credit, 6)
        : formatBalance("0", 6),
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
    ).map((pt) => ({
      ...pt,
      bandLabel: WEEKDAYS_SHORT[pt.x.getDay()],
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
    const q = Math.floor(now.getMonth() / 3) * 3;
    const start = new Date(now.getFullYear(), q, 1);
    const end = new Date(now.getFullYear(), q + 3, 0);
    const quarterDates = getAllDatesInRange(start, end);
    return fillDataWithCarryForward(
      chartPoints,
      quarterDates,
      (date) =>
        `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}`
    );
  }

  if (range === "year") {
    // Create a monthly data map instead of using daily data
    const monthlyData: Map<number, ChartPoint> = new Map();

    // Process each data point to group by month
    chartPoints.forEach((point) => {
      const month = point.x.getMonth();

      if (
        !monthlyData.has(month) ||
        point.x > (monthlyData.get(month)?.x || new Date(0))
      ) {
        // Use the most recent data point for each month
        monthlyData.set(month, {
          ...point,
          bandLabel: MONTHS[month],
        });
      }
    });

    // Create a point for each month of the year up to current month
    const result: ChartPoint[] = [];
    for (let m = 0; m <= now.getMonth(); m++) {
      const monthDate = new Date(now.getFullYear(), m, 1);

      // If we have data for this month, use it
      if (monthlyData.has(m)) {
        result.push(monthlyData.get(m)!);
      } else {
        // Otherwise carry forward from the previous month
        const lastPoint = result.length > 0 ? result[result.length - 1] : null;
        result.push({
          x: monthDate,
          balance: lastPoint ? lastPoint.balance : 0,
          formattedBalance: lastPoint ? lastPoint.formattedBalance : "0",
          credit: lastPoint ? lastPoint.credit : 0,
          formattedCredit: lastPoint ? lastPoint.formattedCredit : "0",
          timestamp: lastPoint ? lastPoint.timestamp : "",
          dayLabel: MONTHS[m],
          bandLabel: MONTHS[m],
        });
      }
    }

    return result;
  }

  return chartPoints;
};
