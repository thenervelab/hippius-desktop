import { describe, expect, it } from "vitest";
import { allocateBars, type BreakdownSlice, nonEmptySlices } from "../BreakdownCard";

const slice = (key: string, count: number): BreakdownSlice => ({
  key,
  label: key,
  count,
  color: "#000",
});

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe("allocateBars", () => {
  // A chart a bar short of the one beside it reads as a rendering fault, so
  // the full budget is always spent when there is anything to draw.
  it("always spends the whole bar budget", () => {
    for (const counts of [
      [1, 1, 1, 1],
      [100, 3, 2, 1],
      [7, 0, 0, 0],
      [400000, 12, 5, 3],
      [5, 5, 5],
    ]) {
      const bars = allocateBars(counts.map((c, i) => slice(`s${i}`, c)));
      expect(sum(bars)).toBe(35);
    }
  });

  it("draws nothing when there is nothing", () => {
    expect(allocateBars([slice("a", 0), slice("b", 0)])).toEqual([0, 0]);
  });

  // A category that exists must be visible. Proportionally, 3 of 400,000 is
  // a fraction of one bar, and rounding it away hides a real bucket.
  it("keeps a tiny but non-empty category visible", () => {
    const bars = allocateBars([
      slice("huge", 400000),
      slice("tiny", 3),
      slice("empty", 0),
    ]);
    expect(bars[1]).toBeGreaterThanOrEqual(1);
    expect(bars[2]).toBe(0);
    expect(sum(bars)).toBe(35);
  });

  it("gives an empty category no bars at all", () => {
    const bars = allocateBars([slice("a", 10), slice("b", 0), slice("c", 10)]);
    expect(bars[1]).toBe(0);
  });

  it("splits an even distribution evenly", () => {
    const bars = allocateBars([
      slice("a", 25),
      slice("b", 25),
      slice("c", 25),
      slice("d", 25),
    ]);
    expect(sum(bars)).toBe(35);
    // 35 does not divide by 4, so the remainder lands somewhere, but no
    // slice may be starved or hoard.
    for (const n of bars) {
      expect(n).toBeGreaterThanOrEqual(8);
      expect(n).toBeLessThanOrEqual(9);
    }
  });

  // More categories than bars: everything still fits inside the budget.
  it("does not overspend when every slice floors up to one", () => {
    const many = Array.from({ length: 40 }, (_, i) => slice(`s${i}`, 1));
    const bars = allocateBars(many);
    expect(sum(bars)).toBeLessThanOrEqual(35);
  });

  it("gives the larger category more bars", () => {
    const bars = allocateBars([slice("big", 90), slice("small", 10)]);
    expect(bars[0]).toBeGreaterThan(bars[1]);
  });
});

// A zero slice draws no bar, but it still took a legend entry: a drive
// uploaded only from the console listed "Desktop 0", "Mobile 0" and
// "Other 0" beneath the bar. Those read as facts about the account rather
// than as absent categories.
describe("nonEmptySlices", () => {
  const slice = (key: string, count: number) => ({
    key,
    label: key,
    count,
    color: "#000",
  });

  it("drops the categories nothing landed in", () => {
    const kept = nonEmptySlices([
      slice("console", 12),
      slice("desktop", 0),
      slice("mobile", 0),
    ]);
    expect(kept.map((s) => s.key)).toEqual(["console"]);
  });

  it("keeps every category that has something in it", () => {
    const all = [slice("a", 1), slice("b", 2), slice("c", 3)];
    expect(nonEmptySlices(all)).toHaveLength(3);
  });

  // The card renders its empty state off the total, which is zero either
  // way, so nothing has to special-case an empty array.
  it("returns nothing when every category is empty", () => {
    expect(nonEmptySlices([slice("a", 0), slice("b", 0)])).toEqual([]);
  });

  // A negative count would be server nonsense; it is not a category with
  // something in it.
  it("treats a negative count as empty", () => {
    expect(nonEmptySlices([slice("a", -3), slice("b", 1)]).map((s) => s.key)).toEqual(["b"]);
  });
});
