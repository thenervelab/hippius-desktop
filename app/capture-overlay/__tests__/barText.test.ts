import { describe, expect, it } from "vitest";
import { barGroups, barHint, confirmLabel, TIMER_OPTIONS } from "@/app/capture-overlay/barText";

describe("the capture bar", () => {
  it("offers screenshots everywhere and recordings only where they work", () => {
    expect(barGroups(false)).toHaveLength(1);
    const [shots, recordings] = barGroups(true);
    expect(shots.map((m) => m.mode)).toEqual(["screen", "window", "area"]);
    expect(recordings.every((m) => m.kind === "recording")).toBe(true);
    expect(recordings.map((m) => m.label)).toContain("Record selected portion");
  });

  it("says Capture or Record on its button", () => {
    expect(confirmLabel("screenshot")).toBe("Capture");
    expect(confirmLabel("recording")).toBe("Record");
  });

  it("tells the user the next step for each mode", () => {
    expect(barHint("screenshot", "area", false)).toBe("Drag to choose what to capture");
    expect(barHint("recording", "area", true)).toBe("Drag to adjust, then press Return to record");
    expect(barHint("recording", "window", false)).toBe("Click a window to record it");
    expect(barHint("screenshot", "screen", false)).toContain("press Return");
  });

  /** Rust snaps anything else to no timer (`bar::TIMER_CHOICES`). */
  it("offers only the timers Rust accepts", () => {
    expect(TIMER_OPTIONS.map((t) => t.secs)).toEqual([0, 5, 10]);
  });
});
