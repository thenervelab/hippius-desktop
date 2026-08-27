// Coverage for the channel-switch copy resolver and its wiring.
//
// The copy is the feature. A user who opts into beta after reading the dialog
// has been told the builds are not fully stabilized; soften that wording and
// the dialog becomes an advert with a confirm button, which is exactly the
// thing it exists to prevent. A resolver test is the only place that can hold
// the line, because nothing else fails when copy drifts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChannelStatus } from "@/lib/tauri/updates";
import {
  channelLabel,
  getChannelView,
} from "@/app/components/updater/releaseChannelCopy";

function status(overrides: Partial<ChannelStatus> = {}): ChannelStatus {
  return {
    current: "production",
    target: "beta",
    targetVersion: "0.5.0-beta.1",
    blockedReason: null,
    ...overrides,
  };
}

describe("getChannelView", () => {
  it("names the instability of the beta channel", () => {
    const { description } = getChannelView(status());

    // The two claims the user is entitled to before opting in.
    expect(description).toMatch(/newest features first/i);
    expect(description).toMatch(/not fully stabilized/i);
    // …and that it is reversible, so opting in does not read as one-way.
    expect(description).toMatch(/stable version at any time/i);
  });

  it("names the version it will install and says the app restarts", () => {
    const { description } = getChannelView(status({ targetVersion: "0.5.0-beta.7" }));

    expect(description).toContain("0.5.0-beta.7");
    expect(description).toMatch(/restart/i);
  });

  it("still says the app will restart when the version is unknown", () => {
    // Rust leaves the version empty rather than erroring when the manifest
    // cannot be read; the dialog must stay coherent instead of promising an
    // install of "undefined".
    const { description } = getChannelView(status({ targetVersion: null }));

    expect(description).not.toContain("undefined");
    expect(description).toMatch(/restart/i);
  });

  it("describes leaving beta without the warning", () => {
    const view = getChannelView(
      status({ current: "beta", target: "production", targetVersion: "0.4.0" }),
    );

    expect(view.menuLabel).toBe("Leave Beta");
    expect(view.confirmText).toBe("Leave Beta");
    // Moving TOWARD the more tested build needs a restart notice, not a
    // warning — repeating the instability copy here would be nonsense.
    expect(view.description).not.toMatch(/not fully stabilized/i);
    expect(view.description).toMatch(/more thoroughly tested/i);
  });

  it("labels the menu item by what it does, never by where you are", () => {
    expect(getChannelView(status()).menuLabel).toBe("Explore Beta");
    expect(
      getChannelView(status({ current: "beta", target: "production" })).menuLabel,
    ).toBe("Leave Beta");
  });

  it("refuses the switch when the backend blocked it", () => {
    const view = getChannelView(
      status({ blockedReason: "This build has already saved data…" }),
    );

    expect(view.canSwitch).toBe(false);
  });

  it("refuses the switch on a lane with no target", () => {
    const view = getChannelView(
      status({ current: "staging", target: null, targetVersion: null }),
    );

    expect(view.canSwitch).toBe(false);
    expect(view.currentLabel).toBe("Internal");
  });
});

describe("channelLabel", () => {
  it("never shows a raw wire value to the user", () => {
    expect(channelLabel("production")).toBe("Stable");
    expect(channelLabel("beta")).toBe("Beta");
    expect(channelLabel("staging")).toBe("Internal");
  });
});

// Both surfaces render nothing on their own and are mounted in exactly one
// place each, so a refactor that drops a mount fails silently — the same shape
// as the bug the Finder guard's mount pin exists for. Source-text pins (the
// repo's `tests/*_wiring.rs` idiom): rendering these would mean standing up the
// whole provider tree.
describe("wiring", () => {
  const read = (...parts: string[]) =>
    readFileSync(join(process.cwd(), ...parts), "utf8");

  it("mounts the dialog in the provider tree", () => {
    expect(read("app", "components", "providers", "index.tsx")).toContain(
      "<ReleaseChannelDialog />",
    );
  });

  it("offers the item in the address menu", () => {
    const card = read(
      "app",
      "components",
      "dashboard-title-wrapper",
      "ProfileCard.tsx",
    );

    expect(card).toContain("openChannelDialog");
    // Hidden on the internal lane, which cannot switch in either direction.
    expect(card).toContain('channel !== "staging"');
  });

  it("registers the settings section", () => {
    expect(read("app", "components", "sidebar", "SettingsSidebar.tsx")).toContain(
      'section: "updates"',
    );
    expect(read("app", "(pages)", "settings", "page.tsx")).toContain(
      '{section === "updates" && <ReleaseChannelSettings />}',
    );
  });
});
