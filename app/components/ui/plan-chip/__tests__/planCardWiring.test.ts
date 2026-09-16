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
  // a smaller window and in the cards view.
  it("renders the shared card through the actions slot", () => {
    expect(drivePage).toContain("PlanSummaryCard");
    expect(drivePage).toMatch(/actions=\{[\s\S]*?PlanSummaryCard/);
  });

  // The plan is a fact about the DRIVE as a whole, so it is drawn on the one
  // view that is about the drive as a whole: the list of folders. Inside a
  // drive it repeats an account-wide figure over a view scoped to one folder,
  // beside a breadcrumb that is the thing worth reading up there.
  it("draws the card only on the folder list", () => {
    expect(drivePage).toMatch(/showPlanCard \? <PlanSummaryCard \/> : null/);
  });

  // The bug this replaced: the page asked the URL, and the URL does not know.
  // Opening a synced drive from the folder list is a state change inside
  // DriveContainer, not a navigation, so `/files` stays `/files` all the way
  // into a drive and a URL-only check reported "folder list" while a drive's
  // contents were on screen. The card survived one level in because of it.
  it("takes the view from DriveContainer rather than deciding from the URL", () => {
    expect(drivePage).toContain("driveAtFolderListAtom");
    expect(drivePage).toMatch(/showPlanCard\s*=\s*atFolderList\s*&&/);
  });

  // The URL check stays alongside it, for the one case the atom cannot answer
  // in time: a link opened straight into a subfolder paints once before
  // DriveContainer's effect runs, with the atom still at its initial true.
  it("still covers a deep link into a subfolder on first paint", () => {
    expect(drivePage).toContain("isNestedFolderView");
    expect(drivePage).not.toMatch(/Boolean\(\s*getParam\("folderName"\)/);
  });
});

describe("DriveContainer publishes which view is on screen", () => {
  const container = readCode(
    "../../../page-sections/drive/DriveContainer.tsx",
  );

  // The page cannot see `isOnLocalView` — it is useState in the container —
  // so the container has to hand the answer over.
  it("writes the folder-list flag to the atom the page reads", () => {
    expect(container).toContain("driveAtFolderListAtom");
    expect(container).toContain("setAtFolderList");
  });

  // One rule, in one place, so the flag cannot be spelled differently here
  // than it is reasoned about elsewhere.
  it("derives the flag from the shared resolver", () => {
    expect(container).toContain("isDriveFolderListView");
  });

  // Otherwise the next visit to Drive opens with the card hidden because the
  // last visit ended inside a folder.
  it("resets the flag when the page unmounts", () => {
    expect(container).toMatch(/=>\s*\(\)\s*=>\s*setAtFolderList\(true\)/);
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
  // The Storage card sits immediately below it and already states the plan,
  // the usage and Manage/Upgrade, with room to do it properly.
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

describe("the home storage card states the plan, not its price", () => {
  // The Plan card that used to sit beside this one is gone: it restated the
  // plan name and allowance from the same fetch, so the pair said one thing
  // twice. Its Manage button moved into this card, and these pins moved with
  // it, because they are about what the Overview promises, not about which
  // component happens to draw it.
  const card = readCode("../../../page-sections/home/storage-overview/index.tsx");

  // What a plan costs is settled for the account already on it; Manage is
  // one click away for the billing detail.
  it("shows no price", () => {
    expect(card).not.toMatch(/formatPlanPrice|plan\.amount|plan\.interval/);
  });

  it("names the plan and the capacity it grants", () => {
    expect(card).toContain("getCapacitySourceLabel");
    expect(card).toContain("overview.totalDisplay");
  });

  // The only part of the old card that was not a repeat.
  it("carries the action the Plan card used to own", () => {
    expect(card).toContain("Manage");
    expect(card).toContain("Upgrade");
    expect(card).toContain("BILLING_ROUTE");
  });
});

describe("the low-credit warning reads one sentence, from one place", () => {
  // The header line and the billing strip say the same thing about the
  // same account; two copies of the wording is how they drift.
  const surfaces = [
    ["the header chip", "../index.tsx"],
    ["the billing strip", "../PlanRenewalNotice.tsx"],
  ] as const;

  it("the header chip takes the one-line version", () => {
    expect(readCode("../index.tsx")).toContain("getPlanActionNote");
  });

  // The card has room to explain, so it takes the longer sentence — but
  // from the same module, so the two cannot drift apart.
  it("the billing card takes the full version", () => {
    expect(readCode("../PlanRenewalNotice.tsx")).toContain("getRenewalNotice");
  });

  // Whether the balance is short is Rust's call; neither surface may
  // decide it from the funding type or the balance itself.
  it.each(surfaces)("%s decides nothing itself", (_name, path) => {
    const src = readCode(path);
    expect(src).not.toMatch(/funding\s*===|creditsHip/);
  });

  // Billing is where the user acts on it, so the card must be on the page
  // the Billing route actually renders. It used to be pinned into
  // `SubscriptionPlansSection`, which that page stopped rendering when the
  // credit-reload products were withdrawn — so this assertion passed while
  // the warning appeared nowhere.
  it("the billing page itself shows the card", () => {
    const billing = readCode("../../../page-sections/billing/BillingSections.tsx");
    expect(billing).toContain("PlanRenewalNotice");
  });

  // Red, like the cancelled-plan banner: the plan stops unless the user
  // acts. Amber read as an aside.
  it("the card carries the same weight as a cancelled plan", () => {
    const notice = readCode("../PlanRenewalNotice.tsx");
    expect(notice).toContain('tone: "danger"');
    expect(notice).toContain("StatusBanner");
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
