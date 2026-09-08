import { describe, it, expect } from "vitest";
import { getPlanActionView } from "../planActionView";

describe("getPlanActionView", () => {
  // Credits buy no Drive storage, so an account short of space must never
  // be pointed at the credits flow — it cannot give them more room.
  it("sends an upgrade to the plans page, never to credits", () => {
    const view = getPlanActionView("upgrade");
    expect(view?.label).toBe("Upgrade");
    expect(view?.href).toBe("/drive-plans");
    expect(view?.href).not.toContain("billing");
  });

  it("sends a top-up to billing", () => {
    const view = getPlanActionView("top-up-credits");
    expect(view?.label).toBe("+ Top up Credits");
    expect(view?.href).toBe("/billing");
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
