import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";
import ConflictEventListener from "../ConflictEventListener";
import { pendingConflictsAtom } from "@/lib/store/syncAtoms";
import type { StagedChanges } from "@/lib/types/syncTypes";

// Capture the registered Tauri event handlers so tests can fire events directly.
const listenHandlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listenHandlers.set(event, handler);
    return Promise.resolve(() => listenHandlers.delete(event));
  }),
}));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

function staged(conflictCount: number): StagedChanges {
  return { uploads: [], downloads: [], conflicts: Array.from({ length: conflictCount }, () => ({})) } as unknown as StagedChanges;
}

async function mountListener() {
  const store = createStore();
  render(
    <Provider store={store}>
      <ConflictEventListener />
    </Provider>
  );
  await waitFor(() => expect(listenHandlers.has("hcfs_conflicts_pending")).toBe(true));
  return store;
}

describe("ConflictEventListener (per-drive conflicts)", () => {
  beforeEach(() => listenHandlers.clear());

  it("keeps each drive's conflicts independent and clears only the completed drive", async () => {
    const store = await mountListener();

    // Two drives report conflicts; the engine syncs them concurrently so the
    // events interleave. Both must survive — neither overwrites the other.
    act(() => {
      listenHandlers.get("hcfs_conflicts_pending")!({ payload: { label: "a", staged: staged(2) } });
      listenHandlers.get("hcfs_conflicts_pending")!({ payload: { label: "b", staged: staged(1) } });
    });
    let map = store.get(pendingConflictsAtom);
    expect(map.size).toBe(2);
    expect(map.get("a")?.conflicts.length).toBe(2);
    expect(map.get("b")?.conflicts.length).toBe(1);

    // Drive A completing must drop ONLY A — B's conflicts remain pending.
    act(() => {
      listenHandlers.get("hcfs_sync_completed")!({ payload: { label: "a" } });
    });
    map = store.get(pendingConflictsAtom);
    expect(map.size).toBe(1);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
  });

  it("drops only the errored / timed-out drive, not the others", async () => {
    const store = await mountListener();
    act(() => {
      listenHandlers.get("hcfs_conflicts_pending")!({ payload: { label: "a", staged: staged(1) } });
      listenHandlers.get("hcfs_conflicts_pending")!({ payload: { label: "b", staged: staged(1) } });
      listenHandlers.get("hcfs_sync_error")!({ payload: { label: "a" } });
      listenHandlers.get("hcfs_review_mode_timeout")!({ payload: { label: "b" } });
    });
    expect(store.get(pendingConflictsAtom).size).toBe(0);
  });
});
