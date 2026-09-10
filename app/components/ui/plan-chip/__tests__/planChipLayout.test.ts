import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const chip = readFileSync(join(here, "../index.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * The chip lives in a page header, where vertical space is the scarce
 * dimension and horizontal space is not.
 *
 * It used to stack four rows — heading, bar, numbers, warning — so it grew
 * tallest in exactly the state where it matters most: an account short of
 * credits, which is the only one that shows the warning. The bar and the
 * numbers describe the same fact and now share a row; the warning is a
 * short clause and rides with the plan name.
 */
describe("the plan chip stays two rows", () => {
  it("puts the bar and the numbers on one row", () => {
    // The bar row opens as a plain `flex items-center` and everything that
    // annotates the bar lives inside it.
    const rowOpen = chip.lastIndexOf('flex items-center', chip.indexOf('role="progressbar"'));
    expect(rowOpen).toBeGreaterThan(-1);

    const afterBar = chip.slice(chip.indexOf('role="progressbar"'));
    expect(afterBar).toContain("usedLabel");
    expect(afterBar).toContain("formatPercentLabel(percent)");

    // The old layout gave the numbers their own `justify-between` row under
    // the bar. That row is what made the chip a line taller.
    expect(chip).not.toContain("items-baseline justify-between");
  });

  // Four stacked rows is what the redesign replaced. Each `gap-` flex
  // COLUMN is a stack; there should be exactly one, holding two rows.
  it("keeps a single stacked column", () => {
    const columns = chip.match(/flex[^"]*flex-col/g) ?? [];
    expect(columns).toHaveLength(1);
  });

  it("puts the warning on the plan-name row", () => {
    const headingRow = chip.slice(
      chip.indexOf("getPlanHeading"),
      chip.indexOf('role="progressbar"'),
    );
    expect(headingRow).toContain("actionNote");
  });

  // A fixed height would break the wrap; a floor keeps the bar long enough
  // to read while letting the row grow sideways, which is the dimension
  // the header actually has.
  it("has a width floor and no fixed height", () => {
    expect(chip).toMatch(/min-w-\[\d+px\]/);
    expect(chip).not.toMatch(/\bh-\[\d+px\]\s*flex-col/);
  });

  // Narrow windows must degrade by wrapping rather than overflowing the
  // header cell.
  it("lets the top row wrap", () => {
    expect(chip).toContain("flex-wrap");
  });
});

/**
 * The tone scale is shared with the home storage card so the two cannot
 * describe one account differently, and the warning keeps the amber that
 * distinguishes it from the brand-coloured usage numbers.
 */
describe("the chip keeps its colour contract", () => {
  it("still tones the bar and percent from the shared scale", () => {
    expect(chip).toContain("BAR_TONE[tone]");
    expect(chip).toContain("PERCENT_TONE[tone]");
  });

  it("draws the warning in amber, in both themes", () => {
    expect(chip).toMatch(/text-warning-40 dark:text-warning-50/);
  });
});
