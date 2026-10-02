import { describe, expect, it } from "vitest";
import {
  dragRect,
  isRealDrag,
  sizeLabel,
  windowAt,
} from "@/app/capture-overlay/overlaySelection";
import type { CaptureWindowTarget } from "@/app/lib/tauri/capture";

const win = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
): CaptureWindowTarget => ({ id, appName: `App ${id}`, title: "", x, y, width, height });

describe("dragRect", () => {
  it("is the same rectangle whichever way the user drags", () => {
    const down = dragRect({ x: 10, y: 10 }, { x: 110, y: 60 });
    const upLeft = dragRect({ x: 110, y: 60 }, { x: 10, y: 10 });
    expect(down).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    expect(upLeft).toEqual(down);
  });
});

describe("isRealDrag", () => {
  // A click that moved a pixel must not capture a sliver of the screen.
  it("treats a tiny movement as a click, not a selection", () => {
    expect(isRealDrag({ x: 0, y: 0, width: 2, height: 200 })).toBe(false);
    expect(isRealDrag({ x: 0, y: 0, width: 200, height: 3 })).toBe(false);
    expect(isRealDrag({ x: 0, y: 0, width: 4, height: 4 })).toBe(true);
  });
});

describe("windowAt", () => {
  // Rust lists windows front first; the overlay must honour that order, or it
  // highlights a window hidden behind the one the user is pointing at.
  it("picks the frontmost window under the cursor", () => {
    const front = win(1, 100, 100, 400, 300);
    const behind = win(2, 0, 0, 1000, 800);
    expect(windowAt([front, behind], { x: 200, y: 200 })?.id).toBe(1);
    expect(windowAt([front, behind], { x: 20, y: 20 })?.id).toBe(2);
  });

  it("finds nothing over the bare desktop", () => {
    expect(windowAt([win(1, 100, 100, 50, 50)], { x: 10, y: 10 })).toBeNull();
  });

  it("treats the far edges as outside, so neighbours do not both claim a line", () => {
    const left = win(1, 0, 0, 100, 100);
    const right = win(2, 100, 0, 100, 100);
    expect(windowAt([left, right], { x: 100, y: 50 })?.id).toBe(2);
  });
});

describe("sizeLabel", () => {
  it("rounds to whole points", () => {
    expect(sizeLabel({ x: 0, y: 0, width: 1279.6, height: 720.2 })).toBe("1280 × 720");
  });
});
