import { describe, it, expect } from "vitest";

import { ONBOARDING_SCREENS } from "../onboardingData";

describe("ONBOARDING_SCREENS copy", () => {
  const unlockScreen = ONBOARDING_SCREENS.find((s) => s.id === 4);

  it("unlock-password screen exists", () => {
    expect(unlockScreen).toBeDefined();
    expect(unlockScreen?.badges.some((b) => b.text === "Unlock Password")).toBe(
      true
    );
  });

  // Files are keyed from the mnemonic seed; the password only wraps that
  // seed. The old body ("Your unlock password encrypts files locally")
  // told users the wrong threat model.
  it("unlock-password screen does not claim the password encrypts files", () => {
    const body = unlockScreen?.body ?? "";
    const pills = unlockScreen?.pills.join(" ") ?? "";
    expect(body.toLowerCase()).not.toContain("unlock password encrypts files");
    expect(pills.toLowerCase()).not.toContain("encrypts files locally");
    expect(body.toLowerCase()).toContain("mnemonic seed");
  });
});
