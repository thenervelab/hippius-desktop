import { describe, expect, it } from "vitest";
import { levelFrom, litBars } from "@/app/capture-overlay/micLevel";

const tone = (amplitude: number) => Array.from({ length: 512 }, (_, i) => amplitude * Math.sin(i / 4));

describe("the microphone meter", () => {
  it("reads silence as nothing and a loud voice as full", () => {
    expect(levelFrom(new Array(512).fill(0))).toBe(0);
    expect(levelFrom([])).toBe(0);
    expect(levelFrom(tone(0.9))).toBe(1);
  });

  /** On a linear scale a normal speaking voice barely moves a meter. */
  it("moves for a quiet voice", () => {
    const quiet = levelFrom(tone(0.01));
    expect(quiet).toBeGreaterThan(0.2);
    expect(quiet).toBeLessThan(levelFrom(tone(0.1)));
  });

  it("lights at least one bar for any sound, and never more than it has", () => {
    expect(litBars(0, 5)).toBe(0);
    expect(litBars(0.01, 5)).toBe(1);
    expect(litBars(1, 5)).toBe(5);
    expect(litBars(Number.NaN, 5)).toBe(0);
  });

});
