import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ShareArt, ShareTargets } from "@/app/lib/tauri/capture";

const invoke = vi.fn();
const artListeners: ((e: { payload: ShareArt }) => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: (e: { payload: ShareArt }) => void) => {
    if (event === "capture_share_art") artListeners.push(cb);
    return Promise.resolve(() => undefined);
  }),
}));

import SharePicker from "../SharePicker";

const TARGETS: ShareTargets = {
  token: 3,
  pending: true,
  windows: [
    { id: 11, appName: "Safari", title: "Hippius", displayId: 1, width: 1200, height: 800, thumbnail: null, icon: null },
  ],
  displays: [{ id: 1, name: "Built-in Display", isPrimary: true, width: 1512, height: 982, thumbnail: null }],
};

beforeEach(() => {
  invoke.mockReset();
  artListeners.length = 0;
  invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "capture_share_targets" ? TARGETS : null));
});

describe("SharePicker", () => {
  it("lists windows, then shows their pictures as they stream in", async () => {
    const { findByRole, getByRole } = render(
      <SharePicker kind="recording" firstTab="window" barDisplayId={1} onChoose={vi.fn()} onClose={vi.fn()} />,
    );
    const tile = await findByRole("option", { name: /Hippius/ });
    expect(invoke).toHaveBeenCalledWith("capture_share_targets", { first: "window" });
    expect(tile.querySelector("img")).toBeNull();
    act(() => artListeners.forEach((l) => l({ payload: { token: 3, items: [{ tab: "window", id: 11, thumbnail: "data:x" }] } })));
    expect(getByRole("option", { name: /Hippius/ }).querySelector("img")).toHaveAttribute("src", "data:x");
  });

  it("records the picked window, and only once one is picked", async () => {
    const onChoose = vi.fn();
    const { findByRole, getByRole } = render(
      <SharePicker kind="recording" firstTab="window" barDisplayId={1} onChoose={onChoose} onClose={vi.fn()} />,
    );
    const record = getByRole("button", { name: "Record" });
    expect(record).toBeDisabled();
    fireEvent.click(await findByRole("option", { name: /Hippius/ }));
    fireEvent.click(record);
    expect(onChoose).toHaveBeenCalledWith({ tab: "window", id: 11 });
  });

  it("shares the bar's screen on Return from the screen tab", async () => {
    const onChoose = vi.fn();
    const { findByRole } = render(
      <SharePicker kind="screenshot" firstTab="screen" barDisplayId={1} onChoose={onChoose} onClose={vi.fn()} />,
    );
    await findByRole("option", { name: /Built-in Display/ });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith({ tab: "screen", id: 1 });
  });

  it("closes on Escape and tells Rust to stop taking pictures", async () => {
    const onClose = vi.fn();
    const { findByRole, unmount } = render(
      <SharePicker kind="screenshot" firstTab="window" barDisplayId={1} onChoose={vi.fn()} onClose={onClose} />,
    );
    await findByRole("option", { name: /Hippius/ });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_share_done", { token: 3 }));
  });

  /** A click that reached the overlay would pick the window under it. */
  it("keeps its clicks from the selection surface underneath", async () => {
    const underneath = vi.fn();
    const { findByRole } = render(
      <div onPointerUp={underneath} onPointerDown={underneath}>
        <SharePicker kind="screenshot" firstTab="window" barDisplayId={1} onChoose={vi.fn()} onClose={vi.fn()} />
      </div>,
    );
    const tile = await findByRole("option", { name: /Hippius/ });
    fireEvent.pointerDown(tile);
    fireEvent.pointerUp(tile);
    expect(underneath).not.toHaveBeenCalled();
  });
});
