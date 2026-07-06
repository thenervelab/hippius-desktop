import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

// useSyncSnapshot owns two pieces of the sync data-correctness layer:
//
//   1. `actionableSyncFilesAtom` — the `selectAtom` that file listings subscribe
//      to. Its filter (in-flight transfers + completed downloads), path sort, and
//      DEEP-equality memo are what stop a large table re-rendering on every ~250ms
//      byte tick. None of that is exercised anywhere else, so the contract is
//      pinned directly here.
//   2. `useSyncSnapshotListener` — the seed (`sp_get_snapshot`) + live
//      (`sync_progress_snapshot`) writer. The full widget chain covers the
//      seed-vs-live race in `syncWidgetReplay.test.tsx`; these tests pin the same
//      guard at the atom level (cheaper, and fails fast on a hook refactor).
const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return { tauri: makeTauriMock() };
});
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
vi.mock("@tauri-apps/api/event", () => h.tauri.event);
const { tauri } = h;

import {
  snapshotAtom,
  actionableSyncFilesAtom,
  useSyncSnapshotListener,
  type ActionableSyncFile,
} from "@/lib/hooks/useSyncSnapshot";
import { EMPTY_SNAPSHOT } from "@/lib/types/syncSnapshot";
import {
  makeFileProgress,
  makeSnapshot,
} from "@/lib/test-utils/syncSnapshotFactory";

beforeEach(() => tauri.reset());

// `selectAtom` only retains its previous slice (and so can return the SAME
// reference on a content-equal recompute) while the derived atom is MOUNTED.
// Subscribing with a no-op mounts it; the returned unsubscribe keeps the store
// tidy between reads.
function mountActionable(store: ReturnType<typeof createStore>) {
  return store.sub(actionableSyncFilesAtom, () => {});
}

describe("actionableSyncFilesAtom — selection", () => {
  it("keeps in-flight transfers and completed downloads, drops everything else", () => {
    const store = createStore();
    store.set(
      snapshotAtom,
      makeSnapshot([
        makeFileProgress("up-active.bin", { action: "upload", status: "inProgress" }),
        makeFileProgress("down-pending.bin", { action: "download", status: "pending" }),
        makeFileProgress("down-done.bin", { action: "download", status: "completed" }),
        // Dropped: a completed upload is no longer actionable for listings.
        makeFileProgress("up-done.bin", { action: "upload", status: "completed" }),
        // Dropped: deletes never drive the upload/download pills.
        makeFileProgress("rm-local.bin", { action: "local_delete", status: "inProgress" }),
        makeFileProgress("rm-remote.bin", { action: "remote_delete", status: "completed" }),
      ]),
    );

    const rows = store.get(actionableSyncFilesAtom);
    expect(rows.map((r) => r.fileName)).toEqual([
      "down-done.bin",
      "down-pending.bin",
      "up-active.bin",
    ]);
  });

  it("labels a completed download 'completedDownload' and the rest 'inFlight'", () => {
    const store = createStore();
    store.set(
      snapshotAtom,
      makeSnapshot([
        makeFileProgress("a.bin", { action: "download", status: "completed" }),
        makeFileProgress("b.bin", { action: "upload", status: "encrypting" }),
      ]),
    );

    const byName = new Map(
      store.get(actionableSyncFilesAtom).map((r) => [r.fileName, r.phase]),
    );
    expect(byName.get("a.bin")).toBe("completedDownload");
    expect(byName.get("b.bin")).toBe("inFlight");
  });

  it("sorts rows by path so the equality check compares content, not order", () => {
    const store = createStore();
    store.set(
      snapshotAtom,
      makeSnapshot([
        makeFileProgress("zebra.bin", { status: "inProgress" }),
        makeFileProgress("alpha.bin", { status: "inProgress" }),
        makeFileProgress("mango.bin", { status: "inProgress" }),
      ]),
    );

    expect(store.get(actionableSyncFilesAtom).map((r) => r.path)).toEqual([
      "/alpha.bin",
      "/mango.bin",
      "/zebra.bin",
    ]);
  });

  it("is empty when no file is in flight or a completed download", () => {
    const store = createStore();
    store.set(
      snapshotAtom,
      makeSnapshot([makeFileProgress("up.bin", { action: "upload", status: "completed" })]),
    );
    expect(store.get(actionableSyncFilesAtom)).toEqual<ActionableSyncFile[]>([]);
  });
});

describe("actionableSyncFilesAtom — memoization (no table churn)", () => {
  it("returns the SAME reference when only byte progress changed", () => {
    const store = createStore();
    const unsub = mountActionable(store);

    store.set(
      snapshotAtom,
      makeSnapshot([
        makeFileProgress("big.bin", {
          status: "inProgress",
          bytesTransferred: 1_000_000,
          totalBytes: 10_000_000,
          progressPercent: 10,
        }),
      ]),
    );
    const first = store.get(actionableSyncFilesAtom);

    // A 250ms byte tick: same file, same phase/action — only the bytes moved.
    // The snapshot object is replaced wholesale, but the actionable slice is
    // content-equal, so subscribers must NOT see a new array.
    store.set(
      snapshotAtom,
      makeSnapshot([
        makeFileProgress("big.bin", {
          status: "inProgress",
          bytesTransferred: 5_000_000,
          totalBytes: 10_000_000,
          progressPercent: 50,
        }),
      ]),
    );
    const second = store.get(actionableSyncFilesAtom);

    expect(second).toBe(first);
    unsub();
  });

  it("returns a NEW reference when a file leaves flight", () => {
    const store = createStore();
    const unsub = mountActionable(store);

    store.set(
      snapshotAtom,
      makeSnapshot([makeFileProgress("big.bin", { action: "upload", status: "inProgress" })]),
    );
    const first = store.get(actionableSyncFilesAtom);
    expect(first).toHaveLength(1);

    // The upload finishes: a completed upload drops out of the actionable set,
    // so the slice content changes and a new reference must be produced.
    store.set(
      snapshotAtom,
      makeSnapshot([makeFileProgress("big.bin", { action: "upload", status: "completed" })]),
    );
    const second = store.get(actionableSyncFilesAtom);

    expect(second).not.toBe(first);
    expect(second).toHaveLength(0);
    unsub();
  });
});

describe("useSyncSnapshotListener — seed vs live race", () => {
  // Flush the async `.then` chains the listener kicks off (seed invoke + listen
  // registration) without advancing wall-clock time.
  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function mount(store: ReturnType<typeof createStore>) {
    return renderHook(() => useSyncSnapshotListener(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <Provider store={store}>{children}</Provider>
      ),
    });
  }

  it("seeds the atom from sp_get_snapshot when nothing has written yet", async () => {
    const seed = makeSnapshot(
      [makeFileProgress("seed.bin", { status: "inProgress" })],
      { startedAt: 1_000 },
    );
    tauri.onInvoke("sp_get_snapshot", () => seed);

    const store = createStore();
    mount(store);
    await flush();

    expect(store.get(snapshotAtom)).toBe(seed);
  });

  it("does NOT clobber a live frame that already wrote before the seed resolved", async () => {
    // Hold the seed open; let a newer live frame land first; then resolve the
    // stale seed. The `cur === EMPTY_SNAPSHOT` guard must keep the live frame.
    let resolveSeed: (s: unknown) => void = () => {};
    const seedPromise = new Promise((res) => {
      resolveSeed = res;
    });
    tauri.onInvoke("sp_get_snapshot", () => seedPromise);

    const store = createStore();
    mount(store);
    await flush();

    const live = makeSnapshot(
      [makeFileProgress("live.bin", { status: "inProgress" })],
      { startedAt: 2_000 },
    );
    await act(async () => {
      await tauri.emitEvent("sync_progress_snapshot", live);
    });
    expect(store.get(snapshotAtom)).toBe(live);

    const staleSeed = makeSnapshot(
      [makeFileProgress("stale.bin", { status: "inProgress" })],
      { startedAt: 1_000 },
    );
    await act(async () => {
      resolveSeed(staleSeed);
      await Promise.resolve();
    });

    expect(store.get(snapshotAtom)).toBe(live);
  });

  it("stops writing the atom after unmount (listener cleaned up)", async () => {
    tauri.onInvoke("sp_get_snapshot", () => EMPTY_SNAPSHOT);

    const store = createStore();
    const { unmount } = mount(store);
    await flush();
    unmount();

    await act(async () => {
      await tauri.emitEvent("sync_progress_snapshot", makeSnapshot([]));
    });
    expect(store.get(snapshotAtom)).toBe(EMPTY_SNAPSHOT);
  });
});
