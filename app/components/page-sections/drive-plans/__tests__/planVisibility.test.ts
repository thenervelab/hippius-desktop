import { describe, it, expect } from "vitest";

import { isFreeTierEntitled, offeredPlans } from "../planVisibility";

const plans = [
  { code: "free", is_free: true },
  { code: "starter", is_free: false },
  { code: "duo", is_free: false },
];

/**
 * An access-key account has no included allowance, so the Free Drive Plan
 * card is not a plan it is on, nor one it can fall back to — it is an
 * offer of storage that does not exist for it.
 */
describe("offeredPlans", () => {
  it("drops the free plan for an account that is not entitled", () => {
    expect(offeredPlans(plans, false)?.map((p) => p.code)).toEqual([
      "starter",
      "duo",
    ]);
  });

  it("keeps every plan for an entitled account", () => {
    expect(offeredPlans(plans, true)).toEqual(plans);
  });

  // The overview has not settled on first paint. Hiding the free card
  // pessimistically would blink it out of the grid on every load for the
  // accounts that do have it; anything that spends storage is gated
  // server-side regardless.
  it("keeps every plan while the answer is unknown", () => {
    expect(offeredPlans(plans, undefined)).toEqual(plans);
  });

  it("passes an absent list through", () => {
    expect(offeredPlans(undefined, false)).toBeUndefined();
    expect(offeredPlans(undefined, true)).toBeUndefined();
  });
});

describe("isFreeTierEntitled", () => {
  it("is false only for an explicit false", () => {
    expect(isFreeTierEntitled(false)).toBe(false);
    expect(isFreeTierEntitled(true)).toBe(true);
    expect(isFreeTierEntitled(undefined)).toBe(true);
  });
});
