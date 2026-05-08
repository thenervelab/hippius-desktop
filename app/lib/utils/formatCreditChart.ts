import { ChartPoint } from "@/lib/types/chartTypes";

/** Minimal shape needed by the chart pipeline — any credit-like object works. */
export type CreditLike = { amount: string; date: string };

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function normalizeDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getAllDatesInRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const curr = new Date(start);
  curr.setHours(0, 0, 0, 0);
  while (curr <= end) {
    dates.push(new Date(curr));
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

function addYearSuffixIfDuplicate(points: ChartPoint[]): string[] {
  const monthLabels = points.map((p) => MONTHS[new Date(p.x).getMonth()]);
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const label of monthLabels) {
    if (seen.has(label)) { hasDuplicate = true; break; }
    seen.add(label);
  }
  if (!hasDuplicate) return monthLabels;
  return points.map((p) => {
    const d = new Date(p.x);
    return `${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(-2)}`;
  });
}

/** Build cumulative daily ChartPoints from raw per-event credit data */
function buildCumulativeChartPoints(credits: CreditLike[]): ChartPoint[] {
  // Group amounts by day
  const byDay = new Map<string, number>();
  for (const c of credits) {
    const date = new Date(c.date);
    if (isNaN(date.getTime())) continue;
    const key = normalizeDate(date);
    byDay.set(key, (byDay.get(key) ?? 0) + (parseFloat(c.amount) || 0));
  }

  // Build cumulative series
  let cumulative = 0;
  return Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, amount]) => {
      cumulative += amount;
      return {
        x: key,
        balance: cumulative,
        formattedBalance: cumulative.toFixed(4),
        timestamp: key,
        dayLabel: String(new Date(key).getDate()).padStart(2, "0"),
      };
    });
}

/** Forward-fill cumulative chart data across a date range */
function mapToDateRange(
  chartPoints: ChartPoint[],
  dateRange: Date[],
  allPoints: ChartPoint[],
  getLabel: (date: Date) => string,
): ChartPoint[] {
  if (!dateRange.length) return [];

  const dataByDate = new Map<string, ChartPoint>();
  for (const p of chartPoints) dataByDate.set(p.x, p);

  // Find last known balance before the window starts
  const firstKey = normalizeDate(dateRange[0]);
  let lastKnown = 0;
  for (const p of allPoints) {
    if (p.x <= firstKey) lastKnown = Math.max(lastKnown, p.balance);
  }

  return dateRange.map((date) => {
    const key = normalizeDate(date);
    const hasData = dataByDate.has(key);
    if (hasData) lastKnown = dataByDate.get(key)!.balance;
    return {
      x: key,
      balance: lastKnown,
      formattedBalance: lastKnown.toFixed(4),
      timestamp: hasData ? key : "",
      dayLabel: getLabel(date),
    };
  });
}

function aggregateByMonth(points: ChartPoint[]): ChartPoint[] {
  const monthlyLast = new Map<string, ChartPoint>();
  for (const p of points) {
    const d = new Date(p.x);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    monthlyLast.set(key, p);
  }
  return Array.from(monthlyLast.entries())
    .map(([key, p]) => {
      const [year, month] = key.split("-").map(Number);
      return {
        ...p,
        x: normalizeDate(new Date(year, month, 1)),
        dayLabel: MONTHS_FULL[month],
        bandLabel: MONTHS_FULL[month],
      };
    })
    .sort((a, b) => a.x.localeCompare(b.x));
}

export type CreditChartRange = "last7days" | "last30days" | "last60days" | "year" | "max";

export function formatCreditsForChart(
  credits: CreditLike[],
  range: CreditChartRange,
): ChartPoint[] {
  if (!credits.length) return [];

  const allPoints = buildCumulativeChartPoints(credits);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (range === "last7days") {
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
    return mapToDateRange(allPoints, dates, allPoints, (d) => WEEKDAYS_SHORT[d.getDay()]).map(
      (p) => ({ ...p, bandLabel: WEEKDAYS_FULL[new Date(p.x).getDay()] }),
    );
  }

  if (range === "last30days") {
    const start = new Date(now);
    start.setDate(now.getDate() - 29);
    const dates = getAllDatesInRange(start, now);
    return mapToDateRange(allPoints, dates, allPoints, (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`);
  }

  if (range === "last60days") {
    const start = new Date(now);
    start.setDate(now.getDate() - 59);
    const dates = getAllDatesInRange(start, now);
    return mapToDateRange(allPoints, dates, allPoints, (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`);
  }

  if (range === "year") {
    const start = new Date(now);
    start.setFullYear(now.getFullYear() - 1);
    const daily = mapToDateRange(allPoints, getAllDatesInRange(start, now), allPoints, (d) => MONTHS[d.getMonth()]);
    const aggregated = aggregateByMonth(daily);
    const labels = addYearSuffixIfDuplicate(aggregated);
    return aggregated.map((p, i) => ({ ...p, dayLabel: labels[i] }));
  }

  if (range === "max") {
    if (!allPoints.length) return [];
    const start = new Date(allPoints[0].x);
    const daily = mapToDateRange(allPoints, getAllDatesInRange(start, now), allPoints, (d) => MONTHS[d.getMonth()]);
    const aggregated = aggregateByMonth(daily);
    const labels = addYearSuffixIfDuplicate(aggregated);
    return aggregated.map((p, i) => ({ ...p, dayLabel: labels[i] }));
  }

  return allPoints;
}

/** Sum all credit amounts for display as "X Credits Used" */
export function totalCreditsUsed(credits: CreditLike[]): number {
  return credits.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
}
