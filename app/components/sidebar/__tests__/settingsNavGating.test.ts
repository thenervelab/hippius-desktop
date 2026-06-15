import { describe, it, expect } from "vitest";
import { filterSettingsNavItems } from "../settingsNavGating";

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
    });
    expect(labels(out)).toEqual(["sync", "security", "vpn", "customize-rpc"]);
  });

  it("hides vpn when the vpn gate is off", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: false,
      walletEnabled: true,
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
    });
    expect(labels(out)).toEqual(["sync", "security", "customize-rpc"]);
  });

  it("keeps every entry when both flags are on", () => {
    const out = filterSettingsNavItems(items, {
      vpnEnabled: true,
      walletEnabled: true,
    });
    expect(out).toEqual(items);
  });
});
