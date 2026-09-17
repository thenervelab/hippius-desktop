import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * The billing top row is the balance and the next charge, half each.
 *
 * It used to be sized around a third card holding the TAO deposit address:
 * bounded columns with a floor wide enough for a 48-character SS58, because
 * a fraction of the row truncated it on a small window and sprawled on a
 * large one. That card is withdrawn, so the row is sized for the two cards
 * actually in it.
 */
describe("the billing top row", () => {
  const sections = readCode("../BillingSections.tsx");

  it("holds the balance and the next charge, and nothing else", () => {
    expect(sections).toContain("<CreditsWidget />");
    expect(sections).toContain("<NextChargeCard />");
    expect(sections).not.toContain("TaoDepositWidget");
  });

  // Equal halves, so neither card absorbs the spare width on a wide window
  // and neither is squeezed on a narrow one.
  it("splits the row evenly rather than bounding either column", () => {
    expect(sections).toMatch(/@3xl:grid-cols-2/);
    // The bounded-column shape belonged to the deposit address; carrying it
    // forward would size this row around a card that is no longer in it.
    expect(sections).not.toMatch(/grid-cols-\[minmax/);
    expect(sections).not.toMatch(/grid-cols-3/);
  });

  it("stacks before it splits, so neither card is squeezed", () => {
    expect(sections).toMatch(/grid-cols-1[\s\S]{0,40}@3xl:grid-cols-2/);
  });
});
