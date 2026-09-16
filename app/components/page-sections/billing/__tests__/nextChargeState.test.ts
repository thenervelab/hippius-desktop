import { describe, expect, it } from "vitest";
import { getNextChargeView, fundingLabelFor } from "../nextChargeState";
import type { PlanInfo } from "@/app/lib/hooks/api/useStorageOverview";

const plan = (over: Partial<PlanInfo> = {}): PlanInfo => ({
  name: "Plus",
  amount: 7,
  interval: "month",
  storageBytes: 0,
  storageDisplay: "2 TB",
  funding: "credits",
  renewsInDays: 22,
  ...over,
});

describe("getNextChargeView", () => {
  it("states the amount, the plan, the date and the rail", () => {
    const view = getNextChargeView({
      showSkeleton: false,
      source: "subscription",
      plan: plan(),
    });
    expect(view).toEqual({
      kind: "charge",
      planName: "Plus",
      amount: "$7",
      cadence: "per month",
      whenText: "in 22 days",
      fundingLabel: "Account balance",
    });
  });

  // The same words the low-balance warning uses, from the same helper, so
  // one surface cannot say "tomorrow" while the other says "in 1 day".
  it("counts down in the warning's words", () => {
    const at = (days: number) =>
      getNextChargeView({ showSkeleton: false, source: "subscription", plan: plan({ renewsInDays: days }) });
    expect(at(0)).toMatchObject({ whenText: "today" });
    expect(at(1)).toMatchObject({ whenText: "tomorrow" });
    expect(at(6)).toMatchObject({ whenText: "in 6 days" });
  });

  // A card plan renews itself and reports no countdown. Inventing a date
  // would be the card stating something the rail never said.
  it("says nothing about a date the rail did not give", () => {
    const view = getNextChargeView({
      showSkeleton: false,
      source: "subscription",
      plan: plan({ funding: "card", renewsInDays: null }),
    });
    expect(view).toMatchObject({ whenText: null, fundingLabel: "Card" });
  });

  it("treats the free tier and no plan as nothing recurring", () => {
    for (const source of ["free", "none"] as const) {
      expect(
        getNextChargeView({ showSkeleton: false, source, plan: null }),
      ).toEqual({ kind: "none" });
    }
  });

  // An error resolves to "none" rather than a charge: the storage card
  // beside it already reports the failure, and a card that invents a
  // charge is worse than one that stays quiet.
  it("does not invent a charge when the read failed", () => {
    expect(
      getNextChargeView({ showSkeleton: false, source: undefined, plan: null }),
    ).toEqual({ kind: "none" });
  });

  // Never flash "None" at an account whose plan is merely still loading.
  it("holds the skeleton until the decision settles", () => {
    expect(
      getNextChargeView({ showSkeleton: true, source: "subscription", plan: plan() }),
    ).toEqual({ kind: "skeleton" });
  });

  it("names the rail the way the rest of the app names it", () => {
    expect(fundingLabelFor("credits")).toBe("Account balance");
    expect(fundingLabelFor("card")).toBe("Card");
    // The legacy Stripe subscription reports no rail; saying "Card" would
    // be a guess, even though it is card-backed.
    expect(fundingLabelFor(null)).toBe("Not stated");
  });
});
