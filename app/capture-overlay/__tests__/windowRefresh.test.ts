import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureWindowTarget } from "@/app/lib/tauri/capture";
import { pollWindows, WINDOW_REFRESH_MS } from "../windowRefresh";

const WINDOW: CaptureWindowTarget = { id: 7, appName: "Safari", title: "Docs", x: 0, y: 0, width: 800, height: 600 };

/** A document whose visibility the test flips. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const setVisible = (visible: boolean) => {
    doc.visibilityState = visible ? "visible" : "hidden";
    for (const fn of listeners) fn();
  };
  return { doc: doc as unknown as Document, setVisible, listeners };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("window mode's refresh", () => {
  it("asks every 700 ms and hands over what Rust answers", async () => {
    const refresh = vi.fn(async () => [WINDOW]);
    const onWindows = vi.fn();
    const { doc } = fakeDocument();
    const stop = pollWindows(refresh, onWindows, doc);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onWindows).toHaveBeenCalledWith([WINDOW]);
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops for good once stopped, and drops an answer still on its way", async () => {
    let answer: (w: CaptureWindowTarget[]) => void = () => undefined;
    const refresh = vi.fn(() => new Promise<CaptureWindowTarget[]>((r) => (answer = r)));
    const onWindows = vi.fn();
    const { doc, listeners } = fakeDocument();
    const stop = pollWindows(refresh, onWindows, doc);
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS);
    stop();
    answer([WINDOW]);
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onWindows).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("waits for a slow answer rather than stacking requests", async () => {
    let answer: (w: CaptureWindowTarget[]) => void = () => undefined;
    const refresh = vi.fn(() => new Promise<CaptureWindowTarget[]>((r) => (answer = r)));
    const { doc } = fakeDocument();
    const stop = pollWindows(refresh, vi.fn(), doc);
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(1);
    answer([]);
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("pauses while the page is hidden and carries on when it is visible again", async () => {
    const refresh = vi.fn(async () => []);
    const { doc, setVisible } = fakeDocument();
    const stop = pollWindows(refresh, vi.fn(), doc);
    setVisible(false);
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS * 5);
    expect(refresh).not.toHaveBeenCalled();
    setVisible(true);
    await vi.advanceTimersByTimeAsync(WINDOW_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
});
