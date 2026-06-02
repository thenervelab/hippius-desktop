import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";
import { useMetadataStale } from "../useMetadataStale";
import { metadataStaleLabelsAtom } from "@/app/lib/global-atoms/unpinAtoms";

// `listen` captures the event handlers so tests can fire Rust events directly.
const listenHandlers = new Map<
  string,
  (event: { payload: unknown }) => void
>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (event: string, handler: (e: { payload: unknown }) => void) => {
      listenHandlers.set(event, handler);
      return Promise.resolve(() => {
        listenHandlers.delete(event);
      });
    }
  ),
}));

function renderWithStore() {
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const { unmount } = renderHook(() => useMetadataStale(), { wrapper });
  return { store, unmount };
}

async function seedTwoStaleLabels(store: ReturnType<typeof createStore>) {
  await waitFor(() => {
    expect(listenHandlers.has("hcfs_metadata_stale")).toBe(true);
    expect(listenHandlers.has("hcfs_activity_updated")).toBe(true);
  });
  const stale = listenHandlers.get("hcfs_metadata_stale")!;
  await act(async () => {
    stale({ payload: { label: "a", reason: "server unreachable" } });
    stale({ payload: { label: "b", reason: "server unreachable" } });
  });
  expect(store.get(metadataStaleLabelsAtom).size).toBe(2);
}

describe("useMetadataStale", () => {
  beforeEach(() => {
    listenHandlers.clear();
  });

  it("clears only the activity event's label, not every drive's", async () => {
    // F35: a successful reconcile/sync for drive "b" must not wipe drive
    // "a"'s stale-metadata banner.
    const { store } = renderWithStore();
    await seedTwoStaleLabels(store);

    const activity = listenHandlers.get("hcfs_activity_updated")!;
    await act(async () => {
      activity({ payload: { label: "b" } });
    });

    const map = store.get(metadataStaleLabelsAtom);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("ignores activity for a label that isn't stale and preserves identity", async () => {
    const { store } = renderWithStore();
    await seedTwoStaleLabels(store);

    const before = store.get(metadataStaleLabelsAtom);
    const activity = listenHandlers.get("hcfs_activity_updated")!;
    await act(async () => {
      activity({ payload: { label: "ghost" } });
    });

    const after = store.get(metadataStaleLabelsAtom);
    expect(after.size).toBe(2);
    // No-op must return the same Map reference so Jotai skips the re-render
    // (the banner's anti-flicker contract).
    expect(Object.is(before, after)).toBe(true);
  });

  it("falls back to clearing all entries when the event carries no label", async () => {
    // Defensive branch: a legacy/untyped label-less event must not strand a
    // banner — it clears the whole map.
    const { store } = renderWithStore();
    await seedTwoStaleLabels(store);

    const activity = listenHandlers.get("hcfs_activity_updated")!;
    await act(async () => {
      activity({ payload: {} });
    });

    expect(store.get(metadataStaleLabelsAtom).size).toBe(0);
  });
});
