import { describe, expect, it } from "vitest";
import { captureCursor, cursorImage, CURSOR_HOTSPOT, isClickToCapture, spaceToggleMode } from "../clickCapture";

describe("the camera cursor", () => {
  it("is an SVG with its hotspot on the lens, falling back to the hand", () => {
    const cursor = captureCursor("screenshot");
    expect(cursor.startsWith('url("data:image/svg+xml;utf8,')).toBe(true);
    expect(cursor.endsWith(`") ${CURSOR_HOTSPOT.x} ${CURSOR_HOTSPOT.y}, pointer`)).toBe(true);
  });

  it("carries no raw character a data URL or the url() cannot hold", () => {
    for (const kind of ["screenshot", "recording"] as const) {
      const image = cursorImage(kind);
      expect(image).not.toMatch(/[<>#"]/);
      // Decodes back into a whole SVG.
      expect(decodeURIComponent(image.slice(image.indexOf(",") + 1))).toMatch(/^<svg .*<\/svg>$/);
    }
  });

  it("puts the red record dot in the lens for a recording only", () => {
    expect(cursorImage("recording")).toContain("%23FF453A");
    expect(cursorImage("screenshot")).not.toContain("FF453A");
  });
});

describe("click to capture", () => {
  it("covers window and entire screen, not area", () => {
    expect(isClickToCapture("window")).toBe(true);
    expect(isClickToCapture("screen")).toBe(true);
    expect(isClickToCapture("area")).toBe(false);
    expect(isClickToCapture("none")).toBe(false);
  });

  it("swaps window and area on Space, and does nothing in entire screen", () => {
    expect(spaceToggleMode("window", "screenshot", null)).toBe("area");
    expect(spaceToggleMode("area", "recording", null)).toBe("window");
    expect(spaceToggleMode("screen", "screenshot", null)).toBeNull();
  });

  it("only swaps to a mode Rust offers for the kind", () => {
    expect(spaceToggleMode("window", "recording", { recording: ["window", "screen"] })).toBeNull();
    expect(spaceToggleMode("window", "screenshot", { recording: ["screen"] })).toBe("area");
  });
});
