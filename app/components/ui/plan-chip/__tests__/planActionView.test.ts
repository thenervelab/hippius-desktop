import { describe, it, expect } from "vitest";
import {
  getPlanActionNote,
  getPlanActionView,
  getRenewalNotice,
} from "../planActionView";
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
    expect(getPlanActionView("top-up-credits")?.label).toBe("Top up");
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
  // A bare "Top up" button does not say why it is there; the
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

/**
 * The label is the widest thing in the header's plan cell, and the cell's
 * size was the complaint. "+ Top up Credits" also led with a plus, which
 * reads as "create new" — the same thing it got wrong on the upload
 * buttons — while "Credits" was already said by the amber note beside it.
 */
describe("the top-up label stays short", () => {
  const label = getPlanActionView("top-up-credits")?.label ?? "";

  it("does not lead with a plus", () => {
    expect(label.startsWith("+")).toBe(false);
  });

  it("matches the wording the credits banner already uses", () => {
    expect(label).toBe("Top up");
  });

  // The note carries the "why"; the button carries the "what".
  it("leaves the explanation to the note", () => {
    expect(label).not.toMatch(/credit/i);
    expect(getPlanActionNote("top-up-credits", 6)).toMatch(/credits/i);
  });
});


/**
 * The header's one-liner states a fact and a date — "Low credits. Your
 * plan renews in 22 days" — without saying what it costs, what the
 * balance is, or what happens if nothing is done. The billing card has
 * room to say all three.
 */
describe("getRenewalNotice", () => {
  const overview = (over = {}) => ({
    planAction: "top-up-credits" as const,
    creditsHip: "5.39",
    plan: { name: "Plus", amount: 7, renewsInDays: 22 },
    ...over,
  });

  it("says nothing unless Rust is asking for a top-up", () => {
    expect(getRenewalNotice(overview({ planAction: "none" }))).toBeNull();
    expect(getRenewalNotice(overview({ planAction: "upgrade" }))).toBeNull();
    expect(getRenewalNotice(undefined)).toBeNull();
  });

  it("names the plan, its price and the balance", () => {
    const notice = getRenewalNotice(overview());
    expect(notice?.description).toContain("Plus");
    expect(notice?.description).toContain("$7 a month");
    expect(notice?.description).toContain("5.39 credits");
  });

  // A price is always dollars; credits are named only where they are the
  // subject, which here is the balance.
  it("prices the plan in dollars, not credits", () => {
    expect(getRenewalNotice(overview())?.description).not.toMatch(/\$?7 credits/);
  });

  it("says by when, and what happens otherwise", () => {
    const notice = getRenewalNotice(overview());
    expect(notice?.description).toContain("in 22 days");
    expect(notice?.description).toMatch(/will not renew/);
  });

  // A warning that invents a price is worse than a shorter one.
  it("drops a clause rather than guessing at a missing input", () => {
    const noPrice = getRenewalNotice(overview({ plan: { name: "Plus", renewsInDays: 3 } }));
    expect(noPrice?.description).not.toMatch(/\$/);
    expect(noPrice?.description).not.toMatch(/undefined|null|NaN/);

    const noBalance = getRenewalNotice(overview({ creditsHip: null }));
    expect(noBalance?.description).not.toMatch(/undefined|null|NaN/);

    const noDate = getRenewalNotice(overview({ plan: { name: "Plus", amount: 7 } }));
    expect(noDate?.description).toContain("Top up to keep it running");
    expect(noDate?.description).not.toMatch(/undefined|NaN/);
  });

  it("still reads as a sentence with no plan name", () => {
    const notice = getRenewalNotice(overview({ plan: { amount: 7, renewsInDays: 5 } }));
    expect(notice?.description).toMatch(/^Your plan costs \$7 a month/);
  });
});
