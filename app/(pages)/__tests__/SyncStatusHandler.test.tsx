import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore, type WritableAtom } from "jotai";
import SyncStatusHandler from "../SyncStatusHandler";
import { snapshotAtom } from "@/lib/hooks/useSyncSnapshot";
import { makeSnapshot } from "@/lib/test-utils/syncSnapshotFactory";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "@/lib/types/syncSnapshot";

// ── Tauri mocks ─────────────────────────────────────────────────────
//
// The handler is a pure projection of `snapshot.widgetVisible` — all
// visibility/latching decisions (auto-reopen, heartbeat suppression,
// dismiss-then-new-session) now live in Rust. These tests pin that
// contract: given snapshot X, does the handler render the widget and
// dispatch user actions correctly? State-transition rules themselves
// are covered by Rust-side tests in `src-tauri/`.

const invokeCalls: Array<{ cmd: string; args: unknown }> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: unknown) => {
    invokeCalls.push({ cmd, args });
    return Promise.resolve(EMPTY_SNAPSHOT);
  }),
}));

const listenHandlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listenHandlers.set(event, handler);
    return Promise.resolve(() => { listenHandlers.delete(event); });
  }),
}));

// Mock SyncStatusDialog to inspect props. The widget is rendered iff
// `open === true` — matching the handler's pass-through of
// `snapshot.widgetVisible`.
const mockOnClose = vi.fn();
vi.mock("../SyncStatusDialog", () => ({
  default: ({ snapshot, open, onClose }: {
    snapshot: SyncSnapshot;
    open: boolean;
    onClose: () => void;
  }) => {
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

/** Visible snapshot: Rust has decided the widget should be shown. */
function visibleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return makeSnapshot([], {
    startedAt: 1000,
    widgetVisible: true,
    widgetState: "completed",
    ...overrides,
  });
}

/** Hidden snapshot: Rust has decided the widget should NOT be shown. */
function hiddenSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return makeSnapshot([], {
    startedAt: 1000,
    widgetVisible: false,
    widgetState: "idle",
    ...overrides,
  });
}

describe("SyncStatusHandler – projection of widgetVisible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();
    invokeCalls.length = 0;
  });

  it("renders the widget when widgetVisible is true", () => {
    const store = createTestStore([[snapshotAtom, visibleSnapshot()]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });

  it("renders nothing when widgetVisible is false", () => {
    const store = createTestStore([[snapshotAtom, hiddenSnapshot()]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });

  it("reacts when Rust flips widgetVisible false → true (e.g. new session starts)", () => {
    const store = createTestStore([[snapshotAtom, hiddenSnapshot()]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    act(() => {
      store.set(snapshotAtom, visibleSnapshot({ startedAt: 2000, widgetState: "active" }));
    });

    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });

  it("reacts when Rust flips widgetVisible true → false (e.g. after dismiss settles)", () => {
    const store = createTestStore([[snapshotAtom, visibleSnapshot()]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );
    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    act(() => {
      store.set(snapshotAtom, hiddenSnapshot());
    });

    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });

  it("reopens across sequential visible→hidden→visible transitions", () => {
    // Pins the auto-reopen behavior at the projection layer: when Rust
    // publishes a new visible snapshot after a hidden one, the widget
    // reappears — no FE-side latching state that could get stuck.
    const store = createTestStore([[snapshotAtom, visibleSnapshot({ startedAt: 1000 })]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );
    expect(queryByTestId("sync-widget")).toBeInTheDocument();
    expect(queryByTestId("sync-widget")?.dataset.startedAt).toBe("1000");

    act(() => { store.set(snapshotAtom, hiddenSnapshot({ startedAt: 1000 })); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    act(() => { store.set(snapshotAtom, visibleSnapshot({ startedAt: 2000 })); });
    expect(queryByTestId("sync-widget")).toBeInTheDocument();
    expect(queryByTestId("sync-widget")?.dataset.startedAt).toBe("2000");

    act(() => { store.set(snapshotAtom, hiddenSnapshot({ startedAt: 2000 })); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();

    act(() => { store.set(snapshotAtom, visibleSnapshot({ startedAt: 3000 })); });
    expect(queryByTestId("sync-widget")).toBeInTheDocument();
    expect(queryByTestId("sync-widget")?.dataset.startedAt).toBe("3000");
  });

  it("stays hidden when snapshot resets to EMPTY_SNAPSHOT", () => {
    const store = createTestStore([[snapshotAtom, visibleSnapshot()]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );
    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    act(() => { store.set(snapshotAtom, EMPTY_SNAPSHOT); });

    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });

  it("stays hidden during an empty heartbeat cycle (widgetVisible=false)", () => {
    // Rust suppresses empty heartbeats by emitting a snapshot with
    // isActive=true but widgetVisible=false. The handler must honor
    // that — i.e. NOT re-show the widget just because isActive flips.
    const heartbeat = hiddenSnapshot({
      isActive: true,
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      startedAt: 2000,
      completedAt: null,
      widgetState: "active",
    });
    const store = createTestStore([[snapshotAtom, heartbeat]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );

    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });

  it("keeps widget visible when Rust latches widgetVisible across a heartbeat", () => {
    // Latching is Rust-side: completed session is still visible while
    // a new empty heartbeat cycle ticks. Rust signals this by keeping
    // widgetVisible=true on both snapshots; the handler just obeys.
    const store = createTestStore([[snapshotAtom, visibleSnapshot({ startedAt: 1000 })]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );
    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    const heartbeatButStillLatched = visibleSnapshot({
      isActive: true,
      totalFiles: 0,
      startedAt: 2000,
      widgetState: "completed",
    });
    act(() => { store.set(snapshotAtom, heartbeatButStillLatched); });

    expect(queryByTestId("sync-widget")).toBeInTheDocument();
  });
});

describe("SyncStatusHandler – user actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenHandlers.clear();
    invokeCalls.length = 0;
  });

  it("invokes sp_dismiss_sync_widget when the user closes the widget", () => {
    const store = createTestStore([[snapshotAtom, visibleSnapshot()]]);

    render(<Provider store={store}><SyncStatusHandler /></Provider>);

    act(() => { mockOnClose(); });

    expect(invokeCalls).toContainEqual({ cmd: "sp_dismiss_sync_widget", args: undefined });
  });

  it("does NOT hide the widget on close until Rust publishes a new snapshot", () => {
    // The handler is stateless — clicking close only fires an IPC.
    // Only Rust flipping `widgetVisible` actually removes the widget.
    const store = createTestStore([[snapshotAtom, visibleSnapshot()]]);

    const { queryByTestId } = render(
      <Provider store={store}><SyncStatusHandler /></Provider>,
    );
    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    act(() => { mockOnClose(); });

    // Widget still visible — the atom hasn't changed yet.
    expect(queryByTestId("sync-widget")).toBeInTheDocument();

    // Simulate Rust reacting to the dismiss IPC by publishing a hidden snapshot.
    act(() => { store.set(snapshotAtom, hiddenSnapshot()); });
    expect(queryByTestId("sync-widget")).not.toBeInTheDocument();
  });

  it("invokes sp_dismiss_sync_widget on hcfs_sync_stopped event", async () => {
    const store = createTestStore([[snapshotAtom, visibleSnapshot()]]);

    render(<Provider store={store}><SyncStatusHandler /></Provider>);

    // The handler registers listeners asynchronously inside useEffect.
    // Wait a tick for `registerTauriListeners` to attach.
    await act(async () => { await Promise.resolve(); });

    const handler = listenHandlers.get("hcfs_sync_stopped");
    expect(handler).toBeDefined();

    act(() => { handler!({ payload: null }); });

    expect(invokeCalls).toContainEqual({ cmd: "sp_dismiss_sync_widget", args: undefined });
  });
});
