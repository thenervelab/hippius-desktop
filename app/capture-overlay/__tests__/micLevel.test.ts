import { describe, expect, it } from "vitest";
import { litBars } from "@/app/capture-overlay/micLevel";

describe("the microphone meter", () => {
  it("lights at least one bar for any sound, and never more than it has", () => {
    expect(litBars(0, 5)).toBe(0);
    expect(litBars(0.01, 5)).toBe(1);
    expect(litBars(1, 5)).toBe(5);
    expect(litBars(Number.NaN, 5)).toBe(0);
  });

});
