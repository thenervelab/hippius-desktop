import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

/**
 * Source with comments stripped.
 *
 * These pins are about what the component RENDERS. A doc comment that
 * quotes the old copy to explain why it changed would otherwise fail the
 * very assertion documenting it.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the Drive header shows the plan card, not a standing plans button", () => {
  const drivePage = read("../../../../(pages)/files/page.tsx");

  // The button sold a plan to accounts that already had one, and said
  // nothing about which plan they were on or how full it was.
  it("no longer hardcodes a Subscription Plans button", () => {
    expect(drivePage).not.toMatch(/Subscription Plans/);
  });

  // It has to go in `actions`, not the header's own stats card: that card
  // is xl-only and this page hides it, so the plan surface would vanish on
  // a smaller window — and inside every folder, where the header stays put.
  it("renders the shared card through the always-visible actions slot", () => {
    expect(drivePage).toContain("PlanSummaryCard");
    expect(drivePage).toMatch(/actions=\{[\s\S]*?PlanSummaryCard/);
  });
});

describe("the header card and the storage card share one usage scale", () => {
  const chip = readCode("../index.tsx");

  // A second copy of the thresholds is how the bar and the Upgrade prompt
  // come to disagree about the same account.
  it("takes its bar tone from getUsageTone rather than its own threshold", () => {
    expect(chip).toContain("getUsageTone");
    expect(chip).not.toMatch(/>=\s*(80|95)\b/);
  });

  // H-109: the byte counts are formatted in Rust so every surface quotes
  // the same rounding. Re-formatting them here is how "2.82 GB" on one
  // card becomes "2.8 GB" on another.
  it("renders Rust's byte labels rather than formatting counts itself", () => {
    expect(chip).not.toMatch(/\bformatBytes\b/);
    expect(chip).toContain("usedDisplay");
    expect(chip).toContain("totalDisplay");
    expect(chip).toContain("storageDisplay");
  });

  // A free-tier account saw only the size of its allowance, which says
  // nothing about whether the Upgrade button beside it matters.
  it("states usage on the free tier too, not just the allowance", () => {
    expect(chip).not.toMatch(/included/);
    expect(chip).toContain("formatPercentLabel");
  });

  // usedPending is Rust's flag; inferring it from a zero would report a
  // genuinely-empty drive as perpetually updating.
  it("says Updating rather than a count while the indexer catches up", () => {
    expect(chip).toContain("getUsedBytesDisplay");
    expect(chip).toMatch(/Updating/);
  });
});

describe("the header cards drop the action cell, not just its button", () => {
  // PlanActionButton renders null when Rust offers nothing, which a
  // layout cannot see — so the padded cell stayed and a healthy plan's
  // card ended in a strip of empty space.
  const headers = [
    ["ui/page-header", read("../../page-header/index.tsx")],
    ["home/PageHeader", read("../../../page-sections/home/PageHeader.tsx")],
  ] as const;

  it.each(headers)("%s gates the cell on the shared hook", (_name, src) => {
    expect(src).toContain("usePlanActionView");
  });

  // `showTopUpCredits && usePlanActionView()` would skip the hook on the
  // pages that pass false.
  it("never short-circuits the hook behind a prop", () => {
    const home = readCode("../../../page-sections/home/PageHeader.tsx");
    expect(home).not.toMatch(/showTopUpCredits\s*&&\s*usePlanActionView/);
  });
});

describe("the Overview header carries no plan card", () => {
  // The Storage and Plan cards sit immediately below it and already state
  // the plan, the usage and Manage/Upgrade, with room to do it properly.
  it("the home page turns the header card off", () => {
    const home = readCode("../../../page-sections/home/index.tsx");
    expect(home).toMatch(/<PageHeader[^>]*showPlanCard=\{false\}/);
  });

  // Drive has no cards of its own, so its header card is the only place
  // the plan appears on that page — and it must survive this change.
  it("the Drive page keeps its card", () => {
    const drive = readCode("../../../../(pages)/files/page.tsx");
    expect(drive).toContain("PlanSummaryCard");
  });
});

describe("the home plan card states the plan, not its price", () => {
  const card = readCode("../../../page-sections/home/plan-overview/index.tsx");

  // What a plan costs is settled for the account already on it; Manage is
  // one click away for the billing detail.
  it("shows no price", () => {
    expect(card).not.toMatch(/formatPlanPrice|plan\.amount|plan\.interval/);
  });

  it("still names the plan and its allowance", () => {
    expect(card).toContain("plan.name");
    expect(card).toContain("plan.storageDisplay");
  });
});

describe("PlanSummaryCard", () => {
  const card = readCode("../PlanSummaryCard.tsx");

  // Rust decides what an account needs; the card must not re-derive it
  // from the plan or the percentage.
  it("asks the shared resolver whether there is anything to offer", () => {
    expect(card).toContain("usePlanActionView");
    expect(card).not.toMatch(/percent|source ===/);
  });

  // A healthy plan should read as a finished card, not one with a button
  // missing, so the column goes rather than emptying.
  it("drops the action column when nothing is offered", () => {
    expect(card).toMatch(/hasAction\s*&&/);
  });
});
