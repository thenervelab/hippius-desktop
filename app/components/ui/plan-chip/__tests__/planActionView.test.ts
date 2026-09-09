import { describe, it, expect } from "vitest";
import { getPlanActionNote, getPlanActionView } from "../planActionView";
import { BILLING_ROUTE } from "@/app/lib/routes";

describe("getPlanActionView", () => {
  // Credits buy no Drive storage, so an account short of space must never
  // be pointed at the credits flow — it cannot give them more room.
  // Both prompts now land on ONE page. They used to split across a
  // Subscription Plans page and a Billing page, which meant two screens
  // for one subject depending on which prompt you happened to get.
  it("sends both prompts to the same Billing page", () => {
    expect(getPlanActionView("upgrade")?.label).toBe("Upgrade");
    expect(getPlanActionView("upgrade")?.href).toBe(BILLING_ROUTE);
    expect(getPlanActionView("top-up-credits")?.label).toBe("+ Top up Credits");
    expect(getPlanActionView("top-up-credits")?.href).toBe(BILLING_ROUTE);
  });

  // The page it points at must be the one that actually exists now.
  it("never points at the removed plans route", () => {
    for (const action of ["upgrade", "top-up-credits"] as const) {
      expect(getPlanActionView(action)?.href).not.toContain("/drive-plans");
    }
  });

  // A healthy plan should not be sold anything.
  it("offers nothing when nothing is needed", () => {
    expect(getPlanActionView("none")).toBeNull();
  });

  // Guessing while the decision loads is how the wrong prompt flashes.
  it("offers nothing before the decision arrives", () => {
    expect(getPlanActionView(undefined)).toBeNull();
  });
});

describe("getPlanActionNote", () => {
  // A bare "+ Top up Credits" button does not say why it is there; the
  // consequence — the plan not renewing — is the part worth reading.
  it("explains a top-up prompt, and counts down when Rust supplies a date", () => {
    expect(getPlanActionNote("top-up-credits", 6)).toBe(
      "Low credits. Your plan renews in 6 days",
    );
    expect(getPlanActionNote("top-up-credits", 1)).toBe(
      "Low credits. Your plan renews tomorrow",
    );
    expect(getPlanActionNote("top-up-credits", 0)).toBe(
      "Low credits. Your plan renews today",
    );
  });

  // No date from the rail, or one already past: say the thing that is true
  // either way rather than inventing a countdown.
  it("still says the balance is short with no usable date", () => {
    const fallback = "Low credits. Not enough to renew your plan";
    expect(getPlanActionNote("top-up-credits", null)).toBe(fallback);
    expect(getPlanActionNote("top-up-credits", undefined)).toBe(fallback);
    expect(getPlanActionNote("top-up-credits", -3)).toBe(fallback);
  });

  // Upgrade needs no note: the usage bar beside it is already the reason,
  // and a healthy plan must not be nagged at all.
  it("says nothing for the other actions", () => {
    expect(getPlanActionNote("upgrade", 2)).toBeNull();
    expect(getPlanActionNote("none", 2)).toBeNull();
    expect(getPlanActionNote(undefined, 2)).toBeNull();
  });
});
