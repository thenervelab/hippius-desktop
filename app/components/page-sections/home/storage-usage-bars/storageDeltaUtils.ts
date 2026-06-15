// Per-day storage-additions bar chart shaping.
//
// Input is the cumulative series returned by `get_drive_storage_chart`
// (Rust): one ChartPoint per day in the requested range, carry-forwarded
// across quiet days, with the latest snapshot of each day collapsed in
// the backend. We just diff consecutive days here to get "bytes added on
// day N", then optionally aggregate to monthly bars for long ranges and
// downsample to fit the requested bar count.
//
// Day-0 caveat: the backend bakes the pre-range baseline into day 0's
// `balance`, so day-0's delta reads 0 — we can't tell "added today" from
// "was already there before the window opened". All subsequent days are
// faithful diffs.

import { formatBytes } from "@/app/lib/utils/formatBytes";
import { ChartPoint } from "@/lib/types/chartTypes";

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

/** Cumulative ChartPoints → per-day delta ChartPoints. */
function cumulativeToDeltas(points: ChartPoint[]): ChartPoint[] {
  if (!points.length) return [];
  let prev = points[0].balance;
  return points.map((p, i) => {
    const delta = i === 0 ? 0 : Math.max(0, p.balance - prev);
    prev = p.balance;
    return {
      ...p,
      balance: delta,
      formattedBalance: formatBytes(delta),
    };
  });
}

/** Sum daily deltas into one bar per month (last day of month, or today). */
function aggregateToMonthly(daily: ChartPoint[]): ChartPoint[] {
  if (!daily.length) return [];

  const today = startOfDay(new Date());
  const curYear = today.getFullYear();
  const curMonth = today.getMonth();

  const buckets = new Map<
    string,
    { sum: number; year: number; month: number }
  >();
  for (const p of daily) {
    const d = new Date(p.x);
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.sum += p.balance;
    else
      buckets.set(key, {
        sum: p.balance,
        year: d.getFullYear(),
        month: d.getMonth(),
      });
  }

  const out: ChartPoint[] = [];
  buckets.forEach(({ sum, year, month }) => {
    const endDate =
      year === curYear && month === curMonth
        ? today
        : new Date(year, month + 1, 0);
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

/**
 * Top-level entry: cumulative ChartPoint series from
 * `get_drive_storage_chart` → bar-chart-ready ChartPoints with per-day
 * deltas, downsampled to `targetBars`.
 */
export function buildStorageDeltaBars(
  cumulative: ChartPoint[],
  range: StorageRange,
  targetBars: number,
): ChartPoint[] {
  if (!cumulative?.length || targetBars <= 0) return [];

  const daily = cumulativeToDeltas(cumulative);

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
