import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

// useCreditsExhausted registers two Tauri listeners (via registerTauriListeners,
// which imports `listen`) and projects their events into `creditsExhaustedAtom`,
// the single source of truth for the credits banner. Mock only the Tauri event
// boundary; the real atom and the real listener helper run.
const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return { tauri: makeTauriMock() };
});
vi.mock("@tauri-apps/api/event", () => h.tauri.event);
const { tauri } = h;

import { useCreditsExhausted } from "@/lib/hooks/useCreditsExhausted";
import {
  creditsExhaustedAtom,
  type CreditsExhaustedInfo,
} from "@/lib/store/syncAtoms";

const INFO: CreditsExhaustedInfo = {
  label: "photos",
  balanceCents: 10,
  requiredCents: 50,
  fileCount: 3,
};

beforeEach(() => tauri.reset());

function mount() {
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const { unmount } = renderHook(() => useCreditsExhausted(), { wrapper });
  return { store, unmount };
}

// registerTauriListeners registers on a microtask (an async IIFE), so flush
// once before emitting or the handlers aren't attached yet.
async function flushRegistration() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useCreditsExhausted", () => {
  it("writes the hcfs_credits_exhausted payload into the atom", async () => {
    const { store } = mount();
    await flushRegistration();

    await act(async () => {
      await tauri.emitEvent("hcfs_credits_exhausted", INFO);
    });

    expect(store.get(creditsExhaustedAtom)).toEqual(INFO);
  });

  it("clears the atom on hcfs_sync_started (per-cycle ephemerality)", async () => {
    const { store } = mount();
    await flushRegistration();

    await act(async () => {
      await tauri.emitEvent("hcfs_credits_exhausted", INFO);
    });
    expect(store.get(creditsExhaustedAtom)).not.toBeNull();

    await act(async () => {
      await tauri.emitEvent("hcfs_sync_started", { label: "photos" });
    });
    expect(store.get(creditsExhaustedAtom)).toBeNull();
  });

  it("re-raises after a clear when a new 402 arrives", async () => {
    const { store } = mount();
    await flushRegistration();

    await act(async () => {
      await tauri.emitEvent("hcfs_credits_exhausted", INFO);
      await tauri.emitEvent("hcfs_sync_started", {});
      await tauri.emitEvent("hcfs_credits_exhausted", { ...INFO, fileCount: 1 });
    });

    expect(store.get(creditsExhaustedAtom)).toEqual({ ...INFO, fileCount: 1 });
  });

  it("stops writing the atom after unmount (listeners cleaned up)", async () => {
    const { store, unmount } = mount();
    await flushRegistration();
    unmount();

    await act(async () => {
      await tauri.emitEvent("hcfs_credits_exhausted", INFO);
    });

    expect(store.get(creditsExhaustedAtom)).toBeNull();
  });
});
