import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "../index.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * Only the Storage/Plan pair is width-capped. The rest of the page is
 * full-bleed by design.
 *
 * Both of the other arrangements have shipped and both were wrong: no cap
 * at all stretched each card to ~700px on a wide window, and a page-wide
 * capped column narrowed Recent Files along with them, which is not what
 * that table wants — it spends real width on filenames. The cards are the
 * exception because their content does not grow with the window.
 */
describe("the home page's width cap", () => {
  const caps = page.match(/max-w-\[[^\]]+\]/g) ?? [];

  it("exists exactly once", () => {
    expect(caps).toHaveLength(1);
  });

  it("is on the Storage/Plan row", () => {
    const row = page.slice(
      page.lastIndexOf("<div", page.indexOf("<StorageOverviewCard")),
      page.indexOf("<StorageOverviewCard"),
    );
    expect(row).toContain(caps[0]);
  });

  // The page wrapper stays uncapped, so Recent Files keeps the full
  // width it uses for long filenames.
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
