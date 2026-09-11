import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS_SECTION,
  filterSettingsNavItems,
  resolveSettingsSection,
} from "../settingsNavGating";

// Minimal fixture — sections only, like the real settingsNavItems shape but
// without icons (the filter never touches them).
const items = [
  { section: "sync", label: "Sync & Storage" },
  { section: "wallets", label: "Wallets" },
  { section: "security", label: "Security" },
  { section: "vpn", label: "VPN Settings" },
  { section: "customize-rpc", label: "Customize RPC" },
];

const labels = (out: typeof items) => out.map((i) => i.section);

describe("filterSettingsNavItems", () => {
  it("hides wallets when the wallet gate is off", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: true,
      walletEnabled: false,
      apiTokenEnabled: true,
    });
    expect(labels(out)).toEqual(["sync", "security", "vpn", "customize-rpc"]);
  });

  it("hides vpn when the vpn gate is off", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: false,
      walletEnabled: true,
      apiTokenEnabled: true,
    });
    expect(labels(out)).toEqual([
      "sync",
      "wallets",
      "security",
      "customize-rpc",
    ]);
  });

  it("hides both gated entries when both flags are off, preserving order", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: false,
      walletEnabled: false,
      apiTokenEnabled: true,
    });
    expect(labels(out)).toEqual(["sync", "security", "customize-rpc"]);
  });

  it("keeps every entry when both flags are on", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: true,
      walletEnabled: true,
      apiTokenEnabled: true,
    });
    expect(out).toEqual(items);
  });
});

/**
 * The API token is a full-access credential for calling the Hippius API
 * directly — something done from scripts and the console, not from the
 * desktop app. Hidden here rather than deleted, same as wallet and VPN.
 */
describe("the API token entry", () => {
  const items = [{ section: "api-key" }, { section: "billing" }];

  it("is dropped when the feature is off", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: true,
      walletEnabled: true,
      apiTokenEnabled: false,
    });
    expect(out.map((i) => i.section)).toEqual(["billing"]);
  });

  it("is kept when the feature is on", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: true,
      walletEnabled: true,
      apiTokenEnabled: true,
    });
    expect(out.map((i) => i.section)).toEqual(["api-key", "billing"]);
  });
});

/**
 * The section is chosen by query string — typed, bookmarked, restored
 * across launches — so hiding the sidebar entry does not make it
 * unreachable. Rendering it anyway showed the section's heading and
 * description above an empty body, because the heading lookup never
 * consulted the flag.
 */
describe("resolveSettingsSection", () => {
  const allOn = { vpnEnabled: true, walletEnabled: true, apiTokenEnabled: true };
  const allOff = { vpnEnabled: false, walletEnabled: false, apiTokenEnabled: false };

  it("falls back to the default when a section is gated off", () => {
    for (const section of ["api-key", "vpn", "wallets"]) {
      expect(resolveSettingsSection(section, allOff)).toBe(DEFAULT_SETTINGS_SECTION);
    }
  });

  it("honours a gated section when its feature is on", () => {
    for (const section of ["api-key", "vpn", "wallets"]) {
      expect(resolveSettingsSection(section, allOn)).toBe(section);
    }
  });

  // Ungated sections are none of this resolver's business.
  it("passes an ungated section through either way", () => {
    expect(resolveSettingsSection("billing", allOff)).toBe("billing");
    expect(resolveSettingsSection("security", allOff)).toBe("security");
  });

  it("defaults when no section is named", () => {
    expect(resolveSettingsSection(null, allOn)).toBe(DEFAULT_SETTINGS_SECTION);
    expect(resolveSettingsSection(undefined, allOn)).toBe(DEFAULT_SETTINGS_SECTION);
  });
});

