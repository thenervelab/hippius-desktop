import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

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
  const chip = read("../index.tsx");

  // A second copy of the thresholds is how the bar and the Upgrade prompt
  // come to disagree about the same account.
  it("takes its bar tone from getUsageTone rather than its own threshold", () => {
    expect(chip).toContain("getUsageTone");
    expect(chip).not.toMatch(/>=\s*(80|95)\b/);
  });
});

describe("PlanSummaryCard", () => {
  const card = read("../PlanSummaryCard.tsx");

  // Rust decides what an account needs; the card must not re-derive it
  // from the plan or the percentage.
  it("asks the shared resolver whether there is anything to offer", () => {
    expect(card).toContain("getPlanActionView");
    expect(card).not.toMatch(/percent|source ===/);
  });

  // A healthy plan should read as a finished card, not one with a button
  // missing, so the column goes rather than emptying.
  it("drops the action column when nothing is offered", () => {
    expect(card).toMatch(/hasAction\s*&&/);
  });
});
