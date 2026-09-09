import { describe, it, expect } from "vitest";
import { getPlanActionView } from "../planActionView";
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
