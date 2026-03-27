import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore, type WritableAtom } from "jotai";
import SyncStatusHandler from "../SyncStatusHandler";
import { snapshotAtom } from "@/lib/hooks/useSyncSnapshot";
import { makeSnapshot } from "@/lib/test-utils/syncSnapshotFactory";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "@/lib/types/syncSnapshot";

// Mock Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(EMPTY_SNAPSHOT)),
}));

const listenHandlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listenHandlers.set(event, handler);
    return Promise.resolve(() => { listenHandlers.delete(event); });
  }),
}));

// Mock SyncStatusDialog to inspect props
const mockOnClose = vi.fn();
let lastIsPreparing = false;
vi.mock("../SyncStatusDialog", () => ({
  default: ({ snapshot, open, onClose, isPreparing }: {
    snapshot: SyncSnapshot;
    open: boolean;
    onClose: () => void;
    isPreparing?: boolean;
  }) => {
    // Store onClose so tests can call it
    mockOnClose.mockImplementation(onClose);
    lastIsPreparing = !!isPreparing;
    return open ? (
      <div data-testid="sync-widget" data-started-at={snapshot.startedAt} data-is-preparing={isPreparing ? "true" : "false"}>
        Widget visible
      </div>
    ) : null;
  },
}));

function createTestStore(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  atomValues?: Array<[WritableAtom<any, any[], void>, any]>,
) {
  const store = createStore();
  if (atomValues) {
    for (const [atom, value] of atomValues) {
      store.set(atom, value);
    }
  }
  return store;
}

/** Helper: completed snapshot for a delete operation */
function completedDeleteSnapshot(startedAt: number): SyncSnapshot {
  return makeSnapshot([], {
    isActive: false,
    totalFiles: 1,
    completedFiles: 1,
    failedFiles: 0,
    expectedRemoteDeletes: 1,
    startedAt,
    completedAt: startedAt + 500,
  });
}

/** Helper: active snapshot for a delete operation */
function activeDeleteSnapshot(startedAt: number): SyncSnapshot {
  return makeSnapshot([], {
    isActive: true,
    totalFiles: 1,
    completedFiles: 0,
    failedFiles: 0,
    expectedRemoteDeletes: 1,
    startedAt,
    completedAt: null,
  });
}

describe("SyncStatusHandler – auto-reopen after dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();
  });

  it("shows widget when sync completes with files", () => {
    const snap = completedDeleteSnapshot(1000);
    const store = createTestStore([[snapshotAtom, snap]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });

  it("hides widget after user dismisses", () => {
    const snap = completedDeleteSnapshot(1000);
    const store = createTestStore([[snapshotAtom, snap]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    // User clicks close
    act(() => { mockOnClose(); });

    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });

  it("reopens widget when a new completed session arrives after dismiss (fast delete)", () => {
    const sessionA = completedDeleteSnapshot(1000);
    const store = createTestStore([[snapshotAtom, sessionA]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    // Dismiss
    act(() => { mockOnClose(); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    // New delete completes so fast we skip the active state entirely
    const sessionB = completedDeleteSnapshot(2000);
    act(() => { store.set(snapshotAtom, sessionB); });

    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });

  it("reopens widget when a new active session starts after dismiss", () => {
    const sessionA = completedDeleteSnapshot(1000);
    const store = createTestStore([[snapshotAtom, sessionA]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    // Dismiss
    act(() => { mockOnClose(); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    // New session starts (user catches it while active)
    const sessionB = activeDeleteSnapshot(2000);
    act(() => { store.set(snapshotAtom, sessionB); });

    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });

  it("reopens after dismiss for each sequential fast-completing session", () => {
    const store = createTestStore([[snapshotAtom, completedDeleteSnapshot(1000)]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    // First session visible – dismiss
    act(() => { mockOnClose(); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    // Second session completes instantly
    act(() => { store.set(snapshotAtom, completedDeleteSnapshot(2000)); });
    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    // Dismiss again
    act(() => { mockOnClose(); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    // Third session completes instantly
    act(() => { store.set(snapshotAtom, completedDeleteSnapshot(3000)); });
    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });

  it("does NOT reopen when snapshot resets to empty after dismiss", () => {
    const sessionA = completedDeleteSnapshot(1000);
    const store = createTestStore([[snapshotAtom, sessionA]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    act(() => { mockOnClose(); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    // Backend resets to empty snapshot (no new session)
    act(() => { store.set(snapshotAtom, EMPTY_SNAPSHOT); });

    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });
});

describe("SyncStatusHandler – isPreparing suppression during heartbeats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();
    lastIsPreparing = false;
  });

  it("suppresses isPreparing when widget is already visible (latched complete)", async () => {
    // Start with a completed sync (widget visible via latchedComplete)
    const snap = completedDeleteSnapshot(1000);
    const store = createTestStore([[snapshotAtom, snap]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    // Widget should be visible
    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    // Wait for listen handlers to be registered
    await vi.waitFor(() => {
      expect(listenHandlers.has("hcfs_sync_started")).toBe(true);
    });

    // Simulate heartbeat: sync_started fires
    act(() => {
      listenHandlers.get("hcfs_sync_started")?.({ payload: {} });
    });

    // Widget should still be visible but isPreparing should NOT be set
    // because the widget was already showing via latchedComplete
    expect(queryByTestId("sync-widget")).toBeInTheDocument();
    expect(lastIsPreparing).toBe(false);
  });

  it("sets isPreparing when widget is hidden and sync starts", async () => {
    // Start with empty snapshot (widget hidden)
    const store = createTestStore([[snapshotAtom, EMPTY_SNAPSHOT]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    // Widget should NOT be visible
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    // Wait for listen handlers to be registered
    await vi.waitFor(() => {
      expect(listenHandlers.has("hcfs_sync_started")).toBe(true);
    });

    // Simulate sync starting
    act(() => {
      listenHandlers.get("hcfs_sync_started")?.({ payload: {} });
    });

    // Widget should now be visible with isPreparing=true
    expect(queryByTestId("sync-widget")).toBeInTheDocument();
    expect(lastIsPreparing).toBe(true);
  });
});
