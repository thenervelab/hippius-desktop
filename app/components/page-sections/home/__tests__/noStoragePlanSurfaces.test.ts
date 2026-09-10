import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const card = read("../storage-overview/index.tsx");
const page = read("../index.tsx");
const banner = read("../NoStoragePlanBanner.tsx");

/**
 * The no-plan state is split across two elements on purpose: the banner
 * says what is wrong and why, the card just states its number. These pin
 * the split, because the pull is always to put the whole message back
 * into whichever one is being edited.
 */
describe("the storage card's no-plan state stays quiet", () => {
  // Grab just the no-plan branch: the usage branch legitimately draws a
  // bar, and asserting over the whole file would match it.
  const noPlanBranch = card.slice(
    card.indexOf('{view === "no-plan"'),
    card.indexOf('{view === "usage"'),
  );

  it("has a no-plan branch to check", () => {
    expect(noPlanBranch.length).toBeGreaterThan(0);
  });

  // A full bar means "you have used all of your storage". This account
  // has none to use, so the bar stated something untrue — and the page's
  // only progress bar painted solid red read as a fault rather than as a
  // state two clicks would fix.
  it("draws no progress bar", () => {
    expect(noPlanBranch).not.toContain("progressbar");
    expect(noPlanBranch).not.toContain("bg-error-50");
  });

  it("still offers the way out", () => {
    expect(noPlanBranch).toContain("BILLING_ROUTE");
    expect(noPlanBranch).toContain("Get Storage");
  });
});

describe("the Overview page's no-plan banner", () => {
  it("sits above the two cards, not inside either of them", () => {
    const bannerAt = page.indexOf("<NoStoragePlanBanner");
    const gridAt = page.indexOf("<StorageOverviewCard");
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(gridAt);
    expect(card).not.toContain("NoStoragePlanBanner");
  });

  // The capacity decision is Rust's; no surface may re-derive it from the
  // auth type or the plan.
  it("reads the capacity source rather than deciding it", () => {
    expect(banner).toContain("overview?.source");
    expect(banner).not.toMatch(/mnemonic|authType/);
  });

  // Billing states belong on the Drive page, where the user acts on the
  // drive. Mounting the Drive banner here would drag them onto Overview.
  it("draws only the no-capacity state", () => {
    expect(banner).toContain("getNoStoragePlanBanner");
    expect(banner).not.toContain("getDriveStatusBanner");
    expect(banner).not.toContain("useDriveServiceStatus");
  });

  // The frame is the Drive banner's, reused — not a second one that
  // drifts from it.
  it("reuses the shared banner frame", () => {
    expect(banner).toContain("StatusBanner");
  });
});
