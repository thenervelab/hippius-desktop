import { describe, expect, it } from "vitest";
import { boxFrom, markedAt } from "../rustHover";

/**
 * The pill, the bubble's controls and the card are never the key window, so
 * the element under the pointer is found from Rust's point, not from hover.
 */
describe("hover from Rust's pointer", () => {
  function pill() {
    document.body.innerHTML = `
      <div id="row">
        <span id="timer">00:12</span>
        <button data-pill-tip="stop" id="stop"><svg id="icon"><rect id="shape"></rect></svg></button>
      </div>`;
    return {
      stop: document.getElementById("stop")!,
      icon: document.getElementById("shape")!,
      timer: document.getElementById("timer")!,
    };
  }

  it("finds the marked element under the point, from an icon inside it too", () => {
    const { stop, icon } = pill();
    const hits: [number, number][] = [];
    const found = markedAt({ x: 300, y: 30 }, { left: 0, top: 340 }, "data-pill-tip", (x, y) => {
      hits.push([x, y]);
      return icon;
    });
    expect(found).toBe(stop);
    // The point is relative to the row; the hit test is in page pixels (the
    // macOS pill's page is taller than its window, the row in its middle).
    expect(hits).toEqual([[300, 370]]);
  });

  it("finds nothing off the marked elements, or with no point", () => {
    const { timer } = pill();
    expect(markedAt({ x: 10, y: 30 }, { left: 0, top: 0 }, "data-pill-tip", () => timer)).toBeNull();
    expect(markedAt({ x: 10, y: 30 }, { left: 0, top: 0 }, "data-pill-tip", () => null)).toBeNull();
    let asked = false;
    expect(
      markedAt(null, { left: 0, top: 0 }, "data-pill-tip", () => {
        asked = true;
        return timer;
      }),
    ).toBeNull();
    expect(asked).toBe(false);
  });

  it("gives a button's box relative to the row, for Rust to place the tooltip", () => {
    expect(boxFrom({ left: 290, top: 356, width: 28, height: 28 }, { left: 0, top: 340 })).toEqual({ left: 290, top: 16, width: 28, height: 28 });
  });
});
