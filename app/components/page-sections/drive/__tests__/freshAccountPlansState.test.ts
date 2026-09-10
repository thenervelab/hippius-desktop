import { describe, it, expect } from "vitest";
import { shouldShowFreshAccountPlans } from "../freshAccountPlansState";

const opts = (over: Partial<Parameters<typeof shouldShowFreshAccountPlans>[0]> = {}) => ({
  hasFolders: false,
  source: "free" as const,
  isLoading: false,
  ...over,
});

describe("shouldShowFreshAccountPlans", () => {
  it("offers the plans to an account with no folder and no plan", () => {
    expect(shouldShowFreshAccountPlans(opts())).toBe(true);
  });

  // An account with folders came to look at them.
  it("stays out of the way once there is a folder", () => {
    expect(shouldShowFreshAccountPlans(opts({ hasFolders: true }))).toBe(false);
  });

  // A catalogue under a plan the account already has reads as a page that
  // has not noticed.
  it("says nothing to an account already on a plan", () => {
    expect(shouldShowFreshAccountPlans(opts({ source: "subscription" }))).toBe(false);
  });

  // An empty first render is not evidence of an empty account; appearing
  // then vanishing reads as a glitch.
  it("waits for both answers before showing anything", () => {
    expect(shouldShowFreshAccountPlans(opts({ isLoading: true }))).toBe(false);
    expect(shouldShowFreshAccountPlans(opts({ source: undefined }))).toBe(false);
  });
});

describe("an account that cannot store anything", () => {
  // Not merely eligible for the plans — it needs one before the page can
  // do anything at all.
  it("is shown the plans", () => {
    expect(
      shouldShowFreshAccountPlans({
        hasFolders: false,
        source: "none",
        isLoading: false,
      }),
    ).toBe(true);
  });
});
