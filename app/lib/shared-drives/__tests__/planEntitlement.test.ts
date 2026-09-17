import { describe, expect, it } from "vitest";

import { planSupportsSharedDrives } from "@/app/lib/shared-drives/planEntitlement";

describe("planSupportsSharedDrives", () => {
  it.each(["Plus", "Max", "Scale"])("includes %s", (plan) => {
    expect(planSupportsSharedDrives(plan)).toBe(true);
  });

  it.each(["Starter", "Free"])("excludes %s", (plan) => {
    expect(planSupportsSharedDrives(plan)).toBe(false);
  });

  // The plan name arrives from a billing rail, where casing and stray spaces
  // are not meaningful and are easy to introduce.
  it.each(["starter", "STARTER", "  Starter  "])(
    "matches %s regardless of casing or padding",
    (plan) => {
      expect(planSupportsSharedDrives(plan)).toBe(false);
    },
  );

  it.each([
    ["no plan at all", null],
    ["an absent field", undefined],
    ["an empty name", ""],
    ["whitespace only", "   "],
  ])("treats %s as the free tier", (_label, plan) => {
    expect(planSupportsSharedDrives(plan)).toBe(false);
  });

  // A denylist fails OPEN, and that is the point: hiding the feature from a
  // plan that includes it strands a paying customer with no route to it, while
  // showing it to one that does not ends at the server's upgrade prompt.
  it("shows the surface for an unrecognised plan, leaving the server to decide", () => {
    expect(planSupportsSharedDrives("Enterprise")).toBe(true);
    expect(planSupportsSharedDrives("Team 2027")).toBe(true);
  });
});
