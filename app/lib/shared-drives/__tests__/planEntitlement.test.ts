import { describe, it, expect } from "vitest";
import {
  SHARED_DRIVE_PLAN_CODES,
  planSupportsSharedDrives,
} from "../planEntitlement";

describe("planSupportsSharedDrives", () => {
  // The bug this replaced: a denylist of ["starter", "free"] compared against
  // the plan's DISPLAY NAME. "starter" is not a plan code at all, so it
  // matched nothing, and `solo` fell through as permitted — Solo customers
  // were offered a control the server refuses.
  it.each(["duo", "max", "scale"])("includes %s", (code) => {
    expect(planSupportsSharedDrives(code)).toBe(true);
  });

  it.each(["free", "solo"])("excludes %s", (code) => {
    expect(planSupportsSharedDrives(code)).toBe(false);
  });

  it.each(["DUO", "  max  ", "Scale"])("tolerates casing and padding in %s", (code) => {
    expect(planSupportsSharedDrives(code)).toBe(true);
  });

  it("excludes solo whatever its casing", () => {
    expect(planSupportsSharedDrives("  SOLO ")).toBe(false);
  });

  // No plan object at all is the free tier.
  it.each([null, undefined])("treats %s as the free tier", (code) => {
    expect(planSupportsSharedDrives(code)).toBe(false);
  });

  // A plan that EXISTS but whose code the rail did not report — the legacy
  // Stripe storage subscription has none. Hiding a perk from a paying
  // customer with no explanation is worse than a click the server answers
  // with an upgrade prompt.
  it("permits a plan whose code is unknown, and lets the server decide", () => {
    expect(planSupportsSharedDrives("")).toBe(true);
    expect(planSupportsSharedDrives("   ")).toBe(true);
  });

  // A tier shipped after this build. Same asymmetry: a new plan is far more
  // likely to include shared drives than not, and the server still refuses.
  it("permits a plan code this build has never heard of", () => {
    expect(planSupportsSharedDrives("team")).toBe(true);
    expect(planSupportsSharedDrives("enterprise")).toBe(true);
  });

  // A display name must never be mistaken for a code. If one is passed by
  // accident it falls through to "unknown", which is loud in testing rather
  // than silently excluding a paying customer.
  it("does not accept a marketing name as a code", () => {
    expect(planSupportsSharedDrives("Plus")).toBe(true);
    expect(planSupportsSharedDrives("Starter")).toBe(true);
  });

  it("exports the allowed codes for the surfaces that name them", () => {
    expect([...SHARED_DRIVE_PLAN_CODES]).toEqual(["duo", "max", "scale"]);
  });
});
