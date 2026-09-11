import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { formatPlanPrice } from "@/lib/types/drive-plans";
import type { DrivePlan } from "@/lib/types/drive-plans";

const here = dirname(fileURLToPath(import.meta.url));
const sectionDir = join(here, "..");

const plan = (over: Partial<DrivePlan> = {}): DrivePlan =>
  ({
    code: "duo",
    name: "Plus",
    storage_bytes: 2 * 1024 ** 4,
    price_credits_monthly: 7,
    price_credits_annual: 6,
    is_free: false,
    ...over,
  }) as DrivePlan;

/**
 * A plan was quoted two ways from one number — "$7 /Mo" on the card and "7
 * credits for the first month" in the dialog confirming it — because the
 * underlying field is named `price_credits_*`. A reader should not have to
 * learn an exchange rate to compare two screens.
 */
describe("formatPlanPrice", () => {
  it("quotes a plan in dollars", () => {
    expect(formatPlanPrice(plan())).toBe("$7");
  });

  it("never says credits", () => {
    expect(formatPlanPrice(plan())).not.toMatch(/credit/i);
  });

  // The annual price is quoted per month, so a year is twelve of them.
  it("charges a year up front on the annual period", () => {
    expect(formatPlanPrice(plan(), "annual")).toBe("$72");
  });

  it("says Free rather than $0", () => {
    expect(formatPlanPrice(plan({ is_free: true }))).toBe("Free");
  });
});

/**
 * The guard that stops the two spellings coming back: no plans surface may
 * render a price in credits, and none may hand-build one either.
 *
 * Credits are deliberately still named in this directory — the payment
 * rail, the balance and the shortfall are genuinely about credits, and the
 * rail's own line says "1 credit = $1". What must not come back is a PRICE
 * measured in them.
 */
describe("the plans surfaces quote prices in one unit", () => {
  const sources = readdirSync(sectionDir)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => [f, readFileSync(join(sectionDir, f), "utf8")] as const);

  it.each(sources)("%s renders no price in credits", (_name, src) => {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // An interpolated amount immediately followed by the word, on the
    // same line — prose, not a prop. `\s` spanned newlines and flagged
    // `credits={credits}` on the line after a closing brace.
    expect(code).not.toMatch(/\}[ \t]*credits?\b/);
  });

  it("builds no price string outside the shared formatter", () => {
    for (const [name, src] of sources) {
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(
        code.includes("$${") || /\$\{chargeAmount\(/.test(code),
        `${name} hand-builds a price; use formatPlanPrice so every surface agrees`,
      ).toBe(false);
    }
  });
});
