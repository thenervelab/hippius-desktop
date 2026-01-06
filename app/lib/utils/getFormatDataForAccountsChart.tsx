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
export const WEEKDAYS_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
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
  range: "last7days" | "last30days" | "last60days" | "year"
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

  if (range === "last7days") {
    const last7Days = new Date(now);
    last7Days.setDate(now.getDate() - 6);
    last7Days.setHours(0, 0, 0, 0);

    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(last7Days);
      d.setDate(last7Days.getDate() + i);
      return d;
    });

    return fillDataWithCarryForward(
      chartPoints,
      weekDates,
      (date) => WEEKDAYS_FULL[date.getDay()]
    ).map((pt) => ({
      ...pt,
      bandLabel: WEEKDAYS_FULL[pt.x.getDay()],
    }));
  }

  if (range === "last30days") {
    const last30Days = new Date(now);
    last30Days.setDate(now.getDate() - 29);
    last30Days.setHours(0, 0, 0, 0);

    const thirtyDaysDates = getAllDatesInRange(last30Days, now);
    return fillDataWithCarryForward(
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
    return fillDataWithCarryForward(
      chartPoints,
      sixtyDaysDates,
      (date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`
    );
  }

  if (range === "year") {
    // Create a monthly data map instead of using daily data
    const monthlyData: Map<string, ChartPoint> = new Map();

    // Process each data point to group by month-year
    chartPoints.forEach((point) => {
      const month = point.x.getMonth();
      const year = point.x.getFullYear();
      const key = `${year}-${String(month).padStart(2, "0")}`;

      if (
        !monthlyData.has(key) ||
        point.x > (monthlyData.get(key)?.x || new Date(0))
      ) {
        // Use the most recent data point for each month
        monthlyData.set(key, point);
      }
    });

    // Generate exactly 12 months of data, going back from today
    const result: ChartPoint[] = [];
    let lastPoint: ChartPoint | null = null;

    for (let i = 11; i >= 0; i--) {
      // Calculate date by working with year and month separately
      let targetYear = now.getFullYear();
      let targetMonth = now.getMonth() - i;

      // Handle month wrapping across year boundaries
      if (targetMonth < 0) {
        targetYear += Math.floor(targetMonth / 12);
        targetMonth = targetMonth % 12;
        if (targetMonth < 0) targetMonth += 12;
      }

      const key = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
      const monthDate = new Date(targetYear, targetMonth, 1);
      const monthLabel = MONTHS[targetMonth];

      // If we have data for this month, use it
      if (monthlyData.has(key)) {
        const monthPoint = monthlyData.get(key)!;
        lastPoint = monthPoint;
        result.push({
          ...monthPoint,
          x: monthDate,
          bandLabel: monthLabel,
          dayLabel: monthLabel,
        });
      } else {
        // Otherwise carry forward from the previous month
        result.push({
          x: monthDate,
          balance: lastPoint ? lastPoint.balance : 0,
          formattedBalance: lastPoint ? lastPoint.formattedBalance : "0",
          credit: lastPoint ? lastPoint.credit : 0,
          formattedCredit: lastPoint ? lastPoint.formattedCredit : "0",
          timestamp: lastPoint ? lastPoint.timestamp : "",
          dayLabel: monthLabel,
          bandLabel: monthLabel,
        });
      }
    }

    return result;
  }

  return chartPoints;
};
