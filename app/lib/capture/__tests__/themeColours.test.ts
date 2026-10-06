import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The theme's `black` is a scale (`black-300`, `black-600`, ...) with no
 * DEFAULT, so `bg-black/70`, `text-black` and friends compile to NOTHING:
 * no error, just a missing background. On the dark glass that left white
 * text straight over the user's desktop (the hint, the camera strip, the
 * window badge). Plain black is written `bg-[#000]/70`.
 */
const ROOTS = [
  "app/capture-overlay",
  "app/capture-controls",
  "app/capture-camera",
  "app/capture-preview",
  "app/components/capture",
  "app/lib/capture",
  "app/tray-panel/TrayCaptureRow.tsx",
];
const MISSING = /(?:^|[\s"'`:])(?:bg|text|border|ring|from|to|via|fill|stroke|shadow|outline|divide|placeholder)-black(?:\/[\d.]+)?(?=[\s"'`]|$)/m;

function sources(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .filter((name) => name !== "__tests__")
    .flatMap((name) => sources(join(path, name)))
    .filter((p) => /\.(tsx?|css)$/.test(p));
}

describe("capture surfaces", () => {
  it("use no colour the theme does not define", () => {
    const offenders = ROOTS.flatMap((root) => sources(join(process.cwd(), root))).filter((file) => {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      return MISSING.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
