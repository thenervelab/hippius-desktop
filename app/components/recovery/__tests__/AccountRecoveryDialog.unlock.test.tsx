// Unlock-branch behavior of the account recovery dialog.
//
// Regression coverage (audit H-4 residue, banner report 2026-08-19): the
// "Sync needs your seed phrase / unlock password" banner
// (`syncRequiresReauthAtom`) can be up while the Unlock dialog runs — the
// mnemonic-labelled restore path raises it directly, and the OAuth
// banner's own CTA opens this dialog. A successful unlock caches the
// mnemonic and makes files decryptable again, so it must CLEAR the
// banner; before this wiring it lingered until the next restart. A
// failed unlock must leave both the banner and the dialog in place.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import AccountRecoveryDialog from "../AccountRecoveryDialog";
import {
  activeRecoveryCheckAtom,
  type RecoveryCheck,
} from "@/app/lib/global-atoms/recoveryAtoms";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// authType drives the seed-phrase escape affordance.
const authState = vi.hoisted(() => ({ authType: "oauth" as string | null }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ authType: authState.authType }),
}));

const recoveryMocks = vi.hoisted(() => ({
  recoverMnemonic: vi.fn(),
  checkRecoveryState: vi.fn(),
  markRecoverySkipped: vi.fn(),
  sealAndUploadMnemonic: vi.fn(),
  validateRecoveryPassword: vi.fn().mockResolvedValue({
    bits: 0,
    verdict: "weak",
    label: "Weak",
    progressPercent: 0,
    hints: [],
    acceptableForSubmit: false,
  }),
}));
vi.mock("@/app/lib/utils/recovery", () => recoveryMocks);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

const unlockCheck: RecoveryCheck = {
  hasServerBlob: true,
  hasLocalMnemonic: true,
  updatedAt: null,
  recommendedFlow: "unlock",
};

function renderUnlockDialog() {
  const store = createStore();
  store.set(activeRecoveryCheckAtom, unlockCheck);
  store.set(syncRequiresReauthAtom, true);
  render(
    <Provider store={store}>
      <AccountRecoveryDialog />
    </Provider>
  );
  return store;
}

async function typePasswordAndUnlock() {
  fireEvent.change(screen.getByPlaceholderText("Enter your unlock password"), {
    target: { value: "correct horse battery staple" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.authType = "oauth";
});

describe("AccountRecoveryDialog — Unlock branch", () => {
  it("a successful unlock clears the reauth banner and closes the dialog", async () => {
    recoveryMocks.recoverMnemonic.mockResolvedValue(undefined);
    const store = renderUnlockDialog();

    await typePasswordAndUnlock();

    await waitFor(() => expect(store.get(syncRequiresReauthAtom)).toBe(false));
    expect(store.get(activeRecoveryCheckAtom)).toBeNull();
  });

  it("a failed unlock keeps the banner and the dialog", async () => {
    recoveryMocks.recoverMnemonic.mockRejectedValue(new Error("Wrong passphrase."));
    const store = renderUnlockDialog();

    await typePasswordAndUnlock();

    await waitFor(() => expect(screen.getByText("Wrong passphrase.")).toBeInTheDocument());
    expect(store.get(syncRequiresReauthAtom)).toBe(true);
    expect(store.get(activeRecoveryCheckAtom)).toEqual(unlockCheck);
  });

  // The preventClose dialog must not be a dead end for mnemonic users:
  // they hold a second recovery path (the seed phrase) that OAuth users
  // don't, so only they get the escape (PR #124 review P2-3).
  it("mnemonic user: offers the seed-phrase escape, which closes the dialog and routes to the login form", async () => {
    authState.authType = "mnemonic";
    const store = renderUnlockDialog();

    fireEvent.click(
      screen.getByRole("button", { name: /sign in with your recovery phrase instead/i })
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/login?reauth=1"));
    expect(store.get(activeRecoveryCheckAtom)).toBeNull();
    // The banner atom is deliberately untouched — the login page's reauth
    // mode requires it, and the seed-phrase re-entry is what clears it.
    expect(store.get(syncRequiresReauthAtom)).toBe(true);
  });

  it("oauth user: no seed-phrase escape is offered", () => {
    renderUnlockDialog();
    expect(
      screen.queryByRole("button", { name: /recovery phrase instead/i })
    ).not.toBeInTheDocument();
  });
});
