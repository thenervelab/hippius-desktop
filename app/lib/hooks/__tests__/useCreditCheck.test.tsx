import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

import { useCreditCheck } from "../useCreditCheck";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/files/atoms/query-atoms";

// ── Mocks ────────────────────────────────────────────────────────────
//
// `invoke` is reprogrammed per-test. Default = resolve to an eligible
// result so positive paths don't have to set it.
let nextInvokeResult: unknown = { eligible: true, reason: null, currentBalance: 100, requiredBalance: 0 };
let nextInvokeRejects: Error | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => {
    if (nextInvokeRejects) return Promise.reject(nextInvokeRejects);
    return Promise.resolve(nextInvokeResult);
  }),
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
    toastError.mockReset();
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
});
