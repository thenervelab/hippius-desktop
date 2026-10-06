import { describe, expect, it } from "vitest";
import { type Doc, EMPTY_DOC, bounds } from "../model";
import { type Bounds, type Style, drag, finishText, press, release } from "../gesture";

const style: Style = { color: "#FF3B30", stroke: 4, textSize: 24 };
const b: Bounds = { imageW: 400, imageH: 300, tolerance: 4, ratio: null };

/** Press at `from`, drag to `to`, release: what gets committed. */
function stroke(tool: Parameters<typeof press>[0], doc: Doc, from: { x: number; y: number }, to: { x: number; y: number }, selected: string | null = null, bb = b) {
  const pressed = press(tool, doc, selected, from, style, bb);
  if (!pressed.gesture) return { pressed, committed: null as Doc | null };
  const moved = drag(pressed.gesture, pressed.doc, to, bb);
  return { pressed, committed: release(pressed.gesture, moved) };
}

describe("drawing tools", () => {
  it("draws a rectangle from a drag, in the chosen colour and size", () => {
    const { committed, pressed } = stroke("rect", EMPTY_DOC, { x: 50, y: 40 }, { x: 10, y: 10 });
    expect(committed?.annotations).toHaveLength(1);
    expect(committed?.annotations[0]).toMatchObject({ kind: "rect", rect: { x: 10, y: 10, w: 40, h: 30 }, color: "#FF3B30", width: 4 });
    expect(pressed.selected).toBe(committed?.annotations[0].id);
  });

  it("commits nothing for a click with a drawing tool", () => {
    expect(stroke("arrow", EMPTY_DOC, { x: 5, y: 5 }, { x: 6, y: 5 }).committed).toBeNull();
  });

  it("collects a highlighter's points and draws it wide", () => {
    const pressed = press("highlight", EMPTY_DOC, null, { x: 0, y: 0 }, style, b);
    let doc = drag(pressed.gesture!, pressed.doc, { x: 20, y: 0 }, b);
    doc = drag(pressed.gesture!, doc, { x: 40, y: 2 }, b);
    const done = release(pressed.gesture!, doc);
    expect(done?.annotations[0]).toMatchObject({ kind: "highlight", width: 16 });
    expect(done?.annotations[0].kind === "highlight" && done.annotations[0].points).toHaveLength(3);
  });

  it("draws blur and pixelate as regions", () => {
    const { committed } = stroke("pixelate", EMPTY_DOC, { x: 10, y: 10 }, { x: 60, y: 30 });
    expect(committed?.annotations[0]).toMatchObject({ kind: "pixelate", rect: { x: 10, y: 10, w: 50, h: 20 } });
  });

  it("places numbered steps on a click, counting up", () => {
    const one = press("step", EMPTY_DOC, null, { x: 10, y: 10 }, style, b);
    expect(one.commit).toBe(true);
    const two = press("step", one.doc, null, { x: 50, y: 10 }, style, b);
    expect(two.doc.annotations.map((a) => (a.kind === "step" ? a.n : 0))).toEqual([1, 2]);
  });
});

describe("select tool", () => {
  const drawn = stroke("rect", EMPTY_DOC, { x: 10, y: 10 }, { x: 110, y: 60 }).committed!;
  const id = drawn.annotations[0].id;

  it("moves what it grabs, as one change", () => {
    const { committed, pressed } = stroke("select", drawn, { x: 10, y: 30 }, { x: 30, y: 50 });
    expect(pressed.selected).toBe(id);
    expect(bounds(committed!.annotations[0])).toMatchObject({ x: 30, y: 30 });
  });

  it("resizes from a handle of the selected annotation", () => {
    const { committed } = stroke("select", drawn, { x: 110, y: 60 }, { x: 210, y: 160 }, id);
    expect(bounds(committed!.annotations[0])).toEqual({ x: 10, y: 10, w: 200, h: 150 });
  });

  it("deselects on empty picture, and a press that does not move records nothing", () => {
    expect(press("select", drawn, id, { x: 300, y: 250 }, style, b)).toMatchObject({ selected: null, gesture: null });
    expect(stroke("select", drawn, { x: 10, y: 30 }, { x: 10, y: 30 }).committed).toBeNull();
  });
});

describe("crop tool", () => {
  it("makes a crop, then moves it and resizes it inside the picture", () => {
    const made = stroke("crop", EMPTY_DOC, { x: 20, y: 20 }, { x: 220, y: 120 }).committed!;
    expect(made.crop).toEqual({ x: 20, y: 20, w: 200, h: 100 });
    const moved = stroke("crop", made, { x: 100, y: 60 }, { x: 400, y: 60 }).committed!;
    expect(moved.crop).toEqual({ x: 200, y: 20, w: 200, h: 100 });
    const resized = stroke("crop", made, { x: 220, y: 120 }, { x: 320, y: 220 }).committed!;
    expect(resized.crop).toEqual({ x: 20, y: 20, w: 300, h: 200 });
  });

  it("holds the chosen shape while drawing a new crop", () => {
    const square = stroke("crop", EMPTY_DOC, { x: 0, y: 0 }, { x: 100, y: 20 }, null, { ...b, ratio: 1 }).committed!;
    expect(square.crop).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe("text", () => {
  it("starts typing at a new place, or in the text clicked", () => {
    expect(press("text", EMPTY_DOC, null, { x: 5, y: 6 }, style, b).text).toEqual({ id: null, at: { x: 5, y: 6 } });
    const withText = finishText(EMPTY_DOC, { id: null, at: { x: 5, y: 6 } }, "Look here\n", style)!;
    expect(withText.annotations[0]).toMatchObject({ kind: "text", text: "Look here", size: 24 });
    const id = withText.annotations[0].id;
    expect(press("text", withText, null, { x: 8, y: 10 }, style, b).text).toEqual({ id, at: { x: 5, y: 6 } });
  });

  it("drops empty text, removes text emptied out, and records nothing when unchanged", () => {
    expect(finishText(EMPTY_DOC, { id: null, at: { x: 0, y: 0 } }, "   ", style)).toBeNull();
    const doc = finishText(EMPTY_DOC, { id: null, at: { x: 0, y: 0 } }, "Hi", style)!;
    const id = doc.annotations[0].id;
    expect(finishText(doc, { id, at: { x: 0, y: 0 } }, "Hi", style)).toBeNull();
    expect(finishText(doc, { id, at: { x: 0, y: 0 } }, "", style)?.annotations).toEqual([]);
    expect(finishText(doc, { id, at: { x: 0, y: 0 } }, "Hello", style)?.annotations[0]).toMatchObject({ text: "Hello" });
  });
});
