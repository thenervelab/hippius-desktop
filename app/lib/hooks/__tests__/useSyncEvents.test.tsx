import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import { useSyncEvents } from "../useSyncEvents";

// ── Tauri mocks ─────────────────────────────────────────────────────
//
// `invoke` resolves the get_sync_engine_health call at mount with a
// minimal stub.  Tests don't care about its shape — they only care
// about the window-event dispatches.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

// `listen` captures each event's handler so tests can fire them.
const listenHandlers = new Map<
  string,
  (event: { payload: unknown }) => void
>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (event: string, handler: (e: { payload: unknown }) => void) => {
      listenHandlers.set(event, handler);
      // Resolve synchronously-ish so the registration loop in the hook
      // completes within a single microtask flush.
      return Promise.resolve(() => {
        listenHandlers.delete(event);
      });
    }
  ),
}));

const DEBOUNCE_MS = 250;

function renderHookWithStore() {
  const store = createStore();
  // The hook reads queryClientAtom; seed it with a real QueryClient so
  // invalidateQueries calls are no-ops instead of throwing.
  store.set(queryClientAtom, new QueryClient());
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook(() => useSyncEvents(), { wrapper });
}

async function waitForHandlerRegistration() {
  await waitFor(() => {
    expect(listenHandlers.has("hcfs_sync_completed")).toBe(true);
    expect(listenHandlers.has("hcfs_file_transfer_complete")).toBe(true);
    expect(listenHandlers.has("hcfs_activity_updated")).toBe(true);
  });
}

describe("useSyncEvents — debounced sync_files_completed_changed dispatch", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listenHandlers.clear();
    // Real timers while the hook registers handlers (uses microtasks
    // and Promise chains).  Switch to fake timers per-test once setup
    // is complete.
    vi.useRealTimers();
    dispatchSpy = vi.spyOn(window, "dispatchEvent");
  });

  afterEach(() => {
    vi.useRealTimers();
    dispatchSpy.mockRestore();
  });

  // Helper: count CustomEvent dispatches for the target event name.
  function completedDispatchCount() {
    return dispatchSpy.mock.calls.filter((call) => {
      const ev = call[0];
      return ev instanceof CustomEvent && ev.type === "sync_files_completed_changed";
    }).length;
  }

  it("coalesces 3 burst events within the window into a single dispatch", async () => {
    renderHookWithStore();
    await waitForHandlerRegistration();

    vi.useFakeTimers();

    const completed = listenHandlers.get("hcfs_sync_completed")!;
    const transfer = listenHandlers.get("hcfs_file_transfer_complete")!;
    const activity = listenHandlers.get("hcfs_activity_updated")!;

    // Fire three events well within the 250 ms window (total elapsed
    // before the last event: ~100 ms).
    act(() => {
      completed({
        payload: {
          label: "default",
          files_uploaded: 2,
          files_downloaded: 0,
          files_deleted_locally: 0,
          files_deleted_remotely: 0,
          conflicts_resolved: 0,
          conflicts_skipped: 0,
        },
      });
    });
    act(() => { vi.advanceTimersByTime(50); });
    act(() => { transfer({ payload: {} }); });
    act(() => { vi.advanceTimersByTime(50); });
    act(() => { activity({ payload: {} }); });

    // Mid-window: no dispatch yet — trailing-edge debounce.
    expect(completedDispatchCount()).toBe(0);

    // Each new event resets the timer, so the dispatch fires 250 ms
    // after the last event (activity), not 250 ms after the first.
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS - 1); });
    expect(completedDispatchCount()).toBe(0);

    act(() => { vi.advanceTimersByTime(1); });
    expect(completedDispatchCount()).toBe(1);
  });

  it("does not dispatch a pending event after unmount", async () => {
    const { unmount } = renderHookWithStore();
    await waitForHandlerRegistration();

    vi.useFakeTimers();

    const activity = listenHandlers.get("hcfs_activity_updated")!;
    act(() => { activity({ payload: {} }); });

    // Unmount while the dispatch is still pending in the debounce window.
    unmount();

    // Drive the clock well past the window — the cleanup must have
    // cancelled the pending timer, so no dispatch should occur.
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS * 4); });
    expect(completedDispatchCount()).toBe(0);
  });

  it("each of the three listeners individually triggers a debounced dispatch", async () => {
    renderHookWithStore();
    await waitForHandlerRegistration();

    vi.useFakeTimers();

    const fireAndDrain = (handler: (e: { payload: unknown }) => void, payload: unknown) => {
      act(() => { handler({ payload }); });
      act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    };

    fireAndDrain(listenHandlers.get("hcfs_sync_completed")!, {
      label: "default",
      files_uploaded: 1,
      files_downloaded: 0,
      files_deleted_locally: 0,
      files_deleted_remotely: 0,
      conflicts_resolved: 0,
      conflicts_skipped: 0,
    });
    expect(completedDispatchCount()).toBe(1);

    fireAndDrain(listenHandlers.get("hcfs_file_transfer_complete")!, {});
    expect(completedDispatchCount()).toBe(2);

    fireAndDrain(listenHandlers.get("hcfs_activity_updated")!, {});
    expect(completedDispatchCount()).toBe(3);
  });
});
