import { describe, it, expect } from "vitest";
import { nextSkeletonState } from "../skeletonGate";

describe("nextSkeletonState", () => {
  it("shows the skeleton on the first load (loading, never settled)", () => {
    expect(nextSkeletonState(false, true)).toEqual({
      settled: false,
      showSkeleton: true,
    });
  });

  it("settles and hides the skeleton the first time loading clears", () => {
    expect(nextSkeletonState(false, false)).toEqual({
      settled: true,
      showSkeleton: false,
    });
  });

  it("NEVER re-shows the skeleton once settled, even when loading flips back on", () => {
    // This is the bug fix: a staleTime:0 poll whose isLoading oscillates
    // true↔false must not flash the skeleton (which remounted + re-animated
    // the chart) after the first settle.
    expect(nextSkeletonState(true, true)).toEqual({
      settled: true,
      showSkeleton: false,
    });
    expect(nextSkeletonState(true, false)).toEqual({
      settled: true,
      showSkeleton: false,
    });
  });

  it("stays hidden across a full oscillation once settled (folding the sequence)", () => {
    // Simulate: load (true) -> settle (false) -> poll flaps (true,false)*N.
    // After the first settle, showSkeleton must be false for every later frame.
    const frames = [true, false, true, false, true, true, false, true];
    let settled = false;
    const shown: boolean[] = [];
    for (const isLoading of frames) {
      const r = nextSkeletonState(settled, isLoading);
      settled = r.settled;
      shown.push(r.showSkeleton);
    }
    // Only the leading run of `true` frames before the first settle may show it.
    expect(shown).toEqual([
      true, // initial load
      false, // first settle
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("settled is monotonic (false -> true only, never back)", () => {
    expect(nextSkeletonState(true, true).settled).toBe(true);
    expect(nextSkeletonState(true, false).settled).toBe(true);
    expect(nextSkeletonState(false, false).settled).toBe(true);
    expect(nextSkeletonState(false, true).settled).toBe(false);
  });
});
