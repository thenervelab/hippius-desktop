import { describe, it, expect } from "vitest";
import { shouldResetSplashForUpdateDialog } from "../splashReset";

describe("shouldResetSplashForUpdateDialog", () => {
  it("resets while the splash is mid-boot and a dialog opens over it", () => {
    expect(
      shouldResetSplashForUpdateDialog({
        updateDialogOpen: true,
        hasActivePhase: true,
        splashFullyComplete: false,
      }),
    ).toBe(true);
  });

  it("does not reset before the splash has an active phase", () => {
    expect(
      shouldResetSplashForUpdateDialog({
        updateDialogOpen: true,
        hasActivePhase: false,
        splashFullyComplete: false,
      }),
    ).toBe(false);
  });

  it("does not reset when no dialog is open", () => {
    expect(
      shouldResetSplashForUpdateDialog({
        updateDialogOpen: false,
        hasActivePhase: true,
        splashFullyComplete: false,
      }),
    ).toBe(false);
  });

  // Regression guard for the blank-screen bug: opening the update dialog from
  // the profile menu / tray AFTER boot must never rewind the finished splash,
  // because that unmounts the app and closing the dialog reveals a blank window.
  it("never resets once the splash has fully completed (post-boot manual open)", () => {
    expect(
      shouldResetSplashForUpdateDialog({
        updateDialogOpen: true,
        hasActivePhase: true,
        splashFullyComplete: true,
      }),
    ).toBe(false);
  });
});
