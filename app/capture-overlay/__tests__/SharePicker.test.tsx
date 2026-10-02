import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";
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
    { id: 12, appName: "Mail", title: "Inbox", displayId: 1, width: 1200, height: 800, thumbnail: null, icon: null },
    { id: 13, appName: "Notes", title: "Notes", displayId: 1, width: 1200, height: 800, thumbnail: null, icon: null },
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

  it("records the picked window, and only once the list is there", async () => {
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

  // Loom pre-picks the frontmost window, so Return shares it at once.
  it("opens with the frontmost window picked", async () => {
    const onChoose = vi.fn();
    const { findByRole } = render(
      <SharePicker kind="recording" firstTab="window" barDisplayId={1} onChoose={onChoose} onClose={vi.fn()} />,
    );
    expect(await findByRole("option", { name: /Hippius/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith({ tab: "window", id: 11 });
  });

  it("shares the bar's screen on Return from the screen tab", async () => {
    const onChoose = vi.fn();
    const { findByRole } = render(
      <SharePicker kind="screenshot" firstTab="screen" barDisplayId={1} onChoose={onChoose} onClose={vi.fn()} />,
    );
    // The bar's screen is picked in an update after the list renders; Return
    // before that shares nothing, which a loaded CI runner hit.
    expect(await findByRole("option", { name: /Built-in Display/ })).toHaveAttribute("aria-selected", "true");
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

  it("is one Tab stop, and focus follows the pick along the arrows", async () => {
    const { findByRole, getByRole } = render(
      <SharePicker kind="screenshot" firstTab="window" barDisplayId={1} onChoose={vi.fn()} onClose={vi.fn()} />,
    );
    const first = await findByRole("option", { name: /Hippius/ });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(getByRole("option", { name: /Inbox/ })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(getByRole("option", { name: /Inbox/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: "End" });
    expect(getByRole("option", { name: /Notes/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(getByRole("option", { name: /Notes/ })).toHaveAttribute("aria-selected", "true");
  });

  it("switches tabs with the arrow keys on the tab strip", async () => {
    const { findByRole, getByRole } = render(
      <SharePicker kind="screenshot" firstTab="window" barDisplayId={1} onChoose={vi.fn()} onClose={vi.fn()} />,
    );
    await findByRole("option", { name: /Hippius/ });
    const windowTab = getByRole("tab", { name: "Window" });
    windowTab.focus();
    fireEvent.keyDown(windowTab, { key: "ArrowRight" });
    const screenTab = getByRole("tab", { name: "Entire screen" });
    expect(screenTab).toHaveFocus();
    expect(screenTab).toHaveAttribute("aria-selected", "true");
    expect(getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "share-tab-screen");
  });

  it("keeps Tab inside itself", async () => {
    const { findByRole, getByRole } = render(
      <>
        <button type="button">Behind</button>
        <SharePicker kind="screenshot" firstTab="window" barDisplayId={1} onChoose={vi.fn()} onClose={vi.fn()} />
      </>,
    );
    await findByRole("option", { name: /Hippius/ });
    const capture = getByRole("button", { name: "Capture" });
    capture.focus();
    fireEvent.keyDown(capture, { key: "Tab" });
    expect(getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(getByRole("button", { name: "Behind" })).not.toHaveFocus();
  });

  it("gives focus back to what opened it", async () => {
    function Host() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Choose window…
          </button>
          {open && (
            <SharePicker kind="screenshot" firstTab="window" barDisplayId={1} onChoose={vi.fn()} onClose={() => setOpen(false)} />
          )}
        </>
      );
    }
    const { getByRole, findByRole } = render(<Host />);
    const opener = getByRole("button", { name: "Choose window…" });
    opener.focus();
    fireEvent.click(opener);
    await findByRole("option", { name: /Hippius/ });
    expect(opener).not.toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
