import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";
import { useDriveStatuses } from "../useDriveStatuses";
import {
  driveStatusesAtom,
  driveStatusesLoadedAtom,
  type DriveStatusEntry,
} from "@/app/lib/global-atoms/unpinAtoms";

// ── Tauri mocks ─────────────────────────────────────────────────────
//
// `invoke` returns the seeded list of entries that the next render
// will fetch. Tests overwrite this between cases.
let nextInvokeResult: DriveStatusEntry[] | Error = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => {
    if (nextInvokeResult instanceof Error) {
      return Promise.reject(nextInvokeResult);
    }
    return Promise.resolve(nextInvokeResult);
  }),
}));

// `listen` captures the event handlers so tests can simulate Rust
// events by calling them directly.
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
  const { unmount } = renderHook(() => useDriveStatuses(), { wrapper });
  return { store, unmount };
}

describe("useDriveStatuses", () => {
  beforeEach(() => {
    listenHandlers.clear();
    nextInvokeResult = [];
  });

  it("populates the map from the initial fetch and flips loaded", async () => {
    nextInvokeResult = [
      {
        label: "default",
        folderName: "Hippius",
        path: "/Users/me/Hippius",
        status: { kind: "active" },
      },
      {
        label: "photos",
        folderName: "Photos",
        path: "/Users/me/Pictures/Photos",
        status: { kind: "paused" },
      },
    ];

    const { store } = renderWithStore();

    await waitFor(() => {
      expect(store.get(driveStatusesLoadedAtom)).toBe(true);
    });

    const map = store.get(driveStatusesAtom);
    expect(map.size).toBe(2);
    expect(map.get("default")).toEqual({
      folderName: "Hippius",
      path: "/Users/me/Hippius",
      status: { kind: "active" },
    });
    expect(map.get("photos")).toEqual({
      folderName: "Photos",
      path: "/Users/me/Pictures/Photos",
      status: { kind: "paused" },
    });
  });

  it("flips loaded even if the initial fetch fails", async () => {
    // Fail-soft: gates must not get stuck in the "still loading" state
    // when the backend is unreachable.
    nextInvokeResult = new Error("backend unreachable");

    const { store } = renderWithStore();

    await waitFor(() => {
      expect(store.get(driveStatusesLoadedAtom)).toBe(true);
    });
    expect(store.get(driveStatusesAtom).size).toBe(0);
  });

  it("updates a single entry on hcfs_drive_status_changed", async () => {
    nextInvokeResult = [
      {
        label: "default",
        folderName: "Hippius",
        path: "/Users/me/Hippius",
        status: { kind: "active" },
      },
    ];

    const { store } = renderWithStore();

    await waitFor(() => {
      expect(store.get(driveStatusesAtom).size).toBe(1);
    });

    const handler = listenHandlers.get("hcfs_drive_status_changed");
    expect(handler).toBeDefined();

    await act(async () => {
      handler!({
        payload: {
          label: "default",
          folderName: "Hippius",
          path: "/Users/me/Hippius",
          status: { kind: "paused" },
        },
      });
    });

    const map = store.get(driveStatusesAtom);
    expect(map.get("default")).toEqual({
      folderName: "Hippius",
      path: "/Users/me/Hippius",
      status: { kind: "paused" },
    });
  });

  it("hydrates a brand-new drive entry from the event payload alone", async () => {
    // Brand-new drive added at runtime: no existing entry in the map.
    // The DRIVE_STATUS_CHANGED payload now carries folderName + path,
    // so the hook can populate the entry without a follow-up fetch.
    nextInvokeResult = [];

    const { store } = renderWithStore();

    await waitFor(() => {
      expect(store.get(driveStatusesLoadedAtom)).toBe(true);
    });

    const handler = listenHandlers.get("hcfs_drive_status_changed");
    await act(async () => {
      handler!({
        payload: {
          label: "brand_new",
          folderName: "Brand New",
          path: "/Users/me/Documents/Brand New",
          status: { kind: "active" },
        },
      });
    });

    expect(store.get(driveStatusesAtom).get("brand_new")).toEqual({
      folderName: "Brand New",
      path: "/Users/me/Documents/Brand New",
      status: { kind: "active" },
    });
  });

  it("drops an entry on hcfs_drive_removed", async () => {
    nextInvokeResult = [
      {
        label: "default",
        folderName: "Hippius",
        path: "/Users/me/Hippius",
        status: { kind: "active" },
      },
      {
        label: "photos",
        folderName: "Photos",
        path: "/Users/me/Pictures/Photos",
        status: { kind: "active" },
      },
    ];

    const { store } = renderWithStore();

    await waitFor(() => {
      expect(store.get(driveStatusesAtom).size).toBe(2);
    });

    const handler = listenHandlers.get("hcfs_drive_removed");
    expect(handler).toBeDefined();

    await act(async () => {
      handler!({ payload: { label: "photos" } });
    });

    const map = store.get(driveStatusesAtom);
    expect(map.size).toBe(1);
    expect(map.has("default")).toBe(true);
    expect(map.has("photos")).toBe(false);
  });

  it("ignores hcfs_drive_removed for unknown labels", async () => {
    // Defensive: a stray remove event for a label we don't have
    // shouldn't crash or wipe other entries.
    nextInvokeResult = [
      {
        label: "default",
        folderName: "Hippius",
        path: "/Users/me/Hippius",
        status: { kind: "active" },
      },
    ];

    const { store } = renderWithStore();

    await waitFor(() => {
      expect(store.get(driveStatusesAtom).size).toBe(1);
    });

    const handler = listenHandlers.get("hcfs_drive_removed");
    await act(async () => {
      handler!({ payload: { label: "ghost" } });
    });

    expect(store.get(driveStatusesAtom).size).toBe(1);
  });
});
