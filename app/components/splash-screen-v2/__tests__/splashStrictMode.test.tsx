import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import React, { StrictMode, act } from "react";
import { getDefaultStore } from "jotai";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../LoadingScreen", () => ({ default: () => null }));
vi.mock("../PixelateTransition", () => ({ default: () => null }));
vi.mock("../GrainTexture", () => ({ default: () => null }));
vi.mock("@/app/components/PageLoader", () => ({ default: () => null }));

import SplashWrapper from "../index";
import { phaseAtom } from "../atoms";
import {
  updateCheckCompleteAtom,
  updateStore,
} from "@/app/components/updater/updateStore";

// Regression pin for the dev-only frozen splash: React StrictMode mounts an
// effect, RUNS ITS CLEANUP, and mounts it again. The splash's run-once guard
// (`setupStartedRef`) survived that remount, so the second mount saw "already
// started", started nothing, and the splash sat at "Checking for Updates 0%"
// forever — no phase machine running, no timeout to save it. The cleanup must
// reset the guard so the second mount actually boots the sequence.
describe("SplashWrapper under StrictMode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getDefaultStore().set(phaseAtom, null);
    // Update check already settled and no dialog — the update-check beat has
    // nothing to wait for, so a running phase machine must advance past it.
    updateStore.set(updateCheckCompleteAtom, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances past the update-check beat despite the double-mounted effect", async () => {
    render(
      <StrictMode>
        <SplashWrapper>
          <div />
        </SplashWrapper>
      </StrictMode>,
    );

    // Generous budget: intro dissolve + update-check ramp + several phase
    // beats. Under the regression the phase stays "checking_updates" no
    // matter how much time passes, because no run of the sequence survives.
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      const phase = getDefaultStore().get(phaseAtom);
      if (phase !== null && phase !== "checking_updates") return;
    }

    expect(getDefaultStore().get(phaseAtom)).not.toBe("checking_updates");
  });
});
