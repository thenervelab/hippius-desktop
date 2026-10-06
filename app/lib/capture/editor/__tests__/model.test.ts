import { describe, expect, it } from "vitest";
import {
  type Annotation,
  type Doc,
  EMPTY_DOC,
  HISTORY_LIMIT,
  addAnnotation,
  bounds,
  commit,
  handlesFor,
  hitHandle,
  hitTest,
  isDirty,
  isTrivial,
  moveAnnotation,
  nextStepNumber,
  redo,
  removeAnnotation,
  resizeAnnotation,
  restyle,
  startHistory,
  undo,
  updateAnnotation,
} from "../model";

const rect = (id: string, x = 10, y = 10, w = 100, h = 50): Annotation => ({ id, kind: "rect", rect: { x, y, w, h }, color: "#FF3B30", width: 4 });
const arrow = (id: string): Annotation => ({ id, kind: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, color: "#FF3B30", width: 4 });
const doc = (...annotations: Annotation[]): Doc => ({ annotations, crop: null });

describe("undo and redo", () => {
  it("steps back and forward through committed states, and a new change clears redo", () => {
    const one = doc(rect("a"));
    const two = addAnnotation(one, arrow("b"));
    let h = commit(commit(startHistory(), one), two);
    expect(h.present).toBe(two);
    h = undo(h);
    expect(h.present).toBe(one);
    h = undo(h);
    expect(h.present).toBe(EMPTY_DOC);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe(one);
    const other = addAnnotation(one, rect("c"));
    h = commit(h, other);
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it("does not record a change that changed nothing", () => {
    const h = commit(startHistory(), doc(rect("a")));
    expect(commit(h, h.present)).toBe(h);
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps`, () => {
    let h = startHistory();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = commit(h, doc(rect(`r${i}`)));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });

  it("is dirty once anything is drawn or cropped, and clean again when undone", () => {
    let h = startHistory();
    expect(isDirty(h)).toBe(false);
    h = commit(h, { annotations: [], crop: { x: 0, y: 0, w: 5, h: 5 } });
    expect(isDirty(h)).toBe(true);
    expect(isDirty(undo(h))).toBe(false);
  });
});

describe("annotation operations", () => {
  it("updates, moves and removes by id, leaving the document untouched when nothing changes", () => {
    const d = doc(rect("a"), arrow("b"));
    const moved = updateAnnotation(d, "a", (a) => moveAnnotation(a, 5, -5));
    expect(bounds(moved.annotations[0])).toEqual({ x: 15, y: 5, w: 100, h: 50 });
    expect(updateAnnotation(d, "missing", (a) => moveAnnotation(a, 1, 1))).toBe(d);
    expect(removeAnnotation(d, "a").annotations.map((a) => a.id)).toEqual(["b"]);
    expect(removeAnnotation(d, "missing")).toBe(d);
  });

  it("moves every kind by the same offset", () => {
    const all: Annotation[] = [
      arrow("a"),
      rect("r"),
      { id: "h", kind: "highlight", points: [{ x: 1, y: 1 }, { x: 5, y: 1 }], color: "#FFCC00", width: 20 },
      { id: "t", kind: "text", at: { x: 3, y: 3 }, text: "Hi", color: "#000000", size: 20 },
      { id: "s", kind: "step", at: { x: 50, y: 50 }, n: 1, color: "#FF3B30", size: 26 },
      { id: "p", kind: "pixelate", rect: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    for (const a of all) {
      const before = bounds(a);
      const after = bounds(moveAnnotation(a, 7, 9));
      expect(after.x).toBeCloseTo(before.x + 7);
      expect(after.y).toBeCloseTo(before.y + 9);
    }
  });

  it("numbers the next step one past the highest, whatever was deleted", () => {
    const step = (id: string, n: number): Annotation => ({ id, kind: "step", at: { x: 0, y: 0 }, n, color: "#FF3B30", size: 20 });
    expect(nextStepNumber(EMPTY_DOC)).toBe(1);
    expect(nextStepNumber(doc(step("a", 1), step("b", 4), rect("r")))).toBe(5);
  });

  it("treats a click with a drawing tool as nothing drawn", () => {
    expect(isTrivial({ ...arrow("a"), to: { x: 1, y: 1 } } as Annotation)).toBe(true);
    expect(isTrivial(arrow("a"))).toBe(false);
    expect(isTrivial(rect("r", 0, 0, 100, 2))).toBe(true);
    expect(isTrivial({ id: "t", kind: "text", at: { x: 0, y: 0 }, text: "   ", color: "#000000", size: 20 })).toBe(true);
    expect(isTrivial({ id: "h", kind: "highlight", points: [{ x: 0, y: 0 }], color: "#000000", width: 20 })).toBe(true);
  });

  it("restyles what carries a colour and leaves redactions alone", () => {
    expect(restyle(rect("r"), { color: "#007AFF", width: 9 })).toMatchObject({ color: "#007AFF", width: 9 });
    expect(restyle({ id: "t", kind: "text", at: { x: 0, y: 0 }, text: "x", color: "#000000", size: 10 }, { color: "#FFFFFF", textSize: 30 })).toMatchObject({
      color: "#FFFFFF",
      size: 30,
    });
    const blur: Annotation = { id: "b", kind: "blur", rect: { x: 0, y: 0, w: 5, h: 5 } };
    expect(restyle(blur, { color: "#FFFFFF" })).toBe(blur);
  });
});

describe("hit testing", () => {
  it("hits a rectangle on its outline, not in its middle, so the picture under it stays clickable", () => {
    const d = doc(rect("r", 0, 0, 100, 100));
    expect(hitTest(d, { x: 0, y: 50 }, 3)).toBe("r");
    expect(hitTest(d, { x: 50, y: 50 }, 3)).toBeNull();
  });

  it("returns the topmost annotation", () => {
    const d = doc(rect("under", 0, 0, 100, 100), rect("over", 0, 0, 100, 100));
    expect(hitTest(d, { x: 0, y: 0 }, 3)).toBe("over");
  });

  it("hits lines near the segment, ellipses near the outline, steps inside the disc", () => {
    expect(hitTest(doc(arrow("a")), { x: 50, y: 4 }, 3)).toBe("a");
    expect(hitTest(doc(arrow("a")), { x: 50, y: 30 }, 3)).toBeNull();
    const ellipse: Annotation = { id: "e", kind: "ellipse", rect: { x: 0, y: 0, w: 100, h: 50 }, color: "#000000", width: 2 };
    expect(hitTest(doc(ellipse), { x: 100, y: 25 }, 3)).toBe("e");
    expect(hitTest(doc(ellipse), { x: 50, y: 25 }, 3)).toBeNull();
    const step: Annotation = { id: "s", kind: "step", at: { x: 10, y: 10 }, n: 1, color: "#000000", size: 20 };
    expect(hitTest(doc(step), { x: 15, y: 15 }, 0)).toBe("s");
    const blur: Annotation = { id: "b", kind: "blur", rect: { x: 0, y: 0, w: 40, h: 40 } };
    expect(hitTest(doc(blur), { x: 20, y: 20 }, 0)).toBe("b");
  });
});

describe("handles", () => {
  it("drags a line's ends and a box's corners, keeping the opposite corner", () => {
    const a = arrow("a");
    expect(handlesFor(a).map((h) => h.handle)).toEqual(["start", "end"]);
    expect(hitHandle(a, { x: 99, y: 1 }, 4)).toBe("end");
    expect(resizeAnnotation(a, "end", { x: 40, y: 40 })).toMatchObject({ to: { x: 40, y: 40 } });

    const r = rect("r", 10, 10, 100, 50);
    expect(hitHandle(r, { x: 110, y: 60 }, 4)).toBe("se");
    expect(bounds(resizeAnnotation(r, "se", { x: 210, y: 110 }))).toEqual({ x: 10, y: 10, w: 200, h: 100 });
    // Dragged past the anchor: the box flips instead of going negative.
    expect(bounds(resizeAnnotation(r, "se", { x: 0, y: 0 }))).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(bounds(resizeAnnotation(r, "nw", { x: 0, y: 0 }))).toEqual({ x: 0, y: 0, w: 110, h: 60 });
  });

  it("gives text, steps and highlights no handles: they only move", () => {
    expect(handlesFor({ id: "t", kind: "text", at: { x: 0, y: 0 }, text: "x", color: "#000000", size: 10 })).toEqual([]);
  });
});
