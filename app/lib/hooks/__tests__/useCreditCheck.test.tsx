import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

import { useCreditCheck } from "../useCreditCheck";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";

// ── Mocks ────────────────────────────────────────────────────────────
//
// `invoke` is reprogrammed per-test. Default = resolve to an eligible
// result so positive paths don't have to set it.
let nextInvokeResult: unknown = { eligible: true, reason: null, currentBalance: 100, requiredBalance: 0 };
let nextInvokeRejects: Error | null = null;

// Called with `(command, args)`; the args are asserted per test.
const invokeMock = vi.fn((...callArgs: unknown[]) => {
  void callArgs;
  if (nextInvokeRejects) return Promise.reject(nextInvokeRejects);
  return Promise.resolve(nextInvokeResult);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) =>
    invokeMock(command, args),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5TestAddress" }),
}));

// This account's own plan, as Overview reports it. Reprogrammed per test.
let overview: Record<string, unknown> = { source: "free", usedBytes: 0, totalBytes: 10_000_000_000 };
vi.mock("@/app/lib/hooks/api/useStorageOverview", () => ({
  useStorageOverview: () => ({ data: overview }),
}));

function renderWithStore() {
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const { result } = renderHook(() => useCreditCheck(), { wrapper });
  return { store, result };
}

describe("useCreditCheck", () => {
  beforeEach(() => {
    nextInvokeResult = { eligible: true, reason: null, currentBalance: 100, requiredBalance: 0 };
    nextInvokeRejects = null;
    overview = { source: "free", usedBytes: 0, totalBytes: 10_000_000_000 };
    toastError.mockReset();
    invokeMock.mockClear();
  });

  it("returns true and does not open the dialog when eligible", async () => {
    const { store, result } = renderWithStore();

    let ok = false;
    await act(async () => {
      ok = await result.current.checkEligibility("file-upload");
    });

    expect(ok).toBe(true);
    expect(store.get(insufficientCreditsDialogOpenAtom)).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("opens the Insufficient Credits dialog when the server says ineligible", async () => {
    nextInvokeResult = { eligible: false, reason: "insufficient_credits", currentBalance: 0, requiredBalance: 0 };

    const { store, result } = renderWithStore();

    let ok = true;
    await act(async () => {
      ok = await result.current.checkEligibility("file-upload");
    });

    expect(ok).toBe(false);
    expect(store.get(insufficientCreditsDialogOpenAtom)).toBe("file-upload");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast but does NOT open the Insufficient Credits dialog when the IPC rejects", async () => {
    // Regression: a hung/failed `check_action_eligibility` IPC (e.g. a
    // billing-server blip) used to be treated as "ineligible" and
    // opened the credits dialog — users with ample credits got the
    // wrong explanation. The new behavior surfaces a generic network
    // toast and leaves the credits dialog closed.
    nextInvokeRejects = new Error("network unreachable");

    const { store, result } = renderWithStore();

    let ok = true;
    await act(async () => {
      ok = await result.current.checkEligibility("file-upload");
    });

    expect(ok).toBe(false);
    expect(store.get(insufficientCreditsDialogOpenAtom)).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  // A drive shared with this account is paid for by its owner. A member
  // with no plan of their own (an access-key account) was sent to buy one
  // before uploading into it, because the click was judged on Overview,
  // which only knows this account's own plan.
  describe("a drive shared with this account", () => {
    const SHARED = "shared:5Owner~0123456789abcdef";

    beforeEach(() => {
      overview = { source: "none", usedBytes: 0, totalBytes: 0 };
    });

    it("still refuses this account's own drive on its own plan", async () => {
      const { store, result } = renderWithStore();

      let ok = true;
      await act(async () => {
        ok = await result.current.requireUploadRoom("file-upload");
      });

      expect(ok).toBe(false);
      expect(store.get(insufficientCreditsDialogOpenAtom)).toBe("file-upload");
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("still refuses an own drive named by label when Rust says it is not shared", async () => {
      nextInvokeResult = { eligible: true, reason: null, currentBalance: 0, requiredBalance: 0, ownerPays: false };
      const { store, result } = renderWithStore();

      let ok = true;
      await act(async () => {
        ok = await result.current.requireUploadRoom("file-upload", false, "Mine");
      });

      expect(ok).toBe(false);
      expect(store.get(insufficientCreditsDialogOpenAtom)).toBe("file-upload");
    });

    it("lets a member with no plan upload when the owner has room", async () => {
      nextInvokeResult = { eligible: true, reason: null, currentBalance: 0, requiredBalance: 0, ownerPays: true };
      const { store, result } = renderWithStore();

      let ok = false;
      await act(async () => {
        ok = await result.current.requireUploadRoom("folder-upload", true, SHARED);
      });

      expect(ok).toBe(true);
      expect(store.get(insufficientCreditsDialogOpenAtom)).toBe(false);
      expect(toastError).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith("check_action_eligibility", {
        accountId: "5TestAddress",
        action: "folder-upload",
        driveLabel: SHARED,
      });
    });

    it("says the owner is out of room, never offers the member a plan", async () => {
      const sentence = "This shared drive is out of space. Its owner needs more storage before anything else can be added.";
      nextInvokeResult = {
        eligible: false,
        reason: "shared_drive_full",
        currentBalance: 0,
        requiredBalance: 0,
        ownerPays: true,
        message: sentence,
      };
      const { store, result } = renderWithStore();

      let ok = true;
      await act(async () => {
        ok = await result.current.checkEligibility("file-upload", SHARED);
      });

      expect(ok).toBe(false);
      expect(store.get(insufficientCreditsDialogOpenAtom)).toBe(false);
      expect(toastError).toHaveBeenCalledWith(sentence);
    });
  });
});
