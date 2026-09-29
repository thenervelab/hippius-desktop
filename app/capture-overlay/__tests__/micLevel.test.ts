import { describe, expect, it } from "vitest";
import { inputIdByName, levelFrom, litBars } from "@/app/capture-overlay/micLevel";

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

  it("finds the chosen microphone in the webview by its name", () => {
    const devices = [
      { kind: "audioinput" as const, deviceId: "default", label: "Default - MacBook Pro Microphone" },
      { kind: "audioinput" as const, deviceId: "a1", label: "MacBook Pro Microphone" },
      { kind: "audioinput" as const, deviceId: "a2", label: "Yeti Stereo Microphone (046d:0ab1)" },
      { kind: "videoinput" as const, deviceId: "v1", label: "Yeti Stereo Microphone" },
    ];
    expect(inputIdByName(devices, "MacBook Pro Microphone")).toBe("a1");
    expect(inputIdByName(devices, "Yeti Stereo Microphone")).toBe("a2");
    expect(inputIdByName(devices, "AirPods")).toBeNull();
    expect(inputIdByName(devices, null)).toBeNull();
  });
});
