import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const button = readFileSync(join(here, "../PlanActionButton.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * The plan action is the page's answer to a problem the page has just
 * stated — no plan, or a balance too small for the next renewal. Drawn as
 * a white or grey pill it carried the same weight as the navigation
 * buttons a row below it, and read as navigation.
 */
describe("the plan call to action", () => {
  it("is a filled primary button", () => {
    expect(button).toMatch(/variant="primary"/);
  });

  it("is primary in both of its shapes, not just the roomy one", () => {
    // A ternary on `variant` around the Button's own `variant` prop is
    // how one of the two slots keeps a secondary look.
    expect(button).not.toMatch(/variant=\{[^}]*\?/);
  });

  // The pill's hand-rolled white/grey chrome fought the filled variant;
  // `variant` now chooses only the SHAPE.
  it("carries no competing background or border of its own", () => {
    expect(button).not.toMatch(/\bbg-white\b/);
    expect(button).not.toMatch(/\bborder-grey-dark-100\b/);
  });
});
