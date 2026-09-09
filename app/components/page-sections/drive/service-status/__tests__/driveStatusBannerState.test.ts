import { describe, it, expect } from "vitest";
import { getDriveStatusBanner } from "../driveStatusBannerState";
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
