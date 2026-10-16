import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CapturePillTipShown } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CapturePillTipPage from "../page";
import { TIP_EDGE, TIP_GAP } from "@/app/capture-overlay/tooltipPlacement";

// Rust's tooltip window over the pill: the pill's 380 pt width, its 60 pt
// row and the 56 pt of room above it (`pill_hover::TIP_ROOM`).
const WINDOW = { width: 380, height: 116 };
const ROOM = 56;
// The tooltip's own size: jsdom lays nothing out, so it is given.
const TIP = { width: 120, height: 26 };

const shown = (seq: number, label: string | null, anchor = { left: 290, top: ROOM + 16, width: 28, height: 28 }, detail: string | null = null): CapturePillTipShown => ({
  seq,
  tip: label === null ? null : { label, detail, anchor },
});

let rect: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  tauri.reset();
  Object.assign(window, { innerWidth: WINDOW.width, innerHeight: WINDOW.height });
  rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...TIP,
    left: 0,
    top: 0,
    right: TIP.width,
    bottom: TIP.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => rect.mockRestore());

async function setup(first: CapturePillTipShown = shown(0, null)) {
  tauri.onInvoke("capture_pill_tip_now", () => first);
  render(<CapturePillTipPage />);
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the pill's tooltip window", () => {
  it("draws the tooltip Rust sends just above the button, centred on it, in the bar's glass", async () => {
    await setup();
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(() => tauri.emitEvent("capture_pill_tip", shown(1, "Stop recording", undefined, "Press ⌥⇧⌘2")));
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Stop recording");
    expect(tip).toHaveTextContent("Press ⌥⇧⌘2");
    // Centred on the 28 pt button at 290, the gap above its top.
    expect(tip.style.left).toBe(`${290 + 14 - TIP.width / 2}px`);
    expect(tip.style.top).toBe(`${ROOM + 16 - TIP_GAP - TIP.height}px`);
    expect(tip.dataset.side).toBe("above");
    expect(tip.style.visibility).toBe("visible");
    // Never in the way of a click: the window ignores the mouse too.
    expect(tip).toHaveClass("pointer-events-none");
  });

  // The last button sits near the pill's right end: the tooltip is moved in
  // rather than cut off by the window's edge.
  it("keeps a tooltip near the pill's end inside the window", async () => {
    await setup();
    await act(() => tauri.emitEvent("capture_pill_tip", shown(1, "Discard recording", { left: 344, top: ROOM + 16, width: 28, height: 28 })));
    const tip = screen.getByRole("tooltip");
    expect(tip.style.left).toBe(`${WINDOW.width - TIP_EDGE - TIP.width}px`);
    await act(() => tauri.emitEvent("capture_pill_tip", shown(2, "Mute microphone", { left: 2, top: ROOM + 16, width: 28, height: 28 })));
    expect(screen.getByRole("tooltip").style.left).toBe(`${TIP_EDGE}px`);
  });

  // Near the top of the screen Rust puts the window below the pill, the row
  // at its top: the tooltip goes under the button.
  it("goes below the button when the window is below the pill", async () => {
    await setup();
    await act(() => tauri.emitEvent("capture_pill_tip", shown(1, "Pause recording", { left: 200, top: 16, width: 28, height: 28 })));
    const tip = screen.getByRole("tooltip");
    expect(tip.dataset.side).toBe("below");
    expect(tip.style.top).toBe(`${16 + 28 + TIP_GAP}px`);
  });

  it("clears when Rust takes the tooltip away", async () => {
    await setup();
    await act(() => tauri.emitEvent("capture_pill_tip", shown(1, "Pause recording")));
    await act(() => tauri.emitEvent("capture_pill_tip", shown(2, null)));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  // Opened while a tooltip shows (or before the first event): it starts from
  // Rust's current one, and a late first read never puts an older one back.
  it("starts from what Rust shows now, and keeps the newer of a read and an event", async () => {
    await setup(shown(3, "Restart recording"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Restart recording");
    await act(() => tauri.emitEvent("capture_pill_tip", shown(2, "Stale")));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Restart recording");
  });
});
