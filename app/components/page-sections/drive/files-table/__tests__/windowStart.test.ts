import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const table = readFileSync(join(here, "../index.tsx"), "utf8");

/**
 * The table sorts the whole level and renders a window of the sorted order.
 * Both ends of that window matter: the length says how many rows, the start
 * says which ones.
 */
describe("the rendered window", () => {
  it("is taken from both ends, not just the length", () => {
    expect(table).toMatch(
      /rows\.slice\(windowStart, windowStart \+ files\.length\)/,
    );
    // `slice(0, …)` is the bug this replaces: it renders the first page of
    // the sorted order no matter which page the reader is on.
    expect(table).not.toMatch(/getRowModel\(\)[\s\S]{0,40}rows\.slice\(0,/);
  });

  it("defaults to the start, so an unpaged caller is unaffected", () => {
    expect(table).toMatch(/windowStart = 0/);
  });

  // Moving the window must repaint; without it in the deps the rows stay on
  // whichever page was rendered first.
  it("recomputes when the window moves", () => {
    expect(table).toMatch(/\[table, enrichedAllFiles, sorting, files\.length, windowStart\]/);
  });
});
