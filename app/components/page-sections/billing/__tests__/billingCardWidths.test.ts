import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the billing top row is sized for the two cards in it", () => {
  const sections = readCode("../BillingSections.tsx");

  // Two cards in a three-column grid each took a THIRD of the row, so the
  // deposit address was center-truncated on a window with room to spare
  // while the remaining third went to whitespace.
  it("no longer reserves a column for a widget that is gone", () => {
    expect(sections).not.toMatch(/grid-cols-3/);
  });

  // Its content is a fixed 48-character address plus a copy button, so
  // it has a width at which it is complete and past which it only adds
  // empty field. A fraction could not express that: it truncated on a
  // small window and sprawled on a large one.
  it("bounds both columns instead of giving either a fraction of the row", () => {
    expect(sections).toMatch(
      /@3xl:grid-cols-\[minmax\(0,26rem\)_minmax\(28rem,34rem\)\]/,
    );
    // No `fr` anywhere in the row: a fraction is what made one card
    // absorb every spare pixel on a wide window.
    expect(sections).not.toMatch(/@3xl:grid-cols-\[[^\]]*fr[^\]]*\]/);
  });

  // The floor has to clear a full SS58 plus the copy button, or the
  // measured truncation kicks in again and the bound achieves nothing.
  // Matched on the DEPOSIT column specifically — the credits column has
  // no truncation risk and deliberately floors at 0 so it can shrink.
  it("sets a floor on the deposit column that fits the address", () => {
    const [, floor] = sections.match(/_minmax\((\d+)rem,\s*\d+rem\)/) ?? [];
    expect(Number(floor)).toBeGreaterThanOrEqual(26);
  });

  // The address is fitted by measurement, so widening the card is what
  // makes it show in full — there is no character count to raise.
  it("leaves the fitting to the measured truncation", () => {
    expect(readCode("../TaoDepositWidget.tsx")).toContain(
      "useCenterTruncatedText",
    );
  });
});
