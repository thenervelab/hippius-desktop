import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("renaming a folder addresses the folder on screen", () => {
  const hook = readCode("../index.tsx");

  // Sending `actualFileName` for a folder sent a bare basename, so Rust
  // looked for it at the drive root and refused the rename.
  it("resolves the path instead of sending the displayed name", () => {
    expect(hook).toContain("driveRelativePathFor");
    expect(hook).not.toMatch(/name:\s*file\.actualFileName \|\| file\.name/);
  });

  it("uses the resolved path for a remote rename too", () => {
    expect(hook).toMatch(/const relative = relativePath\.replace/);
  });

  // The path only exists on the row if the listing puts it there.
  it("the nested listing tags folder rows with their parent", () => {
    const listing = readCode("../../use-nested-folder-listing.ts");
    expect(listing).toMatch(/parentRelativePath: entry\.is_folder \?/);
  });

  // One resolver for the same question, so a rename and a share cannot
  // disagree about which folder a row means.
  it("shares one resolver with the folder share", () => {
    expect(readCode("../../../utils/folderShareGating.ts")).toContain(
      "driveRelativePathFor",
    );
  });
});
