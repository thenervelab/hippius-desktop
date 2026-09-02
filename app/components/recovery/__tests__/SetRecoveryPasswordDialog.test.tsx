// Error callback of the Settings "set unlock password" dialog.
//
// Rust refuses to seal when an unlock password already exists for the
// account (Hippius Console can set one while Settings is open). The
// dialog reports that through `onError` so the Settings row can re-probe
// and flip to "Change Unlock Password"; a refusal must never fire
// `onSuccess`, which the parent treats as "a blob now exists because WE
// wrote it".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import SetRecoveryPasswordDialog from "../SetRecoveryPasswordDialog";

const recoveryMocks = vi.hoisted(() => ({
  sealAndUploadMnemonic: vi.fn(),
  validateRecoveryPassword: vi.fn(),
}));
vi.mock("@/app/lib/utils/recovery", () => recoveryMocks);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";

const STRONG = "correct horse battery staple extra";

async function fillAndCreate() {
  fireEvent.change(screen.getByPlaceholderText("Create a Strong Password"), {
    target: { value: STRONG },
  });
  fireEvent.change(screen.getByPlaceholderText("Confirm Your Password"), {
    target: { value: STRONG },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /create password/i })).not.toBeDisabled()
  );
  fireEvent.click(screen.getByRole("button", { name: /create password/i }));
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

describe("SetRecoveryPasswordDialog — refused seal", () => {
  it("calls onError (not onSuccess), shows the Rust message, and stays open", async () => {
    recoveryMocks.sealAndUploadMnemonic.mockRejectedValue({
      kind: "Validation",
      message: "An unlock password is already set for this account.",
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SetRecoveryPasswordDialog
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        onError={onError}
      />
    );

    await fillAndCreate();

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("already set for this account")
    );
  });

  it("a successful seal calls onSuccess and closes without onError", async () => {
    recoveryMocks.sealAndUploadMnemonic.mockResolvedValue(undefined);
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SetRecoveryPasswordDialog
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        onError={onError}
      />
    );

    await fillAndCreate();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onError).not.toHaveBeenCalled();
  });
});
