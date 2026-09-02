// Signup-branch behavior after a refused seal.
//
// Rust's `seal_and_upload_mnemonic` now re-probes the server right before
// its POST and refuses when an unlock password already exists (Hippius
// Console can set one while this dialog is open). The branch must show
// that refusal readably and re-run the Rust recovery check so the dialog
// routes to Unlock, instead of leaving the user on a "Create Password"
// form that can never succeed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import AccountRecoveryDialog from "../AccountRecoveryDialog";
import {
  activeRecoveryCheckAtom,
  type RecoveryCheck,
} from "@/app/lib/global-atoms/recoveryAtoms";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ authType: "oauth" }),
}));

const recoveryMocks = vi.hoisted(() => ({
  recoverMnemonic: vi.fn(),
  restoreWithMnemonic: vi.fn(),
  checkRecoveryState: vi.fn(),
  markRecoverySkipped: vi.fn(),
  sealAndUploadMnemonic: vi.fn(),
  validateRecoveryPassword: vi.fn(),
}));
vi.mock("@/app/lib/utils/recovery", () => recoveryMocks);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

const signupCheck: RecoveryCheck = {
  hasServerBlob: false,
  hasLocalMnemonic: false,
  updatedAt: null,
  recommendedFlow: "signup",
};

const unlockCheck: RecoveryCheck = {
  hasServerBlob: true,
  hasLocalMnemonic: false,
  updatedAt: null,
  recommendedFlow: "unlock",
};

const ALREADY_SET = {
  kind: "Validation",
  message:
    "An unlock password is already set for this account — it may have been set on Hippius Console or another device. Unlock with that password instead of creating a new one.",
};

const STRONG = "correct horse battery staple extra";

function renderSignupDialog() {
  const store = createStore();
  store.set(activeRecoveryCheckAtom, signupCheck);
  render(
    <Provider store={store}>
      <AccountRecoveryDialog />
    </Provider>
  );
  return store;
}

async function fillAndSave() {
  fireEvent.change(screen.getByPlaceholderText("Create a Strong Password"), {
    target: { value: STRONG },
  });
  fireEvent.change(screen.getByPlaceholderText("Confirm Your Password"), {
    target: { value: STRONG },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /save password/i })).not.toBeDisabled()
  );
  fireEvent.click(screen.getByRole("button", { name: /save password/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  recoveryMocks.validateRecoveryPassword.mockResolvedValue({
    bits: 80,
    verdict: "strong",
    label: "Strong",
    progressPercent: 100,
    hints: [],
    acceptableForSubmit: true,
  });
});

describe("AccountRecoveryDialog — Signup branch after a refused seal", () => {
  it("shows the Rust refusal and re-routes to Unlock when the re-check says a blob exists", async () => {
    recoveryMocks.sealAndUploadMnemonic.mockRejectedValue(ALREADY_SET);
    recoveryMocks.checkRecoveryState.mockResolvedValue(unlockCheck);
    const store = renderSignupDialog();

    await fillAndSave();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("already set for this account")
      )
    );
    await waitFor(() =>
      expect(store.get(activeRecoveryCheckAtom)).toEqual(unlockCheck)
    );
    expect(
      screen.getByPlaceholderText("Enter your unlock password")
    ).toBeInTheDocument();
    expect(recoveryMocks.sealAndUploadMnemonic).toHaveBeenCalledTimes(1);
  });

  it("stays on Signup when the re-check itself fails", async () => {
    recoveryMocks.sealAndUploadMnemonic.mockRejectedValue(ALREADY_SET);
    recoveryMocks.checkRecoveryState.mockRejectedValue(new Error("offline"));
    const store = renderSignupDialog();

    await fillAndSave();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save password/i })).not.toBeDisabled()
    );
    expect(store.get(activeRecoveryCheckAtom)).toEqual(signupCheck);
    expect(
      screen.getByPlaceholderText("Create a Strong Password")
    ).toBeInTheDocument();
  });
});
