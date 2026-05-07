// Frontend-only data shaping for the per-day storage bar chart.
//
// The existing `format_storage_chart` Rust IPC carry-forwards the latest
// cumulative reading into every "missing" day, which is wrong for the
// "how much storage was added on this day?" question. Rather than touch
// Rust, this module mirrors the console's TS logic: it takes raw
// cumulative file events, computes per-day deltas with a proper pre-range
// baseline, optionally aggregates to monthly bars for long ranges, and
// smart-downsamples to a target bar count (preferring days where storage
// actually changed).

import { formatBytes } from "@/app/lib/utils/formatBytes";
import { ChartPoint } from "@/lib/types/chartTypes";
import { FileChartData } from "@/app/lib/hooks/api/useFilesSize";

const WEEKDAYS_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
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

export type StorageRange =
  | "last7days"
  | "last30days"
  | "last60days"
  | "year"
  | "max";

// Mirrors hippius_creation_date() in src-tauri/src/billing/charts.rs.
const HIPPIUS_CREATION = new Date(2025, 2, 11); // March 11, 2025

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function normalizeKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getAllDatesInRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur <= last) {
    dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

interface RawCumulativePoint {
  date: Date;
  bytes: number;
}

function fileEventsToCumulativePoints(
  fileData: FileChartData[],
): RawCumulativePoint[] {
  return fileData
    .map<RawCumulativePoint | null>((f) => {
      const ts = new Date(f.processed_timestamp);
      if (Number.isNaN(ts.getTime())) return null;
      // Use UTC components to match the console's getDateFromUTCTimestamp,
      // so a timestamp that's already-tomorrow in UTC doesn't get attributed
      // to today in local time.
      const d = new Date(
        ts.getUTCFullYear(),
        ts.getUTCMonth(),
        ts.getUTCDate(),
      );
      const bytes = Number(f.total_balance);
      if (!Number.isFinite(bytes)) return null;
      return { date: d, bytes };
    })
    .filter((p): p is RawCumulativePoint => p !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Per-day delta = max(0, current cumulative - previous cumulative). */
function mapToRangeDeltas(
  points: RawCumulativePoint[],
  dateRange: Date[],
  isLast7: boolean,
): ChartPoint[] {
  if (!dateRange.length) return [];

  // Day → max cumulative reading (multiple snapshots on the same day collapse
  // to the largest, mirroring the console).
  const byDate = new Map<string, number>();
  for (const p of points) {
    const key = normalizeKey(p.date);
    byDate.set(key, Math.max(byDate.get(key) ?? 0, p.bytes));
  }

  // Baseline: largest cumulative reading strictly before the range starts.
  const firstKey = normalizeKey(dateRange[0]);
  let previous = 0;
  for (const p of points) {
    if (normalizeKey(p.date) < firstKey) {
      if (p.bytes > previous) previous = p.bytes;
    }
  }

  return dateRange.map((date) => {
    const key = normalizeKey(date);
    const current = byDate.get(key);
    let delta = 0;
    let hasData = false;
    if (current !== undefined) {
      delta = Math.max(0, current - previous);
      previous = current;
      hasData = true;
    }
    const dayLabel = isLast7
      ? WEEKDAYS_FULL[date.getDay()]
      : `${date.getDate()} ${MONTHS[date.getMonth()]}`;
    return {
      x: date.toISOString(),
      balance: delta,
      formattedBalance: formatBytes(delta),
      timestamp: hasData ? key : "",
      dayLabel,
      bandLabel: isLast7 ? WEEKDAYS_FULL[date.getDay()] : undefined,
    };
  });
}

/** Sum daily deltas into one bar per month (last day of month, or today). */
function aggregateToMonthly(daily: ChartPoint[]): ChartPoint[] {
  if (!daily.length) return [];

  const today = startOfDay(new Date());
  const curYear = today.getFullYear();
  const curMonth = today.getMonth();

  // Insertion-ordered grouping by `${year}-${month}`.
  const buckets = new Map<string, { sum: number; year: number; month: number }>();
  for (const p of daily) {
    const d = new Date(p.x);
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.sum += p.balance;
    else buckets.set(key, { sum: p.balance, year: d.getFullYear(), month: d.getMonth() });
  }

  const out: ChartPoint[] = [];
  buckets.forEach(({ sum, year, month }) => {
    const endDate =
      year === curYear && month === curMonth
        ? today
        : new Date(year, month + 1, 0); // day 0 of next month = last of this
    out.push({
      x: endDate.toISOString(),
      balance: sum,
      formattedBalance: formatBytes(sum),
      timestamp: normalizeKey(endDate),
      dayLabel: `${endDate.getDate()} ${MONTHS[endDate.getMonth()]} ${endDate.getFullYear()}`,
      bandLabel: `${MONTHS[month]} ${year}`,
    });
  });
  out.sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());
  return out;
}

/**
 * Pick `target` indices from a chronologically ordered series, preferring
 * days where storage actually changed.
 *
 * 1. If the series already fits, return it untouched.
 * 2. If there are at least `target` non-zero days, evenly sample those.
 * 3. Otherwise keep every non-zero day and fill remaining slots by
 *    bisecting the largest remaining gap until we hit `target`.
 *
 * If every day is zero we fall back to even sampling so the chart still
 * renders the requested number of bars.
 */
export function smartDownsample(
  data: ChartPoint[],
  target: number,
): ChartPoint[] {
  if (target <= 0 || data.length <= target) return data;
  if (target === 1) return [data[data.length - 1]];

  const nonZero: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i].balance > 0) nonZero.push(i);
  }

  if (nonZero.length === 0) {
    const step = (data.length - 1) / (target - 1);
    return Array.from(
      { length: target },
      (_, i) => data[Math.round(i * step)],
    );
  }

  if (nonZero.length >= target) {
    const step = (nonZero.length - 1) / (target - 1);
    return Array.from(
      { length: target },
      (_, i) => data[nonZero[Math.round(i * step)]],
    );
  }

  const selected = new Set<number>(nonZero);
  while (selected.size < target) {
    const sorted = Array.from(selected).sort((a, b) => a - b);
    let bestMid = -1;
    let bestGap = -1;

    if (sorted[0] > 0) {
      const gap = sorted[0];
      if (gap > bestGap) {
        bestGap = gap;
        bestMid = Math.round(sorted[0] / 2);
      }
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1] - sorted[i];
      if (gap > bestGap) {
        bestGap = gap;
        bestMid = Math.round((sorted[i] + sorted[i + 1]) / 2);
      }
    }
    const last = sorted[sorted.length - 1];
    if (last < data.length - 1) {
      const gap = data.length - 1 - last;
      if (gap > bestGap) {
        bestGap = gap;
        bestMid = Math.round((last + data.length - 1) / 2);
      }
    }
    if (bestMid < 0 || bestGap <= 1) break;
    const prev = selected.size;
    selected.add(bestMid);
    if (selected.size === prev) break;
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .map((i) => data[i]);
}

function rangeStart(range: StorageRange, today: Date): Date {
  const t = startOfDay(today);
  switch (range) {
    case "last7days":
      return new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6);
    case "last30days":
      return new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29);
    case "last60days":
      return new Date(t.getFullYear(), t.getMonth(), t.getDate() - 59);
    case "year":
      return new Date(t.getFullYear() - 1, t.getMonth(), t.getDate());
    case "max":
    default:
      return HIPPIUS_CREATION;
  }
}

/**
 * Top-level entry: raw cumulative file events → bar-chart-ready ChartPoints
 * for the given range, downsampled to `targetBars`.
 */
export function buildStorageDeltaBars(
  fileData: FileChartData[],
  range: StorageRange,
  targetBars: number,
): ChartPoint[] {
  if (!fileData?.length || targetBars <= 0) return [];

  const points = fileEventsToCumulativePoints(fileData);
  if (!points.length) return [];

  const today = startOfDay(new Date());
  const start = rangeStart(range, today);

  // For year/max, clamp the range to the first actual data point so we
  // don't render months of empty bars before any storage existed.
  let effectiveStart = start;
  if (range === "year" || range === "max") {
    const firstData = points[0].date;
    if (firstData > start) effectiveStart = firstData;
  }

  const dateRange = getAllDatesInRange(effectiveStart, today);
  const daily = mapToRangeDeltas(points, dateRange, range === "last7days");

  let result = daily;
  if (range === "year" || range === "max") {
    const monthSet = new Set<string>();
    for (const p of daily) {
      const d = new Date(p.x);
      monthSet.add(`${d.getFullYear()}-${d.getMonth()}`);
    }
    if (monthSet.size >= 9) result = aggregateToMonthly(daily);
  }

  return smartDownsample(result, targetBars);
}
