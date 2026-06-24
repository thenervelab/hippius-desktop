import { describe, it, expect } from "vitest";
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
