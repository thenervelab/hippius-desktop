import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRefreshWhileSyncing } from "../useRefreshWhileSyncing";

// The hook reads `effectiveInProgressAtom`; drive the value through jotai
// so tests don't need the snapshot listener / Tauri events.
let mockActive = false;
vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: () => mockActive,
  };
});

describe("useRefreshWhileSyncing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockActive = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not poll when disabled, even while a sync is active", () => {
    mockActive = true;
    const refresh = vi.fn();
    renderHook(() => useRefreshWhileSyncing(refresh, false, 1000));
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not poll while idle", () => {
    mockActive = false;
    const refresh = vi.fn();
    renderHook(() => useRefreshWhileSyncing(refresh, true, 1000));
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("polls on the interval while active", () => {
    mockActive = true;
    const refresh = vi.fn();
    renderHook(() => useRefreshWhileSyncing(refresh, true, 1000));
    vi.advanceTimersByTime(3500);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("waits for a slow refresh instead of starting another on every tick", async () => {
    mockActive = true;
    let settle!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    renderHook(() => useRefreshWhileSyncing(refresh, true, 1000));
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("polls again after a refresh that failed", async () => {
    mockActive = true;
    const refresh = vi.fn(() => Promise.reject(new Error("backend down")));
    renderHook(() => useRefreshWhileSyncing(refresh, true, 1000));
    await vi.advanceTimersByTimeAsync(3500);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops polling and fires exactly once on the active→idle edge", () => {
    mockActive = true;
    const refresh = vi.fn();
    const { rerender } = renderHook(() =>
      useRefreshWhileSyncing(refresh, true, 10_000),
    );
    refresh.mockClear(); // ignore any interval ticks before the edge

    mockActive = false;
    rerender();

    // One refresh for the settle edge…
    expect(refresh).toHaveBeenCalledTimes(1);
    // …and no further polling once idle.
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
