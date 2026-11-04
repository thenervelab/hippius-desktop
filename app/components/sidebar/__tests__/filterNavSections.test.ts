import { describe, it, expect } from "vitest";
import { filterNavSections, navSections } from "../NavData";
import type { NavSection } from "../NavData";
import { settingsNavItems } from "../SettingsSidebar";
import {
  WALLET_FEATURE_ENABLED,
  REFERRALS_FEATURE_ENABLED,
  SCREEN_CAPTURE_ENABLED,
} from "@/app/lib/featureFlags";
import { BILLING_ROUTE } from "@/app/lib/routes";

// Minimal fixture — gates only, no icons (icon is typed ReactNode but the
// filter never touches it, so undefined-free literals keep the test focused).
const sections: NavSection[] = [
  {
    key: "account",
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
    key: "only-gated",
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

  // The chat gate is a RUNTIME answer from Rust (`chat_get_config`), not a
  // build-time flag: hidden until known (`undefined`), hidden when `false`,
  // shown only on an explicit `true`. A sidebar that showed Chat before the
  // config landed would flash an entry the lane may not have.
  it("shows the Chat entry only once Rust reports chat enabled", () => {
    const labels = (gates: Parameters<typeof filterNavSections>[1]) =>
      filterNavSections(navSections, gates).flatMap((s) => s.items.map((i) => i.label));
    expect(labels({ shareEnabled: true })).not.toContain("Chat");
    expect(labels({ shareEnabled: true, chatEnabled: false })).not.toContain("Chat");
    expect(labels({ shareEnabled: true, chatEnabled: true })).toContain("Chat");
  });

  it("routes the Chat entry to /chat, in Account after Wallet", () => {
    const account = filterNavSections(navSections, {
      shareEnabled: true,
      chatEnabled: true,
      walletEnabled: true,
    }).find((s) => s.key === "account");
    const rows = account?.items.map((i) => `${i.label} ${i.path}`) ?? [];
    expect(rows).toContain("Chat /chat");
    expect(rows.indexOf("Chat /chat")).toBe(rows.indexOf("Wallet /wallet") + 1);
  });

  // Captures is a view of Drive: it sits in Drive (after Shared Drives, as
  // the console orders them) and follows the capture feature flag like every
  // other capture surface.
  it("puts Captures under My Drive and Shared Drives, behind the capture flag", () => {
    const drive = (captureEnabled: boolean) =>
      filterNavSections(navSections, { shareEnabled: true, chatEnabled: true, captureEnabled })
        .find((s) => s.key === "drive")
        ?.items.map((i) => `${i.label} ${i.path}`);
    expect(drive(true)).toEqual([
      "My Drive /files",
      "Shared Drives /shared-drives",
      "Captures /captures",
    ]);
    expect(drive(false)).not.toContain("Captures /captures");
  });

  // Shared drives have a page of their own, right under My Drive, and follow
  // the shared drives flag.
  it("puts Shared Drives right under My Drive, behind the shared drives flag", () => {
    const drive = (sharedDrivesEnabled: boolean) =>
      filterNavSections(navSections, { shareEnabled: true, sharedDrivesEnabled })
        .find((s) => s.key === "drive")
        ?.items.map((i) => `${i.label} ${i.path}`);
    expect(drive(true)?.slice(0, 2)).toEqual(["My Drive /files", "Shared Drives /shared-drives"]);
    expect(drive(false)).not.toContain("Shared Drives /shared-drives");
  });

  // The flag is on in production for every platform, but Rust turns capture
  // on for macOS only: a caller that does not say capture is available here
  // must not get the entry.
  it("hides the Captures entry unless the caller says capture is available", () => {
    const labels = filterNavSections(navSections, { shareEnabled: true }).flatMap((s) =>
      s.items.map((i) => i.label),
    );
    expect(SCREEN_CAPTURE_ENABLED).toBe(true);
    expect(labels).not.toContain("Captures");
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

  // The sidebar's layout, one logic with the console's: the product first,
  // then the account, then help, with no ESSENTIALS or INFRASTRUCTURE titles.
  it("runs product, account, help, with the console's names", () => {
    const out = filterNavSections(navSections, {
      shareEnabled: true,
      chatEnabled: true,
      walletEnabled: true,
      referralsEnabled: true,
      captureEnabled: true,
      sharedDrivesEnabled: true,
    });
    expect(out.map((s) => [s.label ?? `(${s.key})`, ...s.items.map((i) => i.label)])).toEqual([
      ["(overview)", "Overview"],
      ["DRIVE", "My Drive", "Shared Drives", "Captures"],
      ["ACCOUNT", "Plans & Billing", "Wallet", "Chat", "Referrals"],
      ["SUPPORT", "Documentation", "Help & Support"],
    ]);
  });

  // One entry for plans and billing, named as in the console, opening its
  // own page under this sidebar, which holds the plan catalogue, the
  // subscription and the credits. "Billing" and "Subscription Plans" were
  // once two entries for that one subject; neither may come back beside it.
  it("opens the Plans & Billing page from Plans & Billing, first in Account", () => {
    const account = filterNavSections(navSections, { shareEnabled: true }).find(
      (s) => s.key === "account",
    );
    expect(account?.items[0]).toMatchObject({ label: "Plans & Billing", path: BILLING_ROUTE });
    expect(account?.items[0].path).toBe("/billing");
    const labels = filterNavSections(navSections, { shareEnabled: true })
      .flatMap((s) => s.items.map((i) => i.label));
    expect(labels).not.toContain("Billing");
    expect(labels).not.toContain("Subscription Plans");
  });

  // Offered once: Plans & Billing in the main sidebar, so not in Settings.
  it("takes Billing out of the settings nav", () => {
    expect(settingsNavItems.map((i) => i.section)).not.toContain("billing");
    expect(settingsNavItems.map((i) => i.label)).not.toContain("Billing");
  });

  // One plain list, still ordered by topic: this computer's files, how the
  // app tells and looks, keys and access, then the app itself.
  it("orders the settings nav by topic, as one list", () => {
    expect(settingsNavItems.map((i) => i.label)).toEqual([
      "Sync & Storage",
      "Screenshots & Recording",
      "Notifications",
      "Appearance",
      "Security",
      "Wallets",
      "API Token",
      "Updates",
      "VPN Settings",
      "Customize RPC",
    ]);
  });

  // Every capture setting has its own tab, right after Sync & Storage,
  // where they used to sit at the bottom.
  it("puts Screenshots & Recording right after Sync & Storage", () => {
    const labels = settingsNavItems.map((i) => i.label);
    expect(labels.indexOf("Screenshots & Recording")).toBe(labels.indexOf("Sync & Storage") + 1);
    expect(settingsNavItems.find((i) => i.label === "Screenshots & Recording")?.section).toBe("capture");
  });
});
