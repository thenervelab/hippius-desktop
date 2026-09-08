import { describe, it, expect } from "vitest";
import { filterNavSections, navSections } from "../NavData";
import type { NavSection } from "../NavData";
import {
  WALLET_FEATURE_ENABLED,
  REFERRALS_FEATURE_ENABLED,
} from "@/app/lib/featureFlags";

// Minimal fixture — gates only, no icons (icon is typed ReactNode but the
// filter never touches it, so undefined-free literals keep the test focused).
const sections: NavSection[] = [
  {
    label: "ACCOUNT",
    items: [
      { label: "Billing", path: "/billing", icon: null },
      { label: "Wallet", path: "/wallet", icon: null, featureFlag: "wallet" },
      { label: "Shares", path: "/shares", icon: null, featureFlag: "shares" },
      {
        label: "Referrals",
        path: "/referrals",
        icon: null,
        featureFlag: "referrals",
      },
    ],
  },
  {
    label: "ONLY-GATED",
    items: [
      { label: "Wallet2", path: "/wallet", icon: null, featureFlag: "wallet" },
    ],
  },
];

describe("filterNavSections", () => {
  it("hides wallet entries when the wallet gate is off", () => {
    const out = filterNavSections(sections, {
      shareEnabled: true,
      walletEnabled: false,
      referralsEnabled: true,
    });
    expect(out.flatMap((s) => s.items.map((i) => i.label))).toEqual([
      "Billing",
      "Shares",
      "Referrals",
    ]);
  });

  it("hides referrals entries when the referrals gate is off", () => {
    const out = filterNavSections(sections, {
      shareEnabled: true,
      walletEnabled: true,
      referralsEnabled: false,
    });
    expect(out.flatMap((s) => s.items.map((i) => i.label))).toEqual([
      "Billing",
      "Wallet",
      "Shares",
      "Wallet2",
    ]);
  });

  it("drops a section whose items are all gated out (no orphan heading)", () => {
    const out = filterNavSections(sections, {
      shareEnabled: true,
      walletEnabled: false,
      referralsEnabled: false,
    });
    expect(out.map((s) => s.label)).toEqual(["ACCOUNT"]);
  });

  it("respects the shares server capability independently of wallet", () => {
    const out = filterNavSections(sections, {
      shareEnabled: false,
      walletEnabled: true,
      referralsEnabled: true,
    });
    expect(out.flatMap((s) => s.items.map((i) => i.label))).toEqual([
      "Billing",
      "Wallet",
      "Referrals",
      "Wallet2",
    ]);
  });

  // Pins the WIRING (not today's flag values, which are release decisions):
  // the real nav data must derive Wallet and Referrals visibility from the
  // build-time flags, so flipping a flag in featureFlags.ts is guaranteed
  // to reach the sidebar.
  it("wires Wallet and Referrals visibility to the feature flags", () => {
    const out = filterNavSections(navSections, { shareEnabled: true });
    const labels = out.flatMap((s) => s.items.map((i) => i.label));
    expect(labels.includes("Wallet")).toBe(WALLET_FEATURE_ENABLED);
    expect(labels.includes("Referrals")).toBe(REFERRALS_FEATURE_ENABLED);
  });

  // "Confidential Computing" is gone from the product vocabulary. Its group
  // held one child, Virtual Machines, which is gated off anyway — and a
  // group whose only child is gated is exactly what collapsed into a
  // top-level link to a 404. Neither name may come back to the sidebar
  // without a deliberate decision, so both are pinned absent.
  it("offers no Confidential Computing or Virtual Machines entry", () => {
    const out = filterNavSections(navSections, { shareEnabled: true });
    const every = out.flatMap((s) =>
      s.items.flatMap((i) => [i.label, ...(i.subMenuItems ?? []).map((x) => x.label)]),
    );
    expect(every).not.toContain("Confidential Computing");
    expect(every).not.toContain("Virtual Machines");

    const paths = out.flatMap((s) =>
      s.items.flatMap((i) => [i.path, ...(i.subMenuItems ?? []).map((x) => x.path)]),
    );
    expect(paths.filter((p) => p === "/vm")).toHaveLength(0);
  });

  // The plans page must be reachable from the sidebar: an ACCOUNT entry
  // directly above Billing, always visible (no feature flag). The header
  // stats card that also links there is hidden on the Drive page and below
  // the xl breakpoint, so this entry is the one path that always exists.
  it("lists Subscription Plans above Billing under ACCOUNT", () => {
    const account = navSections.find((s) => s.label === "ACCOUNT");
    const labels = (account?.items ?? []).map((i) => i.label);

    const plans = labels.indexOf("Subscription Plans");
    const billing = labels.indexOf("Billing");
    expect(plans).toBeGreaterThanOrEqual(0);
    expect(billing).toBeGreaterThanOrEqual(0);
    expect(plans).toBeLessThan(billing);

    const item = account?.items.find((i) => i.label === "Subscription Plans");
    expect(item?.path).toBe("/drive-plans");
    expect(item?.featureFlag).toBeUndefined();
  });
});
