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

  // A full SS58 is 48 characters and the card carries a copy button too,
  // where the credits card holds a number and a button.
  it("gives the deposit card the larger share of the row", () => {
    expect(sections).toMatch(
      /@3xl:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1\.5fr\)\]/,
    );
  });

  // The address is fitted by measurement, so widening the card is what
  // makes it show in full — there is no character count to raise.
  it("leaves the fitting to the measured truncation", () => {
    expect(readCode("../TaoDepositWidget.tsx")).toContain(
      "useCenterTruncatedText",
    );
  });
});
