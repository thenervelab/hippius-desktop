import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import EditorCanvas from "../EditorCanvas";
import type { Doc } from "@/app/lib/capture/editor/model";

// jsdom has no PointerEvent, and without one a pointer event loses its
// coordinates; a MouseEvent carries them.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventWithCoords extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: PointerEventWithCoords, configurable: true });
}

// Frames are run by hand, so the test decides when the screen redraws.
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  // jsdom draws nothing and measures nothing: give the box a size and the
  // canvas no context, so only the pointer handling runs.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames[id - 1] = () => {};
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runFrames = () => {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(0);
  });
};

function setup() {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  // Feeds each preview back in as the document, as the editor does.
  function Harness() {
    const [preview, setPreview] = useState<Doc | null>(null);
    const doc: Doc = preview ?? { annotations: [], crop: null };
    return (
      <EditorCanvas
        image={{} as CanvasImageSource}
        imageW={400}
        imageH={300}
        doc={doc}
        selected={null}
        tool="arrow"
        style={{ color: "#FF3B30", stroke: 4, textSize: 20 }}
        ratio={null}
        block={8}
        textEdit={null}
        zoom={1}
        center={null}
        onScale={() => {}}
        onPan={() => {}}
        onZoomStep={() => {}}
        selectionBar={null}
        onPreview={(next) => {
          onPreview(next);
          setPreview(next);
        }}
        onCommit={onCommit}
        onSelect={() => {}}
        onStartText={() => {}}
        onTextChange={() => {}}
        onTextDone={() => {}}
      />
    );
  }
  render(<Harness />);
  return { canvas: screen.getByRole("img", { name: "Screenshot being edited" }), onPreview, onCommit };
}

describe("EditorCanvas dragging", () => {
  it("moves the drawing at most once per screen frame, to the newest point", () => {
    const { canvas, onPreview } = setup();
    fireEvent.pointerDown(canvas, { button: 0, clientX: 250, clientY: 200, pointerId: 1 });
    onPreview.mockClear();
    for (let x = 260; x <= 340; x += 10) fireEvent.pointerMove(canvas, { clientX: x, clientY: 260, pointerId: 1 });
    expect(onPreview).not.toHaveBeenCalled();
    runFrames();
    expect(onPreview).toHaveBeenCalledTimes(1);
    const moved = onPreview.mock.calls[0][0] as Doc;
    const arrow = moved.annotations[0] as { to: { x: number } };
    const lastOnly = arrow.to.x;
    // A second burst waits for the next frame again.
    fireEvent.pointerMove(canvas, { clientX: 450, clientY: 260, pointerId: 1 });
    runFrames();
    expect(onPreview).toHaveBeenCalledTimes(2);
    const later = (onPreview.mock.calls[1][0] as Doc).annotations[0] as { to: { x: number } };
    expect(later.to.x).toBeGreaterThan(lastOnly);
  });

  it("commits where the pointer is released, even before the frame runs", () => {
    const { canvas, onPreview, onCommit } = setup();
    fireEvent.pointerDown(canvas, { button: 0, clientX: 250, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 300, clientY: 260, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 260, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith(null);
    // The frame the move asked for is dropped: nothing previews after release.
    const calls = onPreview.mock.calls.length;
    runFrames();
    expect(onPreview.mock.calls.length).toBe(calls);
  });
});
