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
  restoreWithMnemonic: vi.fn(),
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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";

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

  it("oauth user: no seed-phrase login escape is offered", () => {
    renderUnlockDialog();
    expect(
      screen.queryByRole("button", { name: /recovery phrase instead/i })
    ).not.toBeInTheDocument();
  });

  it("oauth user: forgot-password offers in-dialog mnemonic restore, not login", async () => {
    recoveryMocks.validateRecoveryPassword.mockResolvedValue({
      bits: 80,
      verdict: "strong",
      label: "Strong",
      progressPercent: 100,
      hints: [],
      acceptableForSubmit: true,
    });
    recoveryMocks.restoreWithMnemonic.mockResolvedValue({ alignPending: false });
    const store = renderUnlockDialog();

    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    fireEvent.click(screen.getByRole("button", { name: /use your mnemonic seed/i }));

    expect(screen.getByText("Restore Access")).toBeInTheDocument();
    const seedField = screen.getByPlaceholderText(/12-word seed phrase/i);
    expect(seedField).toBeInTheDocument();
    expect(seedField.tagName).toBe("TEXTAREA");
    expect(seedField.parentElement?.className).toContain("rounded-[8px]");
    expect(seedField.parentElement?.className).toContain("dark:border-[#494949]");
    expect(
      screen.queryByRole("button", { name: /recovery phrase instead/i })
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/12-word seed phrase/i), {
      target: { value: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter a Strong Password"), {
      target: { value: "correct horse battery staple extra" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm Your Password"), {
      target: { value: "correct horse battery staple extra" },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /restore and set password/i })
      ).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /restore and set password/i }));

    await waitFor(() =>
      expect(recoveryMocks.restoreWithMnemonic).toHaveBeenCalledWith(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        "correct horse battery staple extra"
      )
    );
    await waitFor(() => expect(store.get(activeRecoveryCheckAtom)).toBeNull());
    expect(store.get(syncRequiresReauthAtom)).toBe(false);
    expect(toast.success).toHaveBeenCalledWith(
      "Account unlocked. Unlock password updated."
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("oauth user: alignPending restore warns instead of claiming a clean success", async () => {
    recoveryMocks.validateRecoveryPassword.mockResolvedValue({
      bits: 80,
      verdict: "strong",
      label: "Strong",
      progressPercent: 100,
      hints: [],
      acceptableForSubmit: true,
    });
    recoveryMocks.restoreWithMnemonic.mockResolvedValue({ alignPending: true });
    renderUnlockDialog();

    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    fireEvent.click(screen.getByRole("button", { name: /use your mnemonic seed/i }));
    fireEvent.change(screen.getByPlaceholderText(/12-word seed phrase/i), {
      target: { value: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter a Strong Password"), {
      target: { value: "correct horse battery staple extra" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm Your Password"), {
      target: { value: "correct horse battery staple extra" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /restore and set password/i })
      ).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /restore and set password/i }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(String((toast.warning as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toMatch(
      /finishing applying the new password/i
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("oauth user: a failed phrase restore keeps the dialog", async () => {
    recoveryMocks.validateRecoveryPassword.mockResolvedValue({
      bits: 80,
      verdict: "strong",
      label: "Strong",
      progressPercent: 100,
      hints: [],
      acceptableForSubmit: true,
    });
    recoveryMocks.restoreWithMnemonic.mockRejectedValue(
      new Error("This recovery phrase does not match this account's files. Check the words and try again.")
    );
    const store = renderUnlockDialog();

    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    fireEvent.click(screen.getByRole("button", { name: /use your mnemonic seed/i }));
    fireEvent.change(screen.getByPlaceholderText(/12-word seed phrase/i), {
      target: { value: "legal winner thank year wave sausage worth useful legal winner thank yellow" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter a Strong Password"), {
      target: { value: "correct horse battery staple extra" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm Your Password"), {
      target: { value: "correct horse battery staple extra" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /restore and set password/i })
      ).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /restore and set password/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/does not match this account's files/i)
      ).toBeInTheDocument()
    );
    expect(store.get(activeRecoveryCheckAtom)).toEqual(unlockCheck);
    expect(store.get(syncRequiresReauthAtom)).toBe(true);
  });

  // The password wraps the seed; it does not encrypt files. Claiming
  // otherwise tells people with a written-down phrase that their files
  // are gone (the 2026-08-26 forgot-password report).
  it("oauth forgot-password copy does not claim files are encrypted with the password", () => {
    renderUnlockDialog();
    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    const explainer = screen.getByText(/mnemonic seed, not this password/i);
    expect(explainer).toBeInTheDocument();
    expect(explainer.textContent).not.toMatch(/encrypted with this password/i);
    expect(explainer.textContent).not.toMatch(/cannot be recovered without it/i);
  });

  it("mnemonic forgot-password copy still offers the seed-phrase path and does not blame the password for file encryption", () => {
    authState.authType = "mnemonic";
    renderUnlockDialog();
    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    const explainer = screen.getByText(/mnemonic seed, not this password/i);
    expect(explainer.textContent).toMatch(/sign in with it instead/i);
    expect(explainer.textContent).not.toMatch(/encrypted with this password/i);
    expect(
      screen.getByRole("button", { name: /sign in with your recovery phrase instead/i })
    ).toBeInTheDocument();
  });
});
