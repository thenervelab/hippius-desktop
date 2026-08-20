// Regression coverage for the reauth banner's auth-type branching
// (banner report 2026-08-19): an OAuth Google user was shown "Sync needs
// your seed phrase" with a CTA into the seed-phrase login form — a
// phrase OAuth users typically never saw. Their recovery affordance is
// the unlock (recovery) password dialog, chosen by Rust's
// `check_recovery_state`. The banner must:
//
//   - route mnemonic users straight to `/login?reauth=1` (unchanged);
//   - for OAuth users, re-run the recovery check and open
//     `AccountRecoveryDialog` (via `activeRecoveryCheckAtom`) for any
//     non-`proceed` flow;
//   - fall back to the seed-phrase form only when Rust answers
//     `proceed` (definitively nothing to unlock on the server).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import SyncReauthRequiredAlert from "../SyncReauthRequiredAlert";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import {
  activeRecoveryCheckAtom,
  type RecoveryCheck,
} from "@/app/lib/global-atoms/recoveryAtoms";

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// authType is the only field the component reads from the auth context.
const authState = vi.hoisted(() => ({ authType: "mnemonic" as string | null }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ authType: authState.authType }),
}));

const checkRecoveryStateMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/utils/recovery", () => ({
  checkRecoveryState: checkRecoveryStateMock,
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

function makeCheck(flow: RecoveryCheck["recommendedFlow"]): RecoveryCheck {
  return {
    hasServerBlob: flow === "unlock",
    hasLocalMnemonic: true,
    updatedAt: null,
    recommendedFlow: flow,
  };
}

function renderBanner(needsReauth = true) {
  const store = createStore();
  store.set(syncRequiresReauthAtom, needsReauth);
  render(
    <Provider store={store}>
      <SyncReauthRequiredAlert />
    </Provider>
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.authType = "mnemonic";
});

describe("SyncReauthRequiredAlert", () => {
  it("renders nothing when reauth is not required", () => {
    renderBanner(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("mnemonic user: shows seed-phrase copy and routes straight to the login form", () => {
    renderBanner();
    expect(screen.getByText("Sync needs your seed phrase")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /re-enter seed phrase/i }));

    expect(pushMock).toHaveBeenCalledWith("/login?reauth=1");
    // The seed-phrase path must never consult the recovery probe.
    expect(checkRecoveryStateMock).not.toHaveBeenCalled();
  });

  it("oauth user: shows unlock-password copy, never seed-phrase copy", () => {
    authState.authType = "oauth";
    renderBanner();
    expect(screen.getByText("Sync needs your unlock password")).toBeInTheDocument();
    expect(screen.queryByText(/seed phrase/i)).not.toBeInTheDocument();
  });

  it("oauth user with a server blob: opens the recovery dialog instead of the login form", async () => {
    authState.authType = "oauth";
    const check = makeCheck("unlock");
    checkRecoveryStateMock.mockResolvedValue(check);
    const store = renderBanner();

    fireEvent.click(screen.getByRole("button", { name: /enter unlock password/i }));

    await waitFor(() => expect(store.get(activeRecoveryCheckAtom)).toEqual(check));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("oauth user with a failed probe (unknown): opens the retry dialog, not the login form", async () => {
    authState.authType = "oauth";
    const check = makeCheck("unknown");
    checkRecoveryStateMock.mockResolvedValue(check);
    const store = renderBanner();

    fireEvent.click(screen.getByRole("button", { name: /enter unlock password/i }));

    await waitFor(() => expect(store.get(activeRecoveryCheckAtom)).toEqual(check));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("oauth user with nothing to unlock (proceed): falls back to the seed-phrase form", async () => {
    authState.authType = "oauth";
    checkRecoveryStateMock.mockResolvedValue(makeCheck("proceed"));
    const store = renderBanner();

    fireEvent.click(screen.getByRole("button", { name: /enter unlock password/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/login?reauth=1"));
    expect(store.get(activeRecoveryCheckAtom)).toBeNull();
  });

  it("oauth user with a thrown recovery check: surfaces a toast and keeps the banner actionable", async () => {
    authState.authType = "oauth";
    checkRecoveryStateMock.mockRejectedValue(new Error("network down"));
    const store = renderBanner();

    const cta = screen.getByRole("button", { name: /enter unlock password/i });
    fireEvent.click(cta);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
    expect(store.get(activeRecoveryCheckAtom)).toBeNull();
    // Button re-enables so the user can retry.
    await waitFor(() => expect(cta).toBeEnabled());
  });
});
