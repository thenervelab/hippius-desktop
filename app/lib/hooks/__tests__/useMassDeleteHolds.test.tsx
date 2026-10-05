import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return {
    tauri: makeTauriMock(),
    toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
vi.mock("@tauri-apps/api/event", () => h.tauri.event);
vi.mock("sonner", () => ({ toast: h.toast }));
const { tauri, toast } = h;

import { useMassDeleteHolds } from "@/lib/hooks/useMassDeleteHolds";
import { massDeleteHoldsAtom } from "@/lib/store/syncAtoms";
import { holdKey } from "@/app/lib/massDelete/holds";
import type { MassDeleteHold } from "@/app/lib/tauri/massDelete";

const HOLD: MassDeleteHold = {
  label: "Photos",
  side: "server",
  state: "held",
  count: 150,
  syncedCount: 200,
  emptyRoot: true,
  canRestore: true,
};
const KEY = holdKey("Photos", "server");

beforeEach(() => {
  tauri.reset();
  vi.clearAllMocks();
});

function mount() {
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => useMassDeleteHolds(), { wrapper });
  return store;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useMassDeleteHolds", () => {
  it("hydrates from get_mass_delete_holds on mount", async () => {
    tauri.onInvoke("get_mass_delete_holds", () => [HOLD]);
    const store = mount();
    await waitFor(() => expect(store.get(massDeleteHoldsAtom).get(KEY)?.count).toBe(150));
    expect(store.get(massDeleteHoldsAtom).get(KEY)?.emptyRoot).toBe(true);
  });

  it("folds held, restored, refused and cleared events into the atom", async () => {
    tauri.onInvoke("get_mass_delete_holds", () => []);
    const store = mount();
    await flush();

    await act(async () => {
      await tauri.emitEvent("hcfs_mass_delete_held", HOLD);
    });
    expect(store.get(massDeleteHoldsAtom).get(KEY)?.state).toBe("held");

    await act(async () => {
      await tauri.emitEvent("hcfs_mass_delete_restore_refused", {
        label: "Photos",
        side: "server",
        reason: "insufficient_space",
        neededBytes: 10,
      });
    });
    expect(store.get(massDeleteHoldsAtom).get(KEY)?.refusal?.reason).toBe("insufficient_space");

    await act(async () => {
      await tauri.emitEvent("hcfs_mass_delete_restored", {
        label: "Photos",
        side: "server",
        restored: 150,
        pending: 0,
        skipped: 0,
      });
    });
    expect(store.get(massDeleteHoldsAtom).get(KEY)?.state).toBe("restoring");
    expect(toast.success).toHaveBeenCalledWith("Restored 150 files in “Photos”", expect.anything());

    await act(async () => {
      await tauri.emitEvent("hcfs_mass_delete_cleared", { label: "Photos", side: "server" });
    });
    expect(store.get(massDeleteHoldsAtom).size).toBe(0);
  });

  /** An event that lands while the hydration read is in flight is newer than
   *  the read; the hook reads again rather than let the stale answer win. */
  it("re-reads when an event arrives during hydration", async () => {
    let calls = 0;
    let releaseFirst: (holds: MassDeleteHold[]) => void = () => {};
    tauri.onInvoke("get_mass_delete_holds", () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<MassDeleteHold[]>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return [{ ...HOLD, count: 160 }];
    });
    const store = mount();
    await flush();

    await act(async () => {
      await tauri.emitEvent("hcfs_mass_delete_held", { ...HOLD, count: 160 });
    });
    await act(async () => {
      releaseFirst([]);
    });

    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(store.get(massDeleteHoldsAtom).get(KEY)?.count).toBe(160));
  });
});
