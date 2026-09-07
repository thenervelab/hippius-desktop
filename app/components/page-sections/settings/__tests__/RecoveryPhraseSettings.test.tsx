// Click-time re-probe of the Unlock Password row.
//
// The row used to pick "Set" vs "Change Unlock Password" from a
// `hasServerBlob` read once at mount. Hippius Console can now set the
// unlock password too, so a page left open while the user finished setup
// on the console would offer "Set" — whose Rust command upserts the blob —
// over a password that already exists. The row must ask Rust again at
// click time and open the dialog for THAT answer; a failed re-probe falls
// back to the last-known state rather than blocking the user.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import RecoveryPhraseSettings from "../RecoveryPhraseSettings";
import type { RecoveryCheck } from "@/app/lib/global-atoms/recoveryAtoms";

const recoveryMocks = vi.hoisted(() => ({
  checkRecoveryState: vi.fn(),
}));
vi.mock("@/app/lib/utils/recovery", () => recoveryMocks);

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ getMnemonic: vi.fn(), polkadotAddress: null }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("react-intersection-observer", () => ({
  InView: ({
    children,
  }: {
    children: (args: {
      inView: boolean;
      ref: (node?: Element | null) => void;
    }) => React.ReactNode;
  }) => children({ inView: true, ref: () => {} }),
}));

// The dialogs are stubbed to a marker each: this test is about WHICH one
// opens, and the set-dialog stub exposes its `onError` so the flip after a
// refused seal can be exercised without the real form.
vi.mock("@/components/recovery/ChangeRecoveryPasswordDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="change-dialog" /> : null,
}));
vi.mock("@/components/recovery/SetRecoveryPasswordDialog", () => ({
  default: ({ open, onError }: { open: boolean; onError?: () => void }) =>
    open ? (
      <div data-testid="set-dialog">
        <button type="button" onClick={() => onError?.()}>
          simulate refused seal
        </button>
      </div>
    ) : null,
}));

function check(hasServerBlob: boolean): RecoveryCheck {
  return {
    hasServerBlob,
    hasLocalMnemonic: true,
    updatedAt: null,
    recommendedFlow: hasServerBlob ? "proceed" : "signup",
  };
}

async function renderWithNoBlobAtMount() {
  recoveryMocks.checkRecoveryState.mockResolvedValueOnce(check(false));
  render(<RecoveryPhraseSettings />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Set Unlock Password" })
    ).toBeInTheDocument()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` keeps queued `mockResolvedValueOnce` values; a case that
  // fails before consuming one would otherwise poison the next mount.
  recoveryMocks.checkRecoveryState.mockReset();
});

describe("RecoveryPhraseSettings — Unlock Password row", () => {
  it("re-probes at click time and opens the change dialog when a blob appeared since mount", async () => {
    await renderWithNoBlobAtMount();
    recoveryMocks.checkRecoveryState.mockResolvedValueOnce(check(true));

    fireEvent.click(screen.getByRole("button", { name: "Set Unlock Password" }));

    await waitFor(() =>
      expect(screen.getByTestId("change-dialog")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("set-dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change Unlock Password" })
    ).toBeInTheDocument();
    expect(recoveryMocks.checkRecoveryState).toHaveBeenCalledTimes(2);
  });

  it("opens the dialog for the last-known state when the click-time probe throws", async () => {
    await renderWithNoBlobAtMount();
    recoveryMocks.checkRecoveryState.mockRejectedValueOnce(new Error("offline"));

    fireEvent.click(screen.getByRole("button", { name: "Set Unlock Password" }));

    await waitFor(() =>
      expect(screen.getByTestId("set-dialog")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("change-dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set Unlock Password" })
    ).toBeInTheDocument();
  });

  // Offline does not throw: Rust answers `recommendedFlow: "unknown"` with
  // `hasServerBlob: false`. Reading that as "no blob" would flip a correct
  // "Change" row to "Set" and offer to overwrite the existing password.
  it("keeps the last-known state when the click-time probe answers unknown", async () => {
    recoveryMocks.checkRecoveryState.mockResolvedValueOnce(check(true));
    render(<RecoveryPhraseSettings />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Change Unlock Password" })
      ).toBeInTheDocument()
    );
    recoveryMocks.checkRecoveryState.mockResolvedValueOnce({
      hasServerBlob: false,
      hasLocalMnemonic: true,
      updatedAt: null,
      recommendedFlow: "unknown",
    });

    fireEvent.click(screen.getByRole("button", { name: "Change Unlock Password" }));

    await waitFor(() =>
      expect(screen.getByTestId("change-dialog")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("set-dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change Unlock Password" })
    ).toBeInTheDocument();
  });

  it("flips the row to Change after the set dialog reports a refused seal", async () => {
    await renderWithNoBlobAtMount();
    recoveryMocks.checkRecoveryState.mockResolvedValueOnce(check(false));
    fireEvent.click(screen.getByRole("button", { name: "Set Unlock Password" }));
    await waitFor(() =>
      expect(screen.getByTestId("set-dialog")).toBeInTheDocument()
    );

    recoveryMocks.checkRecoveryState.mockResolvedValueOnce(check(true));
    fireEvent.click(screen.getByRole("button", { name: "simulate refused seal" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Change Unlock Password" })
      ).toBeInTheDocument()
    );
  });
});
