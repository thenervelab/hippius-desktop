import { describe, it, expect } from "vitest";
import {
  getDriveStatusBanner,
  getNoStoragePlanBanner,
  NO_PLAN_RETENTION_DAYS,
} from "../driveStatusBannerState";
import { BILLING_ROUTE } from "@/app/lib/routes";

describe("getDriveStatusBanner", () => {
  // An "all good" banner is noise, and it trains people to scroll past
  // the one that matters.
  it("says nothing for a working or absent plan", () => {
    expect(getDriveStatusBanner({ state: "active" })).toBeNull();
    expect(getDriveStatusBanner({ state: "none" })).toBeNull();
    expect(getDriveStatusBanner(undefined)).toBeNull();
    expect(getDriveStatusBanner({})).toBeNull();
  });

  // A state added server-side must not be guessed at: the desktop does not
  // know how severe it is.
  it("says nothing for a state it has not been taught", () => {
    expect(getDriveStatusBanner({ state: "some_future_state" })).toBeNull();
  });

  it("explains a cancelled plan and offers the plans", () => {
    const banner = getDriveStatusBanner({ state: "canceled" });
    expect(banner?.tone).toBe("warning");
    expect(banner?.title).toMatch(/cancelled/i);
    expect(banner?.action?.href).toBe(BILLING_ROUTE);
    // Cancelling is deliberate, so this one can be put away.
    expect(banner?.dismissKey).toBeTruthy();
  });

  it("explains a failed renewal and offers a top-up", () => {
    const banner = getDriveStatusBanner({ state: "past_due" });
    expect(banner?.tone).toBe("warning");
    expect(banner?.action?.href).toBe(BILLING_ROUTE);
    // A failed renewal is not the user's choice, so it cannot be dismissed.
    expect(banner?.dismissKey).toBeUndefined();
  });

  // A plan bought on another rail cannot be fixed from here, so the copy
  // sends the user where it can be rather than to a button that would fail.
  it("names the other rail and offers no button when the plan is managed elsewhere", () => {
    for (const [managedBy, words] of [
      ["stripe", /Stripe billing portal/],
      ["app_store", /App Store/],
      ["play_store", /Google Play/],
    ] as const) {
      const banner = getDriveStatusBanner({ state: "canceled", managedBy });
      expect(banner?.description).toMatch(words);
      expect(banner?.action).toBeUndefined();
    }
  });

  it("keeps the button for a plan the console manages", () => {
    expect(
      getDriveStatusBanner({ state: "canceled", managedBy: "console" })?.action?.href,
    ).toBe(BILLING_ROUTE);
  });

  // Provisioning resolves on its own, so it informs rather than warns.
  it("names the plan while it is being provisioned", () => {
    const banner = getDriveStatusBanner({ state: "pending", planName: "Plus" });
    expect(banner?.tone).toBe("info");
    expect(banner?.description).toMatch(/Plus is live/);
    expect(banner?.action).toBeUndefined();
  });

  it("still explains provisioning with no plan name", () => {
    const banner = getDriveStatusBanner({ state: "pending" });
    expect(banner?.tone).toBe("info");
    expect(banner?.description).not.toMatch(/undefined|null/);
  });
});

describe("an account with no storage plan at all", () => {
  const banner = getDriveStatusBanner(undefined, "none");

  // An account that cannot store anything at all outranks any billing
  // state, so it is the red one.
  it("is the loudest tone", () => {
    expect(banner?.tone).toBe("danger");
  });

  // What the banner is FOR: the account cannot upload, and subscribing
  // is what fixes it.
  it("says there is no plan and that a plan is what unblocks uploading", () => {
    expect(banner?.title).toMatch(/subscription plan/i);
    expect(banner?.description).toMatch(/subscribe/i);
    expect(banner?.description).toMatch(/upload/i);
  });

  // The half with a deadline: files already uploaded go away, and the
  // user has to be told before they do.
  it("says stored files are deleted, and by when", () => {
    expect(banner?.description).toMatch(/permanently deleted/i);
    expect(banner?.description).toContain(`${NO_PLAN_RETENTION_DAYS} days`);
  });

  // The window is a server behaviour the app cannot read, so it is
  // carried in ONE constant. A second copy typed into the copy is how
  // the banner comes to promise a date the server does not keep.
  it("quotes the retention window from the constant, not a literal", () => {
    const digits = banner?.description.match(/\b\d+\b/g) ?? [];
    expect(digits).toEqual([String(NO_PLAN_RETENTION_DAYS)]);
  });

  it("offers the plans", () => {
    expect(banner?.action?.href).toBe(BILLING_ROUTE);
  });

  // Dismissing does not buy a plan, so putting it away would only hide a
  // blocker the user still has to clear.
  it("cannot be dismissed", () => {
    expect(banner?.dismissKey).toBeUndefined();
  });

  // It outranks whatever the services endpoint says, including a state
  // that would otherwise draw its own banner.
  it("wins over a billing state", () => {
    expect(getDriveStatusBanner({ state: "canceled" }, "none")?.tone).toBe("danger");
  });

  // An entitled account must never see it.
  it("is absent for an account that has capacity", () => {
    expect(getDriveStatusBanner(undefined, "free")).toBeNull();
    expect(getDriveStatusBanner(undefined, "subscription")).toBeNull();
    expect(getDriveStatusBanner(undefined, undefined)).toBeNull();
  });
});

// Two pages draw this state — the Drive page and the Overview page's
// card row. One resolver, so they cannot word it two ways.
describe("the no-plan banner is shared, not copied", () => {
  it("is the same content the Drive page's resolver returns", () => {
    expect(getNoStoragePlanBanner("none")).toEqual(
      getDriveStatusBanner(undefined, "none"),
    );
  });

  it("outranks every billing state the Drive page would otherwise draw", () => {
    for (const state of ["pending", "past_due", "canceled"]) {
      expect(getDriveStatusBanner({ state }, "none")).toEqual(
        getNoStoragePlanBanner("none"),
      );
    }
  });

  it("says nothing for an account that has capacity", () => {
    expect(getNoStoragePlanBanner("free")).toBeNull();
    expect(getNoStoragePlanBanner("subscription")).toBeNull();
    expect(getNoStoragePlanBanner(undefined)).toBeNull();
  });
});
