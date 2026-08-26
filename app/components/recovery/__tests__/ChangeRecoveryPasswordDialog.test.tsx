import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChangeRecoveryPasswordDialog from "../ChangeRecoveryPasswordDialog";

const recoveryMocks = vi.hoisted(() => ({
  changeRecoveryPassword: vi.fn(),
  resetUnlockPassword: vi.fn(),
  restoreWithMnemonic: vi.fn(),
  validateRecoveryPassword: vi.fn().mockResolvedValue({
    bits: 80,
    verdict: "strong",
    label: "Strong",
    progressPercent: 100,
    hints: [],
    acceptableForSubmit: true,
  }),
}));
vi.mock("@/app/lib/utils/recovery", () => recoveryMocks);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import { toast } from "sonner";

const STRONG = "correct horse battery staple extra";

async function fillNewPassword() {
  fireEvent.change(screen.getByPlaceholderText("Enter a strong password"), {
    target: { value: STRONG },
  });
  fireEvent.change(screen.getByPlaceholderText("Confirm your password"), {
    target: { value: STRONG },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /change password/i })).not.toBeDisabled()
  );
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

describe("ChangeRecoveryPasswordDialog — forgot current password", () => {
  it("session already has the mnemonic: resetUnlockPassword, no phrase field", async () => {
    recoveryMocks.resetUnlockPassword.mockResolvedValue({ alignPending: false });
    render(
      <ChangeRecoveryPasswordDialog open onOpenChange={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: /forgot current password/i }));
    expect(
      screen.queryByPlaceholderText(/12-word seed phrase/i)
    ).not.toBeInTheDocument();

    await fillNewPassword();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() =>
      expect(recoveryMocks.resetUnlockPassword).toHaveBeenCalledWith(STRONG)
    );
    expect(recoveryMocks.changeRecoveryPassword).not.toHaveBeenCalled();
    expect(recoveryMocks.restoreWithMnemonic).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it("session cannot open the mnemonic: switches to the seed form", async () => {
    recoveryMocks.resetUnlockPassword.mockRejectedValue(
      new Error(
        "This device doesn't have your mnemonic seed unlocked. Enter the seed to restore."
      )
    );
    render(
      <ChangeRecoveryPasswordDialog open onOpenChange={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: /forgot current password/i }));
    await fillNewPassword();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/12-word seed phrase/i)
      ).toBeInTheDocument()
    );
    const seedField = screen.getByPlaceholderText(/12-word seed phrase/i);
    expect(seedField.parentElement?.className).toContain("rounded-[8px]");
    expect(seedField.parentElement?.className).toContain("dark:border-[#494949]");
    expect(recoveryMocks.restoreWithMnemonic).not.toHaveBeenCalled();
  });

  it("phrase form restores with the typed seed and new password", async () => {
    recoveryMocks.resetUnlockPassword.mockRejectedValue(
      new Error(
        "This device doesn't have your mnemonic seed unlocked. Enter the seed to restore."
      )
    );
    recoveryMocks.restoreWithMnemonic.mockResolvedValue({ alignPending: false });
    render(
      <ChangeRecoveryPasswordDialog open onOpenChange={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: /forgot current password/i }));
    await fillNewPassword();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/12-word seed phrase/i)
      ).toBeInTheDocument()
    );

    fireEvent.change(screen.getByPlaceholderText(/12-word seed phrase/i), {
      target: {
        value:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() =>
      expect(recoveryMocks.restoreWithMnemonic).toHaveBeenCalledWith(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        STRONG
      )
    );
  });
});
