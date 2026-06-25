import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

// useFilesNotification is the data-projection layer history shows breaking on
// feature additions: it aggregates `hcfs_sync_completed` cycles over a sliding
// debounce window into ONE "Sync Complete" notification, caps the per-file
// detail buffer, and turns the GATED `hcfs_sync_failed_notify` into an
// immediate "Sync Failed" row. These tests pin those contracts at the IPC
// boundary — the only backend call the hook makes is `create_sync_notification`,
// so we assert on its args.
const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return {
    tauri: makeTauriMock(),
    state: {
      polkadotAddress: "5poll" as string | null,
      oauthSession: null as { substrateAddress?: string } | null,
    },
  };
});
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
vi.mock("@tauri-apps/api/event", () => h.tauri.event);
vi.mock("@/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({
    polkadotAddress: h.state.polkadotAddress,
    oauthSession: h.state.oauthSession,
  }),
}));
// Keep the real `enabledNotificationTypesAtom` (so a test can seed it) but make
// the two refresh write-atoms inert — they otherwise fire their own invokes and
// would couple this hook test to the notification store's internals.
vi.mock("@/components/page-sections/notifications/notificationStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/page-sections/notifications/notificationStore")>();
  const { atom } = await import("jotai");
  return {
    ...actual,
    refreshUnreadCountAtom: atom(null, () => {}),
    refreshEnabledTypesAtom: atom(null, () => {}),
  };
});
const { tauri, state } = h;

import { useFilesNotification } from "@/lib/hooks/useFilesNotification";
import { enabledNotificationTypesAtom } from "@/components/page-sections/notifications/notificationStore";

const AGGREGATION_MS = 10_000;

interface CompletedOverrides {
  files_uploaded?: number;
  files_downloaded?: number;
  files_deleted_locally?: number;
  files_deleted_remotely?: number;
  fileCount?: number; // how many SyncedFileDetail entries to attach
  label?: string;
}

function completed(o: CompletedOverrides) {
  const uploaded = o.files_uploaded ?? 0;
  const detailCount = o.fileCount ?? uploaded;
  return {
    label: o.label,
    files_uploaded: uploaded,
    files_downloaded: o.files_downloaded ?? 0,
    files_deleted_locally: o.files_deleted_locally ?? 0,
    files_deleted_remotely: o.files_deleted_remotely ?? 0,
    files: Array.from({ length: detailCount }, (_, i) => ({
      fileName: `f${i}.bin`,
      totalBytes: 1,
      action: "upload",
    })),
  };
}

function mount(enabled: boolean) {
  const store = createStore();
  if (enabled) store.set(enabledNotificationTypesAtom, ["Files"]);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const { unmount } = renderHook(() => useFilesNotification(), { wrapper });
  return { store, unmount };
}

// Flush the async listen registration (Promise.all in an IIFE) under fake timers.
async function flushRegistration() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function syncNotificationCalls() {
  return tauri.core.invoke.mock.calls.filter((c) => c[0] === "create_sync_notification");
}

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  tauri.onInvoke("create_sync_notification", () => undefined);
  state.polkadotAddress = "5poll";
  state.oauthSession = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFilesNotification — gating", () => {
  it("registers no listeners when Files notifications are disabled", async () => {
    mount(false);
    await flushRegistration();
    expect(tauri.event.listen).not.toHaveBeenCalled();
  });

  it("registers no listeners when there is no account address", async () => {
    state.polkadotAddress = null;
    mount(true);
    await flushRegistration();
    expect(tauri.event.listen).not.toHaveBeenCalled();
  });
});

describe("useFilesNotification — completion aggregation", () => {
  it("coalesces multiple cycles in the window into one summed notification", async () => {
    mount(true);
    await flushRegistration();

    await act(async () => {
      await tauri.emitEvent("hcfs_sync_completed", completed({ files_uploaded: 2 }));
    });
    // Before the window closes nothing is sent.
    expect(syncNotificationCalls()).toHaveLength(0);

    await advance(AGGREGATION_MS - 1);
    // A second cycle resets the sliding window AND adds to the counts.
    await act(async () => {
      await tauri.emitEvent("hcfs_sync_completed", completed({ files_uploaded: 84 }));
    });
    await advance(AGGREGATION_MS - 1);
    expect(syncNotificationCalls()).toHaveLength(0);

    await advance(1);
    const calls = syncNotificationCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      description: "86 files uploaded.",
      outcome: "success",
      userAddress: "5poll",
    });
  });

  it("ignores an all-zero completion (no notification)", async () => {
    mount(true);
    await flushRegistration();
    await act(async () => {
      await tauri.emitEvent("hcfs_sync_completed", completed({ files_uploaded: 0 }));
    });
    await advance(AGGREGATION_MS);
    expect(syncNotificationCalls()).toHaveLength(0);
  });

  it("caps the file-detail buffer at 200 while keeping the count accurate", async () => {
    mount(true);
    await flushRegistration();
    await act(async () => {
      await tauri.emitEvent("hcfs_sync_completed", completed({ files_uploaded: 250, fileCount: 250 }));
    });
    await advance(AGGREGATION_MS);

    const args = syncNotificationCalls()[0]?.[1] as { description: string; fileDetailsJson: string };
    expect(args.description).toBe("250 files uploaded."); // count is NOT truncated
    expect(JSON.parse(args.fileDetailsJson)).toHaveLength(200); // detail list IS capped
  });

  it("prefers the OAuth substrate address over the polkadot address", async () => {
    state.oauthSession = { substrateAddress: "5oauth" };
    mount(true);
    await flushRegistration();
    await act(async () => {
      await tauri.emitEvent("hcfs_sync_completed", completed({ files_uploaded: 1 }));
    });
    await advance(AGGREGATION_MS);
    expect(syncNotificationCalls()[0]?.[1]).toMatchObject({ userAddress: "5oauth" });
  });

  it("does not flush after unmount (the pending debounce is cancelled)", async () => {
    const { unmount } = mount(true);
    await flushRegistration();
    await act(async () => {
      await tauri.emitEvent("hcfs_sync_completed", completed({ files_uploaded: 5 }));
    });
    unmount();
    await advance(AGGREGATION_MS);
    expect(syncNotificationCalls()).toHaveLength(0);
  });
});

describe("useFilesNotification — failure path", () => {
  it("raises an error notification immediately, without the debounce window", async () => {
    mount(true);
    await flushRegistration();
    await act(async () => {
      await tauri.emitEvent("hcfs_sync_failed_notify", { label: "photos", error: "boom" });
    });
    // No timer advance — the error path is not debounced.
    const calls = syncNotificationCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      outcome: "error",
      description: 'Sync failed for folder "photos": boom',
    });
  });

  it("falls back to the 'default' label when the failure payload omits it", async () => {
    mount(true);
    await flushRegistration();
    await act(async () => {
      await tauri.emitEvent("hcfs_sync_failed_notify", { error: "down" });
    });
    expect(syncNotificationCalls()[0]?.[1]).toMatchObject({
      description: 'Sync failed for folder "default": down',
    });
  });
});
