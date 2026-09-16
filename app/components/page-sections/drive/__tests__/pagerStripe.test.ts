import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ROW_STRIPE, pagerStripeClass } from "../pagerStripe";

const here = dirname(fileURLToPath(import.meta.url));

describe("pagerStripeClass", () => {
  // The footer is row N+1. Twenty rows end on even, so the footer is odd; a
  // footer that repeated the even band would close the block on two identical
  // bands, which is what an even page size exposed.
  it("gives an even row count the odd band", () => {
    expect(pagerStripeClass(20)).toBe(ROW_STRIPE.odd);
  });

  // Fifteen rows end on odd, so the footer is even. This was right before
  // only because the card behind it happened to be that colour.
  it("gives an odd row count the even band", () => {
    expect(pagerStripeClass(15)).toBe(ROW_STRIPE.even);
  });

  it("follows the rows actually rendered, not the page size", () => {
    // A last page holding 19 of 20 ends on odd, so its footer is even even
    // though a full page of that size would have been odd.
    expect(pagerStripeClass(19)).toBe(ROW_STRIPE.even);
    expect(pagerStripeClass(20)).toBe(ROW_STRIPE.odd);
  });

  it("treats an empty page as if the next row were the first", () => {
    expect(pagerStripeClass(0)).toBe(ROW_STRIPE.odd);
  });
});

describe("the bands match the row's own striping", () => {
  // Two copies of these classes is how the footer and the rows drift apart.
  it("uses the same pair the table row declares", () => {
    const row = readFileSync(join(here, "../files-table/index.tsx"), "utf8");
    for (const cls of [
      "odd:bg-grey-light-200",
      "even:bg-grey-light-400",
      "dark:odd:bg-black-500",
      "dark:even:bg-black-primary-bg",
    ]) {
      expect(row).toContain(cls);
    }
    expect(ROW_STRIPE.odd).toBe("bg-grey-light-200 dark:bg-black-500");
    expect(ROW_STRIPE.even).toBe("bg-grey-light-400 dark:bg-black-primary-bg");
  });
});
