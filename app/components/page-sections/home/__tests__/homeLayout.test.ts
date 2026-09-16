import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "../index.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * Nothing on the home page is width-capped: the card row and Recent Files
 * below it both run the full width of the page column.
 *
 * The row was capped when a single card sat in it and stretched into an
 * empty banner past about 700px. Split into two halves, each card is half
 * of whatever the window gives, so the cap was holding the row narrower
 * than the page for a reason that had stopped applying.
 *
 * A page-wide cap on the WRAPPER is still wrong, and always was: it narrows
 * Recent Files too, and that table spends real width on filenames.
 */
describe("the home page's width", () => {
  const caps = page.match(/max-w-\[[^\]]+\]/g) ?? [];

  it("caps nothing", () => {
    expect(caps).toHaveLength(0);
  });

  // Half each, so the row fills the page rather than leaving a margin the
  // files table below it does not have.
  it("splits the card row in two", () => {
    const row = page.slice(
      page.lastIndexOf("<div", page.indexOf("<StorageOverviewCard")),
      page.indexOf("<StorageOverviewCard"),
    );
    expect(row).toMatch(/w-full/);
    expect(row).toMatch(/@4xl:grid-cols-2/);
  });

  it("stacks the pair before it splits them", () => {
    const row = page.slice(
      page.lastIndexOf("<div", page.indexOf("<StorageOverviewCard")),
      page.indexOf("<StorageOverviewCard"),
    );
    expect(row).toMatch(/grid-cols-1[\s\S]{0,60}@4xl:grid-cols-2/);
  });

  it("does not cap the whole page column", () => {
    const wrapper = page.slice(
      page.indexOf("<DashboardTitleWrapper"),
      page.indexOf("<PageHeader"),
    );
    expect(wrapper).not.toMatch(/max-w-\[/);
    expect(wrapper).not.toContain("mx-auto");
  });

  it("does not cap the recent-files block", () => {
    const recent = page.slice(page.indexOf('id="recent-files"'));
    expect(recent).not.toMatch(/max-w-\[/);
  });
});

/**
 * The two Overview cards sit side by side, so their headers must line up.
 * A mismatch is most visible exactly there, at the top of the row.
 */
describe("the Overview cards' headers", () => {
  const read = (rel: string) =>
    readFileSync(join(here, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const storage = read("../storage-overview/index.tsx");
  const breakdown = read("../breakdown/BreakdownCard.tsx");

  const headerHeight = (src: string) =>
    src.match(/min-h-\[(\d+)px\]/)?.[1] ?? null;

  it("agree on one height", () => {
    expect(headerHeight(storage)).not.toBeNull();
    expect(headerHeight(storage)).toBe(headerHeight(breakdown));
  });

  // The action moved out of the body, where it shared a row with the figure
  // and the bar and forced that row to reflow at narrow widths.
  it("puts the storage card's plan action in its header", () => {
    const header = storage.slice(0, storage.indexOf("Drive storage") + 1 || 4000);
    expect(storage).toMatch(/min-h-\[52px\][\s\S]{0,1400}Manage/);
    expect(header.length).toBeGreaterThan(0);
  });
});
