import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return { tauri: makeTauriMock() };
});
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
vi.mock("@tauri-apps/api/event", () => h.tauri.event);
const { tauri } = h;

import { useEmptyRemoteDrives } from "@/lib/hooks/useEmptyRemoteDrives";
import { emptyRemoteDrivesAtom } from "@/lib/store/syncAtoms";
import type { EmptyRemoteDrive } from "@/app/lib/tauri/emptyRemote";

const DRIVE: EmptyRemoteDrive = {
  label: "Photos",
  syncedCount: 12,
  canConfirm: true,
  title: "Rust's title",
  body: ["Rust's line"],
};

beforeEach(() => {
  tauri.reset();
  vi.clearAllMocks();
});

function mount() {
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => useEmptyRemoteDrives(), { wrapper });
  return store;
}

describe("useEmptyRemoteDrives", () => {
  it("hydrates from get_empty_remote_drives once its listeners are registered", async () => {
    tauri.onInvoke("get_empty_remote_drives", () => [DRIVE]);
    const store = mount();
    await waitFor(() => expect(store.get(emptyRemoteDrivesAtom).get("Photos")?.syncedCount).toBe(12));
  });

  it("shows a prompt Rust reports and drops it when Rust clears it", async () => {
    tauri.onInvoke("get_empty_remote_drives", () => []);
    const store = mount();
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("get_empty_remote_drives"));

    await act(async () => {
      await tauri.emitEvent("hcfs_empty_remote_held", DRIVE);
    });
    expect(store.get(emptyRemoteDrivesAtom).get("Photos")?.canConfirm).toBe(true);

    await act(async () => {
      await tauri.emitEvent("hcfs_empty_remote_cleared", { label: "Photos" });
    });
    expect(store.get(emptyRemoteDrivesAtom).size).toBe(0);
  });

  it("a clear that lands during the hydration read wins over the read", async () => {
    // The read began before the drive's sync succeeded; it must not bring
    // back a prompt the clear took down.
    tauri.onInvoke("get_empty_remote_drives", async () => {
      await tauri.emitEvent("hcfs_empty_remote_cleared", { label: "Photos" });
      return [DRIVE];
    });
    const store = mount();
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("get_empty_remote_drives"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.get(emptyRemoteDrivesAtom).has("Photos")).toBe(false);
  });
});
