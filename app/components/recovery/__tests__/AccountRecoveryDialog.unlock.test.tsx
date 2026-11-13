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
  canDecryptLocal: false,
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

// Rust's `AppError` as it crosses IPC (`src-tauri/src/error.rs`).
const WRONG_PASSWORD = { kind: "WrongUnlockPassword", message: "Wrong password. Try again." };

function passwordField() {
  return screen.getByPlaceholderText("Enter your unlock password") as HTMLInputElement;
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

  it("a wrong password keeps the banner and the dialog, and says so in plain words", async () => {
    recoveryMocks.recoverMnemonic.mockRejectedValue(WRONG_PASSWORD);
    const store = renderUnlockDialog();

    await typePasswordAndUnlock();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Wrong password. Try again.");
    expect(store.get(syncRequiresReauthAtom)).toBe(true);
    expect(store.get(activeRecoveryCheckAtom)).toEqual(unlockCheck);
  });

  it("after a wrong password the typed value stays, selected, and the error is wired to the field", async () => {
    recoveryMocks.recoverMnemonic.mockRejectedValue(WRONG_PASSWORD);
    renderUnlockDialog();

    await typePasswordAndUnlock();

    const alert = await screen.findByRole("alert");
    const field = passwordField();
    expect(field.value).toBe("correct horse battery staple");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("correct horse battery staple".length);

    // Typing clears the error straight away.
    fireEvent.change(field, { target: { value: "correct horse battery stapler" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "false");
  });

  it("opens with the password field focused and ready for a password manager", async () => {
    renderUnlockDialog();
    const field = passwordField();
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByText("Enter your unlock password to open your files on this computer.")).toBeInTheDocument();
  });

  it("Enter submits, and the form stays while the password is checked", async () => {
    let finish: (v?: unknown) => void = () => {};
    recoveryMocks.recoverMnemonic.mockImplementation(
      () => new Promise((resolve) => (finish = resolve))
    );
    renderUnlockDialog();

    const field = passwordField();
    fireEvent.change(field, { target: { value: "correct horse battery staple" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(recoveryMocks.recoverMnemonic).toHaveBeenCalledWith("correct horse battery staple"));
    const busy = screen.getByRole("button", { name: /unlocking…/i });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(passwordField().value).toBe("correct horse battery staple");

    finish();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Account unlocked."));
  });

  it("the show/hide button is reachable by keyboard and says what it does", () => {
    renderUnlockDialog();
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).not.toHaveAttribute("tabindex", "-1");

    fireEvent.click(toggle);
    expect(passwordField()).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
  });

  it("says when Caps Lock is on", () => {
    renderUnlockDialog();
    const field = passwordField();

    fireEvent.keyDown(field, { key: "A", modifierCapsLock: true });
    const note = screen.getByText("Caps Lock is on.");
    expect(field.getAttribute("aria-describedby")).toContain(note.id);

    fireEvent.keyUp(field, { key: "a", modifierCapsLock: false });
    expect(screen.queryByText("Caps Lock is on.")).not.toBeInTheDocument();
  });

  it("Forgot your password? reports whether it is expanded", () => {
    renderUnlockDialog();
    const forgot = screen.getByRole("button", { name: /forgot your password/i });
    expect(forgot).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(forgot);
    expect(forgot).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(forgot.getAttribute("aria-controls") ?? "")).not.toBeNull();
    fireEvent.click(forgot);
    expect(forgot).toHaveAttribute("aria-expanded", "false");
  });

  // The preventClose dialog must not be a dead end for mnemonic users:
  // they hold a second way back (signing in with their access key) that
  // OAuth users don't, so only they get the escape (PR #124 review P2-3).
  it("mnemonic user: offers signing in with the access key, which closes the dialog and routes to the login form", async () => {
    authState.authType = "mnemonic";
    const store = renderUnlockDialog();

    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign in with your access key/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/login?reauth=1"));
    expect(store.get(activeRecoveryCheckAtom)).toBeNull();
    // The banner atom is deliberately untouched — the login page's reauth
    // mode requires it, and the access-key sign-in is what clears it.
    expect(store.get(syncRequiresReauthAtom)).toBe(true);
  });

  it("oauth user: no access-key sign-in is offered", () => {
    renderUnlockDialog();
    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    expect(
      screen.queryByRole("button", { name: /sign in with your access key/i })
    ).not.toBeInTheDocument();
  });

  it("mnemonic user: the restore form asks for the access key", () => {
    authState.authType = "mnemonic";
    renderUnlockDialog();

    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    fireEvent.click(screen.getByRole("button", { name: /set a new password/i }));

    expect(screen.getByText("Restore Access")).toBeInTheDocument();
    expect(screen.getByLabelText("Access Key")).toBe(
      screen.getByPlaceholderText(/12-word access key/i)
    );
    expect(screen.getByText("Enter your access key and choose a new unlock password.")).toBeInTheDocument();
  });

  it("oauth user: forgot-password offers in-dialog recovery seed restore, not login", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: /use your recovery seed/i }));

    expect(screen.getByText("Restore Access")).toBeInTheDocument();
    const seedField = screen.getByPlaceholderText(/12-word recovery seed/i);
    expect(seedField).toBeInTheDocument();
    expect(seedField.tagName).toBe("TEXTAREA");
    expect(seedField.parentElement?.className).toContain("rounded-[8px]");
    expect(seedField.parentElement?.className).toContain("dark:border-[#494949]");
    expect(screen.getByLabelText("Recovery Seed")).toBe(seedField);
    expect(
      screen.queryByRole("button", { name: /sign in with your access key/i })
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/12-word recovery seed/i), {
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
    fireEvent.click(screen.getByRole("button", { name: /use your recovery seed/i }));
    fireEvent.change(screen.getByPlaceholderText(/12-word recovery seed/i), {
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
      /finishes applying to your synced folders/i
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
      { kind: "Validation", message: "These words don't match this account's files. Check them and try again." }
    );
    const store = renderUnlockDialog();

    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    fireEvent.click(screen.getByRole("button", { name: /use your recovery seed/i }));
    fireEvent.change(screen.getByPlaceholderText(/12-word recovery seed/i), {
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
        screen.getByText(/don't match this account's files/i)
      ).toBeInTheDocument()
    );
    expect(store.get(activeRecoveryCheckAtom)).toEqual(unlockCheck);
    expect(store.get(syncRequiresReauthAtom)).toBe(true);
  });

  // We cannot reset the password, and the copy says so without the
  // jargon it used to carry ("passphrase", "mnemonic seed", "unwrap").
  // It must also never claim files are encrypted with the password: that
  // tells people with their words written down that their files are gone.
  const BANNED = /passphrase|mnemonic|unwrap|bip-?39|decrypt|encrypted with this password/i;

  it("oauth forgot-password copy says we can't reset it and points to the recovery seed", () => {
    renderUnlockDialog();
    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    const explainer = screen.getByText(/we can't reset it/i);
    expect(explainer.textContent).toMatch(/recovery seed/i);
    expect(explainer.textContent).not.toMatch(BANNED);
    expect(screen.getByRole("button", { name: /use your recovery seed/i })).toBeInTheDocument();
  });

  it("mnemonic forgot-password copy says we can't reset it and points to the access key", () => {
    authState.authType = "mnemonic";
    renderUnlockDialog();
    fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
    const explainer = screen.getByText(/we can't reset it/i);
    expect(explainer.textContent).toMatch(/access key/i);
    expect(explainer.textContent).not.toMatch(BANNED);
  });

  it("no user-facing text in the unlock prompt uses the old jargon", () => {
    for (const auth of ["oauth", "mnemonic"]) {
      authState.authType = auth;
      const { unmount } = render(
        <Provider store={(() => {
          const st = createStore();
          st.set(activeRecoveryCheckAtom, unlockCheck);
          return st;
        })()}>
          <AccountRecoveryDialog />
        </Provider>
      );
      fireEvent.click(screen.getByRole("button", { name: /forgot your password/i }));
      expect(document.body.textContent ?? "").not.toMatch(BANNED);
      unmount();
    }
  });
});
