import { describe, expect, it } from "vitest";
import {
  fitRect,
  handlePoint,
  hitTest,
  MIN_AREA,
  moveRect,
  resizeRect,
} from "@/app/capture-overlay/overlaySelection";

const DISPLAY = { width: 1440, height: 900 };
const AREA = { x: 100, y: 100, width: 400, height: 300 };

describe("hitTest", () => {
  it("grabs a corner before the edge or the body", () => {
    expect(hitTest(AREA, { x: 100, y: 100 })).toBe("nw");
    expect(hitTest(AREA, { x: 505, y: 405 })).toBe("se");
    expect(hitTest(AREA, { x: 300, y: 100 })).toBe("n");
    expect(hitTest(AREA, { x: 500, y: 250 })).toBe("e");
  });

  it("moves from inside and starts a new area from outside", () => {
    expect(hitTest(AREA, { x: 300, y: 250 })).toBe("move");
    expect(hitTest(AREA, { x: 50, y: 50 })).toBeNull();
  });

  it("places each handle on the rectangle", () => {
    expect(handlePoint(AREA, "ne")).toEqual({ x: 500, y: 100 });
    expect(handlePoint(AREA, "s")).toEqual({ x: 300, y: 400 });
  });
});

describe("moveRect", () => {
  it("moves by the pointer's travel", () => {
    expect(moveRect(AREA, 20, -30, DISPLAY)).toEqual({ ...AREA, x: 120, y: 70 });
  });

  it("stops at the display's edges instead of leaving it", () => {
    expect(moveRect(AREA, -500, -500, DISPLAY)).toEqual({ ...AREA, x: 0, y: 0 });
    expect(moveRect(AREA, 5000, 5000, DISPLAY)).toEqual({ ...AREA, x: 1040, y: 600 });
  });
});

describe("resizeRect", () => {
  it("moves one side and keeps the opposite one", () => {
    expect(resizeRect(AREA, "e", { x: 700, y: 0 }, DISPLAY)).toEqual({ x: 100, y: 100, width: 600, height: 300 });
    expect(resizeRect(AREA, "nw", { x: 50, y: 60 }, DISPLAY)).toEqual({ x: 50, y: 60, width: 450, height: 340 });
  });

  it("never folds inside out, however far the handle is dragged", () => {
    const shrunk = resizeRect(AREA, "w", { x: 900, y: 0 }, DISPLAY);
    expect(shrunk.width).toBe(MIN_AREA);
    expect(shrunk.x + shrunk.width).toBe(500);
  });

  it("stays on the display", () => {
    expect(resizeRect(AREA, "se", { x: 9999, y: 9999 }, DISPLAY)).toEqual({ x: 100, y: 100, width: 1340, height: 800 });
  });
});

describe("fitRect", () => {
  it("brings a remembered area back on a display that has since shrunk", () => {
    expect(fitRect({ x: 1800, y: 1000, width: 400, height: 300 }, DISPLAY)).toEqual({ x: 1040, y: 600, width: 400, height: 300 });
    expect(fitRect({ x: 0, y: 0, width: 3000, height: 2000 }, DISPLAY)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it("gives nothing back when nothing usable is left", () => {
    expect(fitRect({ x: 0, y: 0, width: 4, height: 4 }, DISPLAY)).toBeNull();
  });
});
