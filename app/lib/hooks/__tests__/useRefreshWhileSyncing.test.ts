import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRefreshWhileSyncing } from "../useRefreshWhileSyncing";

// The hook reads `effectiveInProgress` off the live sync snapshot; drive it
// through a module mock so the tests don't need the jotai atom / Tauri events.
let mockActive = false;
vi.mock("../useSyncSnapshot", () => ({
  useSyncSnapshot: () => ({ effectiveInProgress: mockActive }),
}));

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
