import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The root layout, `AppShell` and the root not-found boundary are in the first
 * chunk list of EVERY window, the tray popover and each capture window
 * included. A static import of the app tree or of a UI/hook barrel from any
 * of them puts polkadot, react-query and framer-motion back into windows that
 * never run them (about 1.4 MB of script per capture window, one per display).
 * A bundle test would need a build, so the imports are pinned instead.
 */
const importsOf = (rel: string) =>
  [...readFileSync(join(process.cwd(), rel), "utf8").matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

describe("the shell every window loads", () => {
  it("loads the full app tree on demand", () => {
    expect(importsOf("app/components/AppShell.tsx").sort()).toEqual([
      "@/app/lib/theme-context",
      "next/dynamic",
      "next/navigation",
    ]);
  });

  it("keeps the not-found boundary free of barrels", () => {
    expect(importsOf("app/not-found.tsx").sort()).toEqual(["next/dynamic", "react"]);
  });

  it("imports cn directly in the root layout, not the utils barrel", () => {
    const layout = importsOf("app/layout.tsx");
    expect(layout).not.toContain("./lib/utils");
    expect(layout).not.toContain("@/app/lib/utils");
  });
});
