import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChangeRecoveryPasswordDialog from "../ChangeRecoveryPasswordDialog";
import { seedWordsFor } from "../_shared";

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

// Rust's `AppError` as it crosses IPC (`src-tauri/src/error.rs`).
const SEED_REQUIRED = {
  kind: "NotReady",
  subkind: "RECOVERY_SEED_REQUIRED",
  message: "Enter your recovery seed to set a new unlock password.",
};
const WRONG_PASSWORD = { kind: "WrongUnlockPassword", message: "Wrong password. Try again." };

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
      screen.queryByPlaceholderText(/12-word recovery seed/i)
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
SEED_REQUIRED
    );
    render(
      <ChangeRecoveryPasswordDialog open onOpenChange={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: /forgot current password/i }));
    await fillNewPassword();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/12-word recovery seed/i)
      ).toBeInTheDocument()
    );
    const seedField = screen.getByPlaceholderText(/12-word recovery seed/i);
    expect(seedField.parentElement?.className).toContain("rounded-[8px]");
    expect(seedField.parentElement?.className).toContain("dark:border-[#494949]");
    expect(recoveryMocks.restoreWithMnemonic).not.toHaveBeenCalled();
  });

  it("phrase form restores with the typed seed and new password", async () => {
    recoveryMocks.resetUnlockPassword.mockRejectedValue(
SEED_REQUIRED
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
        screen.getByPlaceholderText(/12-word recovery seed/i)
      ).toBeInTheDocument()
    );

    fireEvent.change(screen.getByPlaceholderText(/12-word recovery seed/i), {
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

  it("names the access key for an account that signs in with it", async () => {
    recoveryMocks.resetUnlockPassword.mockRejectedValue(SEED_REQUIRED);
    render(
      <ChangeRecoveryPasswordDialog
        open
        onOpenChange={vi.fn()}
        seedWords={seedWordsFor("mnemonic")}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /forgot current password/i }));
    await fillNewPassword();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/12-word access key/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/enter your access key and choose a new unlock password/i)).toBeInTheDocument();
  });

  it("does not switch forms on wording alone: only the structured subkind does", async () => {
    recoveryMocks.resetUnlockPassword.mockRejectedValue(
      new Error("Enter your recovery seed to set a new unlock password.")
    );
    render(<ChangeRecoveryPasswordDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /forgot current password/i }));
    await fillNewPassword();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText(/12-word recovery seed/i)).not.toBeInTheDocument();
  });
});

describe("ChangeRecoveryPasswordDialog, wrong current password", () => {
  it("shows Rust's message inline, keeps the typed password and selects it", async () => {
    recoveryMocks.changeRecoveryPassword.mockRejectedValue(WRONG_PASSWORD);
    render(<ChangeRecoveryPasswordDialog open onOpenChange={vi.fn()} />);

    const current = screen.getByPlaceholderText("Enter your current password") as HTMLInputElement;
    fireEvent.change(current, { target: { value: "not my password" } });
    await fillNewPassword();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Wrong password. Try again.");
    expect(current).toHaveAttribute("aria-invalid", "true");
    expect(current.getAttribute("aria-describedby")).toContain(alert.id);
    expect(current.value).toBe("not my password");
    await waitFor(() => expect(document.activeElement).toBe(current));
    expect(current.selectionStart).toBe(0);
    expect(current.selectionEnd).toBe("not my password".length);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
