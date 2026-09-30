import { describe, expect, it } from "vitest";
import {
  fitRect,
  handlePoint,
  hitTest,
  applyPending,
  moveRect,
  nudgeRect,
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
    // The smallest an area resizes to is 16 pt.
    expect(shrunk.width).toBe(16);
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

describe("nudgeRect", () => {
  it("moves the area a point per arrow press, ten with Shift", () => {
    expect(nudgeRect(AREA, "ArrowLeft", false, DISPLAY)).toEqual({ ...AREA, x: 99 });
    expect(nudgeRect(AREA, "ArrowDown", true, DISPLAY)).toEqual({ ...AREA, y: 110 });
  });

  it("stops at the display's edge", () => {
    expect(nudgeRect({ ...AREA, x: 0 }, "ArrowLeft", true, DISPLAY)).toEqual({ ...AREA, x: 0 });
  });

  it("ignores every other key", () => {
    expect(nudgeRect(AREA, "Enter", false, DISPLAY)).toBeNull();
  });
});

describe("applyPending", () => {
  const MINE = { x: 10, y: 10, width: 200, height: 100 };

  it("drops this display's area when another display takes the pending one", () => {
    expect(applyPending(1, { displayId: 2 }, MINE)).toEqual({ rect: null, elsewhere: true });
  });

  // The race: display 2 restored its last area while the user was drawing on
  // display 1. Display 2's event cleared display 1's drawing; display 1's own
  // event came last, so Rust holds display 1's area and it must be drawn.
  it("draws the area it handed over again when its own event comes last", () => {
    let drawn: typeof MINE | null = MINE;
    const apply = (change: { displayId: number | null }) => {
      const next = applyPending(1, change, MINE);
      if (next.rect !== undefined) drawn = next.rect;
    };
    apply({ displayId: 2 });
    expect(drawn).toBeNull();
    apply({ displayId: 1 });
    expect(drawn).toEqual(MINE);
  });

  it("takes Rust's own rect when the event carries one", () => {
    const fromRust = { x: 1, y: 2, width: 30, height: 40 };
    expect(applyPending(1, { displayId: 1, rect: fromRust }, MINE).rect).toEqual(fromRust);
  });

  it("leaves the drawing alone when nobody holds an area", () => {
    expect(applyPending(1, { displayId: null }, MINE)).toEqual({ rect: undefined, elsewhere: false });
  });
});
