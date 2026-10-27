// `.scroll-gutter` (globals.css) is what keeps a list's scrollbar beside its
// rows instead of over them. Each line below is load-bearing and silent
// when it breaks: an unstyled scrollbar is an overlay on macOS again, a
// `scrollbar-width`/`scrollbar-color` makes Chromium (WebView2) drop every
// `::-webkit-scrollbar` rule, and callers pull the lane into their padding
// by its exact width.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is defined`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unclosed ${selector}`);
}

describe(".scroll-gutter", () => {
  const rules = block(".scroll-gutter");

  it("reserves the lane before the list overflows", () => {
    expect(rules).toMatch(/scrollbar-gutter:\s*stable/);
  });

  it("styles the scrollbar 8px wide, so it is never an overlay", () => {
    expect(rules).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*8px/);
  });

  it("never sets the standard properties that switch the WebKit rules off in Chromium", () => {
    expect(rules).not.toMatch(/scrollbar-width|scrollbar-color/);
  });

  it("has a thumb for the dark theme too", () => {
    expect(block(".dark .scroll-gutter")).toMatch(/::-webkit-scrollbar-thumb/);
  });
});
