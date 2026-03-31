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
vi.mock("../SyncStatusDialog", () => ({
  default: ({ snapshot, open, onClose }: {
    snapshot: SyncSnapshot;
    open: boolean;
    onClose: () => void;
  }) => {
    // Store onClose so tests can call it
    mockOnClose.mockImplementation(onClose);
    return open ? (
      <div data-testid="sync-widget" data-started-at={snapshot.startedAt}>
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

describe("SyncStatusHandler – heartbeat suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();
  });

  it("does NOT show widget for heartbeat cycle with no files", () => {
    // Heartbeat: isActive=true but totalFiles=0
    const heartbeat = makeSnapshot([], {
      isActive: true,
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      startedAt: 1000,
      completedAt: null,
    });
    const store = createTestStore([[snapshotAtom, heartbeat]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    // Widget should NOT appear for empty heartbeat cycles
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });

  it("shows widget when active session has actual files", () => {
    const activeWithFiles = makeSnapshot([], {
      isActive: true,
      totalFiles: 3,
      completedFiles: 1,
      failedFiles: 0,
      startedAt: 1000,
      completedAt: null,
    });
    const store = createTestStore([[snapshotAtom, activeWithFiles]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });

  it("keeps latched widget visible across empty heartbeat cycles", () => {
    // Start with completed sync
    const completed = completedDeleteSnapshot(1000);
    const store = createTestStore([[snapshotAtom, completed]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    // Backend starts a new empty heartbeat cycle (totalFiles=0)
    const heartbeat = makeSnapshot([], {
      isActive: true,
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      startedAt: 2000,
      completedAt: null,
    });
    act(() => { store.set(snapshotAtom, heartbeat); });

    // Widget should still be visible (latched completed state)
    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });
});
