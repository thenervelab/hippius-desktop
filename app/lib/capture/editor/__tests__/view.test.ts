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
  ZOOM_LEVELS,
  clampCenter,
  nextZoom,
  pannedCenter,
  zoomOf,
  zoomedView,
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

describe("zoom", () => {
  const region = { x: 0, y: 0, w: 2000, h: 1000 };

  it("reads the fitted view as a zoom, where 100% is one picture pixel per screen pixel", () => {
    // 2000 px into a 1000 pt box on a Retina screen: 0.5 pt per px, 1 px per device px.
    expect(zoomOf(fitView(region, 1048, 548, 24, 2), 2)).toBeCloseTo(1);
    expect(zoomOf(fitView(region, 548, 548, 24, 1), 1)).toBeCloseTo(0.25);
  });

  it("steps in and out through the levels, always changing, and stops at the ends", () => {
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1, -1)).toBe(0.75);
    // From an in-between fitted zoom, the next level each way.
    expect(nextZoom(0.37, 1)).toBe(0.5);
    expect(nextZoom(0.37, -1)).toBe(0.25);
    expect(nextZoom(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1)).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    expect(nextZoom(ZOOM_LEVELS[0], -1)).toBe(ZOOM_LEVELS[0]);
  });

  it("centres a picture smaller than the box, and never shows past the edge of a larger one", () => {
    // At 0.1 the 2000 px picture is 200 pt wide in an 800 pt box: centred whatever is asked.
    const small = zoomedView(region, 800, 600, 0.1, 1, { x: 0, y: 0 });
    expect(small.offsetX).toBeCloseTo((800 - 200) / 2);
    // At 2x it is far larger: asking for the top-left corner keeps the box inside the picture.
    const big = zoomedView(region, 800, 600, 2, 1, { x: 0, y: 0 });
    expect(big.offsetX).toBeCloseTo(0);
    expect(big.offsetY).toBeCloseTo(0);
    const corner = zoomedView(region, 800, 600, 2, 1, { x: 5000, y: 5000 });
    expect(corner.offsetX + region.w * corner.scale).toBeCloseTo(800);
    expect(corner.offsetY + region.h * corner.scale).toBeCloseTo(600);
  });

  it("pans by screen points, so the picture follows the pointer at any zoom", () => {
    const view = zoomedView(region, 800, 600, 2, 1, { x: 1000, y: 500 });
    expect(pannedCenter(view, 800, 600, 100, -50)).toEqual({ x: 1050, y: 475 });
    expect(clampCenter(region, 800, 600, 2, null)).toEqual({ x: 1000, y: 500 });
  });
});
