import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CaptureAreaPage from "../page";

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

// The picture as the page lays it out: letterboxed in a 1920x1200 window.
const SHOWN = { x: 0, y: 60, width: 1920, height: 1080 };
const called = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd);

async function setup() {
  tauri.onInvoke("capture_area_context", () => ({
    picture: "data:image/jpeg;base64,AAAA",
    streamWidth: 3840,
    streamHeight: 2160,
  }));
  tauri.onInvoke("capture_area_choose", () => null);
  tauri.onInvoke("capture_cancel", () => null);
  render(<CaptureAreaPage />);
  const img = await screen.findByRole("img", { name: /your screen/i });
  vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: SHOWN.x,
    top: SHOWN.y,
    width: SHOWN.width,
    height: SHOWN.height,
    right: SHOWN.x + SHOWN.width,
    bottom: SHOWN.y + SHOWN.height,
    x: SHOWN.x,
    y: SHOWN.y,
    toJSON: () => ({}),
  } as DOMRect);
  fireEvent.load(img);
  return screen.getByTestId("capture-area");
}

function drag(surface: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(surface, { clientX: from[0], clientY: from[1], button: 0 });
  fireEvent.pointerMove(surface, { clientX: to[0], clientY: to[1], button: 0 });
  fireEvent.pointerUp(surface, { clientX: to[0], clientY: to[1], button: 0 });
}

beforeEach(() => tauri.reset());

describe("Wayland's area selection", () => {
  it("shows a skeleton until the screen's picture is in", async () => {
    tauri.onInvoke("capture_area_context", () => ({ picture: "data:image/jpeg;base64,AAAA", streamWidth: 10, streamHeight: 10 }));
    render(<CaptureAreaPage />);
    expect(screen.getByTestId("capture-area-skeleton")).toHaveClass("animate-pulse", "motion-reduce:animate-none");
    fireEvent.load(await screen.findByRole("img"));
    expect(screen.queryByTestId("capture-area-skeleton")).toBeNull();
  });

  // The page reports what it drew and where it showed the picture, in its
  // own CSS pixels; Rust maps that onto the stream's pixels.
  it("sends the drawn area with where the picture is, and nothing else", async () => {
    const surface = await setup();
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-disabled", "true");
    drag(surface, [100, 160], [740, 520]);
    expect(screen.getByTestId("capture-area-selection")).toBeInTheDocument();
    const record = screen.getByRole("button", { name: "Record" });
    expect(record).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(record);
    await waitFor(() => expect(called("capture_area_choose")).toHaveLength(1));
    expect(called("capture_area_choose")[0][1]).toEqual({
      drawn: { x: 100, y: 160, width: 640, height: 360 },
      shown: SHOWN,
    });
  });

  it("records on Return and cancels on Escape", async () => {
    const surface = await setup();
    drag(surface, [10, 70], [300, 300]);
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(called("capture_area_choose")).toHaveLength(1));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(called("capture_cancel")).toHaveLength(1));
  });

  it("asks for a drag before recording, and a click is not an area", async () => {
    const surface = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(screen.getByText("Drag to select an area to record.")).toBeInTheDocument();
    drag(surface, [50, 50], [51, 52]);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(called("capture_area_choose")).toHaveLength(0);
  });

  // An area wholly on the letterbox bars has nothing of the picture: Rust
  // says so and the window stays up to draw again.
  it("shows Rust's refusal and lets the user draw again", async () => {
    const surface = await setup();
    tauri.onInvoke("capture_area_choose", () => {
      throw { kind: "Validation", message: "Drag to select an area to record." };
    });
    drag(surface, [10, 5], [300, 40]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record" })));
    expect(await screen.findByText("Drag to select an area to record.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toHaveAttribute("aria-disabled", "false");
  });

  it("keeps the bar's own presses from starting an area underneath", async () => {
    await setup();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.pointerDown(cancel, { clientX: 500, clientY: 1100, button: 0 });
    fireEvent.pointerUp(cancel, { clientX: 500, clientY: 1100, button: 0 });
    fireEvent.click(cancel);
    expect(screen.queryByTestId("capture-area-selection")).toBeNull();
    await waitFor(() => expect(called("capture_cancel")).toHaveLength(1));
  });
});
