import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nextChartAnimState } from "@/lib/utils/chartAnimation";

describe("nextChartAnimState (F-8 chart flash guard)", () => {
  it("never re-animates on the empty fallback and keeps the prior signature", () => {
    expect(nextChartAnimState("7", "0", true)).toEqual({
      signature: "7",
      reanimate: false,
    });
  });

  it("re-animates when real data changes signature (a range switch)", () => {
    expect(nextChartAnimState("7", "12", false)).toEqual({
      signature: "12",
      reanimate: true,
    });
  });

  it("does not re-animate when the real signature is unchanged", () => {
    expect(nextChartAnimState("7", "7", false)).toEqual({
      signature: "7",
      reanimate: false,
    });
  });

  it("a real→empty→real round-trip does NOT re-animate (the flash)", () => {
    // 7 real bars, then a transient empty refetch, then 7 real bars again.
    let s = "7";
    const goneEmpty = nextChartAnimState(s, "0", true);
    expect(goneEmpty.reanimate).toBe(false);
    s = goneEmpty.signature;
    const backToReal = nextChartAnimState(s, "7", false);
    expect(backToReal.reanimate).toBe(false);
    expect(backToReal.signature).toBe("7");
  });

  it("re-animates when the first real data arrives after an empty start", () => {
    // First mount empty (prev seeded to "0"), then real data lands.
    const arrived = nextChartAnimState("0", "7", false);
    expect(arrived).toEqual({ signature: "7", reanimate: true });
  });
});

// Static wiring guard (mirrors the repo's Rust source-inspection guards): the
// pure helper above is only useful if the chart components actually route their
// animKey through it. If a refactor drops the call and goes back to bumping
// animKey on every data change, the empty-fallback flash (F-8) silently returns
// — a pure-helper test can't catch that, but this can.
describe("chart components route animKey through nextChartAnimState (F-8 wiring)", () => {
  const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // Both home charts render through AvailableCreditsChart now — the storage
  // card's bar chart was deleted when it stopped drawing per-day deltas.
  const charts = [
    "components/page-sections/home/available-credits/AvailableCreditsChart.tsx",
  ];

  for (const rel of charts) {
    it(`${rel} calls nextChartAnimState`, () => {
      const src = readFileSync(join(appRoot, rel), "utf8");
      expect(src).toContain("nextChartAnimState(");
    });
  }
});
