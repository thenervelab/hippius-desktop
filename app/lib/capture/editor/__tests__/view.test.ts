import { describe, expect, it } from "vitest";
import {
  ASPECT_PRESETS,
  clampCrop,
  cropFromDrag,
  fitCropToRatio,
  fitView,
  moveCrop,
  redactionBlock,
  resolveRatio,
  strokeUnit,
  toImage,
  toScreen,
} from "../view";

describe("crop math", () => {
  it("keeps a crop inside the picture, in whole pixels, never empty", () => {
    expect(clampCrop({ x: -10, y: -5, w: 50.6, h: 20.2 }, 100, 80)).toEqual({ x: 0, y: 0, w: 41, h: 15 });
    expect(clampCrop({ x: 90, y: 70, w: 50, h: 50 }, 100, 80)).toEqual({ x: 90, y: 70, w: 10, h: 10 });
    expect(clampCrop({ x: 200, y: 200, w: 0, h: 0 }, 100, 80)).toEqual({ x: 99, y: 79, w: 1, h: 1 });
  });

  it("makes a freeform crop from a drag in any direction", () => {
    expect(cropFromDrag({ x: 50, y: 50 }, { x: 10, y: 20 }, null, 100, 100)).toEqual({ x: 10, y: 20, w: 40, h: 30 });
    expect(cropFromDrag({ x: 50, y: 50 }, { x: 52, y: 80 }, null, 100, 100)).toBeNull();
  });

  it("holds a chosen shape, even where the picture's edge stops the drag", () => {
    const square = cropFromDrag({ x: 10, y: 10 }, { x: 60, y: 20 }, 1, 200, 200);
    expect(square).toEqual({ x: 10, y: 10, w: 50, h: 50 });
    // Wide drag on a short picture: the height runs out first, the width follows.
    const wide = cropFromDrag({ x: 0, y: 0 }, { x: 400, y: 10 }, 16 / 9, 400, 90);
    expect(wide).not.toBeNull();
    expect(wide!.w / wide!.h).toBeCloseTo(16 / 9, 1);
    expect(wide!.h).toBeLessThanOrEqual(90);
  });

  it("fits an existing crop to a new shape, centred inside it", () => {
    const r = fitCropToRatio({ x: 0, y: 0, w: 200, h: 100 }, 1, 400, 400);
    expect(r).toEqual({ x: 50, y: 0, w: 100, h: 100 });
    expect(fitCropToRatio({ x: 0, y: 0, w: 200, h: 100 }, null, 400, 400)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it("moves a crop but never past the picture's edge", () => {
    expect(moveCrop({ x: 10, y: 10, w: 50, h: 50 }, 100, -100, 100, 100)).toEqual({ x: 50, y: 0, w: 50, h: 50 });
  });

  it("resolves the Original preset to the picture's own shape", () => {
    const original = ASPECT_PRESETS.find((a) => a.id === "original")!;
    expect(resolveRatio(original, 1600, 900)).toBeCloseTo(16 / 9);
    expect(resolveRatio(ASPECT_PRESETS[0], 1600, 900)).toBeNull();
  });
});

describe("view mapping", () => {
  it("fits the region in the box and never enlarges past natural size", () => {
    const big = fitView({ x: 0, y: 0, w: 2000, h: 1000 }, 1048, 548, 24, 2);
    expect(big.scale).toBeCloseTo(0.5);
    const small = fitView({ x: 0, y: 0, w: 200, h: 100 }, 1000, 800, 24, 2);
    expect(small.scale).toBeCloseTo(0.5, 5); // 1 point per 2 Retina pixels, not stretched to fill
    expect(small.offsetX).toBeCloseTo((1000 - 100) / 2);
  });

  it("maps screen points to picture pixels and back, crop region included", () => {
    const view = fitView({ x: 100, y: 50, w: 400, h: 300 }, 800, 600, 0, 1);
    const p = { x: 123.5, y: 87.25 };
    const back = toImage(view, toScreen(view, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
    expect(toImage(view, { x: view.offsetX, y: view.offsetY })).toEqual({ x: 100, y: 50 });
  });

  it("sizes strokes and redaction blocks by the picture, not the window", () => {
    expect(strokeUnit(800, 600)).toBe(1);
    expect(strokeUnit(3024, 1964)).toBe(3);
    expect(redactionBlock(400, 300)).toBe(8);
    expect(redactionBlock(3024, 1964)).toBe(25);
  });
});
