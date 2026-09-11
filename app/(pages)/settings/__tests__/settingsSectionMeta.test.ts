import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "../page.tsx"), "utf8");
const meta = page.slice(
  page.indexOf("const SECTION_META"),
  page.indexOf("function SettingsContent"),
);

/**
 * The tooltip falls back to the description when a section has none, so a
 * section with something to explain but no tooltip shows the same sentence
 * twice — once under the title and once behind the icon. Billing did.
 */
describe("the Billing tooltip is a guide, not the subtitle again", () => {
  const billing = meta.slice(meta.indexOf("billing: {"), meta.indexOf("sync: {"));

  it("has a tooltip of its own", () => {
    expect(billing).toContain("tooltip:");
  });

  it("does not repeat the subtitle", () => {
    const description =
      "Your plan, your credits, and everything you have been charged for.";
    expect(billing).toContain(description);
    // Once, as the description — not again inside the tooltip.
    expect(billing.split(description)).toHaveLength(2);
  });

  // The page shows a price and says nothing about how to pay it, so both
  // routes are named — and that a credit is a dollar.
  // Plain punctuation: the tooltip is a short guide, and em dashes read
  // as an aside inside instructions.
  it("uses no em dashes", () => {
    expect(billing).not.toContain("\u2014");
  });

  it("explains both ways to pay", () => {
    expect(billing).toMatch(/By card/);
    expect(billing).toMatch(/From credits/);
    expect(billing).toMatch(/1 credit = \$1/);
  });
});

/**
 * Documentation opens in the user's browser through Tauri, never in the
 * app webview — `InfoTooltip` handles that, so a section only supplies
 * the URL.
 */
describe("the Billing tooltip links to the docs", () => {
  it("points at the desktop billing page", () => {
    expect(meta).toContain("https://docs.hippius.com/use/desktop/billing");
  });

  it("hands the link to the tooltip, which opens it externally", () => {
    expect(page).toMatch(/learnMoreUrl=\{meta\.learnMoreUrl\}/);
    const tooltip = readFileSync(
      join(here, "../../../components/ui/info-tooltip.tsx"),
      "utf8",
    );
    expect(tooltip).toContain("openUrl(learnMoreUrl)");
  });

  // The slug is owned by the docs site; if that repo is checked out beside
  // this one, keep the two in step.
  it("matches the slug the docs declare, when they are available", () => {
    const doc = join(here, "../../../../../hippius-doc/docs/use/desktop/billing.md");
    if (!existsSync(doc)) return;
    expect(readFileSync(doc, "utf8")).toContain("slug: /use/desktop/billing");
  });
});
