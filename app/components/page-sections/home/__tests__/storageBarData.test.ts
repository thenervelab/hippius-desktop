// Guard for the Storage Usage bar sampler.
//
// The bars plot the CUMULATIVE stored total (a level), so downsampling a long
// range for display must pick representative days without ever transforming
// values — the deleted `storageDeltaUtils` diffed and summed, which is exactly
// what PR #110 removed and `storageUsageCard.test.tsx` pins against. Two
// invariants matter for a level series: values pass through untouched, and the
// LAST point always survives sampling so the final bar equals the card's
// headline total.

import { describe, it, expect } from "vitest";

import type { ChartPoint } from "@/lib/types/chartTypes";
import { sampleCumulativeBars } from "../storage-usage/storageBarData";

function point(balance: number, day: number): ChartPoint {
  const dd = String(day).padStart(2, "0");
  return {
    x: `2026-05-${dd}T00:00:00.000Z`,
    balance,
    formattedBalance: `${balance} B`,
    timestamp: `2026-05-${dd}`,
    dayLabel: `${dd} May`,
  };
}

describe("sampleCumulativeBars", () => {
  it("returns a short series untouched, same references", () => {
    const data = [point(100, 1), point(100, 2), point(300, 3)];
    const out = sampleCumulativeBars(data, 7);
    expect(out).toHaveLength(3);
    out.forEach((p, i) => expect(p).toBe(data[i]));
  });

  it("samples a long series down to the target, keeping first and last", () => {
    const data = Array.from({ length: 60 }, (_, i) => point(i * 10, i + 1));
    const out = sampleCumulativeBars(data, 24);

    expect(out).toHaveLength(24);
    expect(out[0]).toBe(data[0]);
    // The last bar is the headline value — it must never be sampled away.
    expect(out[out.length - 1]).toBe(data[data.length - 1]);
  });

  it("never transforms values — sampled points are the originals, in order", () => {
    const data = Array.from({ length: 45 }, (_, i) => point(1000 + i, i + 1));
    const out = sampleCumulativeBars(data, 10);

    let prevIdx = -1;
    for (const p of out) {
      const idx = data.indexOf(p);
      expect(idx).toBeGreaterThan(prevIdx);
      prevIdx = idx;
    }
  });

  it("keeps a deletion visible: a series ending lower still ends on its last point", () => {
    const data = [
      ...Array.from({ length: 30 }, (_, i) => point(500, i + 1)),
      point(120, 31),
    ];
    const out = sampleCumulativeBars(data, 7);
    expect(out[out.length - 1].balance).toBe(120);
  });

  it("returns empty for empty input or a non-positive target", () => {
    expect(sampleCumulativeBars([], 7)).toEqual([]);
    expect(sampleCumulativeBars([point(1, 1)], 0)).toEqual([]);
  });

  it("target of one keeps only the last point", () => {
    const data = [point(1, 1), point(2, 2), point(3, 3)];
    expect(sampleCumulativeBars(data, 1)).toEqual([data[2]]);
  });
});
