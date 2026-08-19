// Display sampling for the Storage Usage bars.
//
// The series is the CUMULATIVE stored total per day from
// `get_drive_storage_chart` — a level, not a rate — and it is plotted AS-IS.
// This module only decides WHICH days get a bar when the range holds more
// points than the card can legibly draw (5px pills need ~30 slots max); it
// never diffs, sums, or otherwise transforms values. The per-day delta
// projection that used to live here (`storageDeltaUtils`) is exactly what
// PR #110 deleted — do not reintroduce it (pinned by
// `__tests__/storageUsageCard.test.tsx`).

import { ChartPoint } from "@/lib/types/chartTypes";

export type { StorageRange } from "@/app/lib/hooks/api/useDriveStorageChart";

/**
 * Evenly sample a chronological level series down to `target` points.
 *
 * The first and last points are always kept: the last bar must equal the
 * card's headline total, and the first anchors the window start. Everything
 * in between is picked at even index intervals — for a carry-forwarded
 * cumulative series every day is a faithful reading, so even time sampling
 * loses nothing a bar chart could have shown.
 */
export function sampleCumulativeBars(
  data: ChartPoint[],
  target: number,
): ChartPoint[] {
  if (!data.length || target <= 0) return [];
  if (data.length <= target) return data;
  if (target === 1) return [data[data.length - 1]];

  const step = (data.length - 1) / (target - 1);
  return Array.from({ length: target }, (_, i) => data[Math.round(i * step)]);
}

/**
 * One bar per day for week/30-day views; 60 days and up compress to keep the
 * 5px pills readable. Narrow widths fall back to 7 bars.
 */
export function getBarCount(
  range: "last7days" | "last30days" | "last60days" | "year" | "max",
  isNarrow: boolean,
): number {
  if (isNarrow) return 7;
  switch (range) {
    case "last7days":
      return 7;
    case "last30days":
    case "last60days":
      return 30;
    case "year":
    case "max":
      return 24;
    default:
      return 15;
  }
}
