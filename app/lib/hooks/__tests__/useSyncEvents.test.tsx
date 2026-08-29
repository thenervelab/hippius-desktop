import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import { AUTH_RELOGIN_TOAST_ID, useSyncEvents } from "../useSyncEvents";
import { STORAGE_OVERVIEW_QUERY_KEY } from "../api/useStorageOverview";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "../api/useDriveStorageStats";

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

// sonner is mocked so the auth-relogin test can assert the toast call
// without a DOM toaster mounted.
vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

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
// Mirrors MIN_DISPATCH_INTERVAL_MS in useSyncEvents — the floor between
// dispatches while completions keep arriving.
const MIN_DISPATCH_INTERVAL_MS = 3000;

function renderHookWithStore() {
  const store = createStore();
  // The hook reads queryClientAtom; seed it with a real QueryClient so
  // invalidateQueries calls are no-ops instead of throwing.
  store.set(queryClientAtom, new QueryClient());
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, ...renderHook(() => useSyncEvents(), { wrapper }) };
}

async function waitForHandlerRegistration() {
  await waitFor(() => {
    expect(listenHandlers.has("hcfs_sync_completed")).toBe(true);
    expect(listenHandlers.has("hcfs_file_transfer_complete")).toBe(true);
    expect(listenHandlers.has("hcfs_activity_updated")).toBe(true);
  });
}

describe("useSyncEvents — debounced sync_files_completed_changed dispatch", () => {
  // Derive the spy type from the actual call — `MockInstance` is invariant in
  // its signature param, so the bare `ReturnType<typeof vi.spyOn>` default does
  // not accept the specific `dispatchEvent` mock, and explicit type args trip
  // spyOn's key constraint. A wrapper makes the type exactly the call's result.
  const spyDispatch = () => vi.spyOn(window, "dispatchEvent");
  let dispatchSpy: ReturnType<typeof spyDispatch>;

  beforeEach(() => {
    listenHandlers.clear();
    // Real timers while the hook registers handlers (uses microtasks
    // and Promise chains).  Switch to fake timers per-test once setup
    // is complete.
    vi.useRealTimers();
    dispatchSpy = spyDispatch();
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

  it("each of the three listeners individually triggers a dispatch when spaced beyond the throttle floor", async () => {
    renderHookWithStore();
    await waitForHandlerRegistration();

    vi.useFakeTimers();

    // Drain past the debounce AND the inter-dispatch floor so each event
    // is treated as idle-arrival, not part of a completion storm.
    const fireAndDrain = (handler: (e: { payload: unknown }) => void, payload: unknown) => {
      act(() => { handler({ payload }); });
      act(() => { vi.advanceTimersByTime(MIN_DISPATCH_INTERVAL_MS + DEBOUNCE_MS); });
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

  // Regression: a folder delete produces no file work, so hcfs-client ends the
  // cycle NoChanges and never emits hcfs_sync_completed. The backend's
  // folder-entity reconcile is the only thing that knows the deleted folder is
  // finally gone from the server + the local cache the listing overlays — and it
  // lands well after the delete IPC returned. Without this listener the deleted
  // folder keeps rendering as a `pending` row until an unrelated refresh.
  it("refreshes listings when the backend reports a folder-entity change", async () => {
    renderHookWithStore();
    await waitFor(() => {
      expect(listenHandlers.has("hcfs_folder_entities_changed")).toBe(true);
    });

    vi.useFakeTimers();

    act(() => {
      listenHandlers.get("hcfs_folder_entities_changed")!({
        payload: { label: "default" },
      });
    });
    expect(completedDispatchCount()).toBe(0);

    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(completedDispatchCount()).toBe(1);
  });

  // Pins the refetch-storm fix: during a long multi-file sync, per-file
  // completion events drip in every second or so. Each used to trigger its
  // own file-list refetch (expensive list_user_files + full table
  // re-render), which froze scrolling. The drip must now coalesce to one
  // dispatch per MIN_DISPATCH_INTERVAL_MS, with the trailing timer always
  // delivering the final state.
  it("spaces a steady drip of per-file completions to one dispatch per interval", async () => {
    renderHookWithStore();
    await waitForHandlerRegistration();

    vi.useFakeTimers();

    const transfer = listenHandlers.get("hcfs_file_transfer_complete")!;

    // First completion arrives while idle → dispatches after the short
    // debounce so single-file syncs still feel instantaneous.
    act(() => { transfer({ payload: {} }); });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(completedDispatchCount()).toBe(1);

    // A steady drip (1s apart) within the floor — no extra dispatches yet.
    act(() => { transfer({ payload: {} }); });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { transfer({ payload: {} }); });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { transfer({ payload: {} }); });
    act(() => { vi.advanceTimersByTime(999); });
    expect(completedDispatchCount()).toBe(1);

    // The floor elapses → exactly one coalesced trailing dispatch.
    act(() => { vi.advanceTimersByTime(1); });
    expect(completedDispatchCount()).toBe(2);
  });

  // Liveness guard: dispatches must keep flowing DURING an active sync (at
  // the throttled cadence) — an earlier iteration held them until the
  // session settled, which left a freshly-populated folder visibly empty
  // until a manual refresh. The throttle test above already pins the
  // cadence; this pins that a single mid-sync completion reaches listeners
  // without waiting for anything session-scoped.
  it("dispatches mid-sync completions without requiring the session to settle", async () => {
    renderHookWithStore();
    await waitForHandlerRegistration();

    vi.useFakeTimers();

    const transfer = listenHandlers.get("hcfs_file_transfer_complete")!;
    act(() => { transfer({ payload: {} }); });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(completedDispatchCount()).toBe(1);
  });
});

describe("useSyncEvents — storage overview invalidation (H-007)", () => {
  // The home storage card and the Files header read the SAME indexer
  // row (get_storage_overview / get_drive_storage_stats). Empty indexer
  // data is success + 0 bytes, so a first-sync / no-op cycle
  // (totalCompleted == 0) still has to refetch — otherwise the card
  // sticks at "0 B". Gating the invalidate on totalCompleted > 0 was
  // the bug, and gating only ONE of the two keys just relocates it, so
  // this pins BOTH keys on every hcfs_sync_completed.
  const zeroOutcome = {
    label: "default",
    files_uploaded: 0,
    files_downloaded: 0,
    files_deleted_locally: 0,
    files_deleted_remotely: 0,
    conflicts_resolved: 0,
    conflicts_skipped: 0,
  };

  function renderWithQueryClient() {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const store = createStore();
    store.set(queryClientAtom, queryClient);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const rendered = renderHook(() => useSyncEvents(), { wrapper });
    return { invalidateSpy, ...rendered };
  }

  function invalidationsFor(
    spy: { mock: { calls: unknown[][] } },
    key: string,
  ) {
    return spy.mock.calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      return arg?.queryKey?.[0] === key;
    }).length;
  }

  beforeEach(() => {
    listenHandlers.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates both storage surfaces when the cycle transferred zero files", async () => {
    const { invalidateSpy } = renderWithQueryClient();
    await waitForHandlerRegistration();

    act(() => {
      listenHandlers.get("hcfs_sync_completed")!({ payload: zeroOutcome });
    });

    expect(
      invalidationsFor(invalidateSpy, STORAGE_OVERVIEW_QUERY_KEY),
    ).toBeGreaterThanOrEqual(1);
    // Same indexer row as the overview: if only one refreshes on a
    // zero-file cycle, the two surfaces disagree about one number.
    expect(
      invalidationsFor(invalidateSpy, DRIVE_STORAGE_STATS_QUERY_KEY),
    ).toBeGreaterThanOrEqual(1);
  });

  it("still invalidates both storage surfaces when files did transfer", async () => {
    const { invalidateSpy } = renderWithQueryClient();
    await waitForHandlerRegistration();

    act(() => {
      listenHandlers.get("hcfs_sync_completed")!({
        payload: { ...zeroOutcome, files_uploaded: 2 },
      });
    });

    expect(
      invalidationsFor(invalidateSpy, STORAGE_OVERVIEW_QUERY_KEY),
    ).toBeGreaterThanOrEqual(1);
    expect(
      invalidationsFor(invalidateSpy, DRIVE_STORAGE_STATS_QUERY_KEY),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("useSyncEvents — auth relogin toast (PR #102 follow-up)", () => {
  // The engine's auth-required signal previously had NO frontend
  // listener, so an OAuth account whose token could no longer be
  // refreshed degraded silently. These pin that the listener exists and
  // that repeated per-cycle emits collapse into one toast via the
  // sonner id.
  it("surfaces hcfs_auth_relogin_required as a deduped session-expired toast", async () => {
    renderHookWithStore();
    await waitFor(() => {
      expect(listenHandlers.has("hcfs_auth_relogin_required")).toBe(true);
    });

    const { toast } = await import("sonner");
    const errorSpy = toast.error as unknown as ReturnType<typeof vi.fn>;
    errorSpy.mockClear();

    const relogin = listenHandlers.get("hcfs_auth_relogin_required")!;
    act(() => { relogin({ payload: { error: "401" } }); });
    act(() => { relogin({ payload: { error: "401" } }); });

    expect(errorSpy).toHaveBeenCalledTimes(2);
    for (const call of errorSpy.mock.calls) {
      expect(call[0]).toMatch(/sign back in/i);
      // The stable id is what makes sonner render ONE toast for the
      // engine's repeated per-cycle emits.
      expect(call[1]).toMatchObject({ id: AUTH_RELOGIN_TOAST_ID });
    }
  });
});
